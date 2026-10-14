const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024;

export class SqliteCatalogCache {
  constructor(sql, options = {}) {
    this.sql = sql;
    this.maxEntries = bounded(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxBytes = bounded(options.maxBytes, DEFAULT_MAX_BYTES);
    this.entries = 0;
    this.bytes = 0;
    this.errors = 0;
    this.retryAt = 0;
    this.available = false;
    this.lastCleanupAt = -Infinity;
    this.initialize(Date.now());
  }

  initialize(now) {
    try {
      this.sql.exec("CREATE TABLE IF NOT EXISTS m2m_catalog_cache_v1 (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, bytes INTEGER NOT NULL)");
      this.sql.exec("CREATE INDEX IF NOT EXISTS m2m_catalog_cache_expiry ON m2m_catalog_cache_v1(expires_at)");
      this.sql.exec("CREATE INDEX IF NOT EXISTS m2m_catalog_cache_age ON m2m_catalog_cache_v1(updated_at)");
      const totals = this.sql.exec("SELECT COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM m2m_catalog_cache_v1").toArray()[0];
      this.entries = totals.entries;
      this.bytes = totals.bytes;
      this.trim();
      this.available = true;
    } catch {
      this.disable(now);
    }
  }

  ready(now) {
    if (!this.available && now >= this.retryAt) this.initialize(now);
    return this.available;
  }

  async get(key, now, options = {}) {
    if (options.signal?.aborted) return null;
    if (!this.ready(now)) return null;
    try {
      const digest = await cacheDigest(key);
      if (options.signal?.aborted) return null;
      const row = this.sql.exec("SELECT payload, expires_at, bytes FROM m2m_catalog_cache_v1 WHERE cache_key = ?", digest).toArray()[0];
      if (!row) return null;
      let data;
      try { data = JSON.parse(row.payload); } catch { this.errors += 1; }
      const valid = Array.isArray(data) && data.every(song => song && typeof song.id === "string" && song.id &&
        song.type === "songs" && song.attributes && typeof song.attributes === "object" && !Array.isArray(song.attributes));
      if (data !== undefined && !valid) this.errors += 1;
      if (row.expires_at <= now || !valid) {
        this.sql.exec("DELETE FROM m2m_catalog_cache_v1 WHERE cache_key = ?", digest);
        this.entries = Math.max(0, this.entries - 1);
        this.bytes = Math.max(0, this.bytes - row.bytes);
        return null;
      }
      return { data, expiresAt: row.expires_at };
    } catch {
      this.disable(now);
      return null;
    }
  }

  async put(key, data, expiresAt, now, options = {}) {
    if (options.signal?.aborted) return;
    if (!this.ready(now) || !Array.isArray(data) || !Number.isFinite(expiresAt) || expiresAt <= now) return;
    try {
      const payload = JSON.stringify(data);
      const size = new TextEncoder().encode(payload).byteLength;
      if (size > Math.min(this.maxBytes, MAX_ENTRY_BYTES)) return;
      const digest = await cacheDigest(key);
      if (options.signal?.aborted) return;
      if (now - this.lastCleanupAt >= 60000) {
        this.subtract(this.sql.exec("DELETE FROM m2m_catalog_cache_v1 WHERE expires_at <= ? RETURNING bytes", now).toArray());
        this.lastCleanupAt = now;
      }
      const previous = this.sql.exec("SELECT bytes FROM m2m_catalog_cache_v1 WHERE cache_key = ?", digest).toArray()[0];
      const updated = this.sql.exec("INSERT INTO m2m_catalog_cache_v1 (cache_key, payload, expires_at, updated_at, bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at, bytes = excluded.bytes WHERE excluded.updated_at >= m2m_catalog_cache_v1.updated_at RETURNING bytes",
        digest, payload, expiresAt, now, size).toArray()[0];
      if (!updated) return;
      this.entries += previous ? 0 : 1;
      this.bytes += size - (previous?.bytes || 0);
      this.trim();
    } catch {
      this.disable(now);
    }
  }

  trim() {
    while (this.entries > this.maxEntries || this.bytes > this.maxBytes) {
      const count = Math.min(32, Math.max(1, this.entries - this.maxEntries));
      const removed = this.sql.exec("DELETE FROM m2m_catalog_cache_v1 WHERE cache_key IN (SELECT cache_key FROM m2m_catalog_cache_v1 ORDER BY updated_at, cache_key LIMIT ?) RETURNING bytes", count).toArray();
      if (!removed.length) break;
      this.subtract(removed);
    }
  }

  subtract(rows) {
    this.entries = Math.max(0, this.entries - rows.length);
    this.bytes = Math.max(0, this.bytes - rows.reduce((total, row) => total + row.bytes, 0));
  }

  disable(now) {
    this.errors += 1;
    this.available = false;
    this.retryAt = now + 60000;
  }

  stats() {
    return { entries: this.entries, bytes: this.bytes, errors: this.errors };
  }
}

function bounded(value, fallback) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

async function cacheDigest(key) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
