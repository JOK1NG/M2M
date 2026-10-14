import { AppleError, createAppleDeveloperToken } from "./apple.js";

const CACHE_LIMIT = 500;
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const PENDING_LIMIT = 40;
const REQUEST_TIMEOUT_MS = 12000;
const STRING_ATTRIBUTES = ["name", "artistName", "albumName", "isrc", "contentRating", "url"];

export function normalizeCatalogRequest(payload) {
  if (!isRecord(payload) || !["search", "isrc"].includes(payload.action)) {
    throw invalidRequest();
  }

  const storefront = payload.storefront === undefined ? "cn" : payload.storefront;
  if (typeof storefront !== "string" || !/^[a-z]{2}$/.test(storefront.trim().toLowerCase())) {
    throw invalidRequest();
  }
  const normalized = { action: payload.action, storefront: storefront.trim().toLowerCase() };

  if (payload.action === "search") {
    if (typeof payload.term !== "string") throw invalidRequest();
    const term = payload.term.normalize("NFKC").trim();
    const limit = payload.limit === undefined ? 25 : payload.limit;
    if (!term || term.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw invalidRequest();
    }
    return { ...normalized, term, limit };
  }

  if (!Array.isArray(payload.isrcs) || payload.isrcs.length < 1 || payload.isrcs.length > 25) {
    throw invalidRequest();
  }
  const isrcs = [];
  for (const value of payload.isrcs) {
    if (typeof value !== "string") throw invalidRequest();
    const isrc = value.normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc)) throw invalidRequest();
    isrcs.push(isrc);
  }
  return { ...normalized, isrcs: [...new Set(isrcs)].sort() };
}

export class AppleCatalogService {
  constructor(env = {}, options = {}) {
    this.env = env;
    this.fetcher = options.fetcher || fetch.bind(globalThis);
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, Math.min(milliseconds, 2147483647));
    }));
    const configuredInterval = env?.APPLE_SEARCH_INTERVAL_MS;
    const interval = configuredInterval === undefined || configuredInterval === ""
      ? 250 : Number(configuredInterval);
    this.baseInterval = Number.isFinite(interval) ? Math.max(100, Math.min(5000, Math.floor(interval))) : 250;
    const configuredConcurrency = env?.APPLE_SEARCH_CONCURRENCY;
    const concurrency = typeof configuredConcurrency === "number"
      || (typeof configuredConcurrency === "string" && configuredConcurrency.trim())
      ? Number(configuredConcurrency) : NaN;
    this.concurrency = Number.isInteger(concurrency) ? Math.max(1, Math.min(6, concurrency)) : 4;
    this.interval = this.baseInterval;
    this.lastStartedAt = -Infinity;
    this.cooldownUntil = 0;
    this.rateLimitEvents = 0;
    this.recoveryStreak = 0;
    this.active = 0;
    this.draining = false;
    this.queue = [];
    this.inFlight = new Map();
    this.cache = new Map();
    this.token = null;
    this.tokenPromise = null;
  }

  async request(payload, options = {}) {
    const startedAt = this.now();
    const includeDiagnostics = options?.diagnostics === true;
    const normalized = normalizeCatalogRequest(payload);
    const key = JSON.stringify(normalized);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      if (cached.expiresAt > this.now()) {
        this.cache.set(key, cached);
        return this.requestResult(cached.data, true, startedAt, includeDiagnostics);
      }
    }

    let operation = this.inFlight.get(key);
    if (!operation) {
      if (this.inFlight.size >= PENDING_LIMIT) {
        throw new AppleError(429, "apple_queue_full", "Apple Music catalog queue is full.", { retryAfterMs: 2000 });
      }
      let resolve;
      let reject;
      const pending = new Promise((accept, fail) => { resolve = accept; reject = fail; });
      operation = pending.then((data) => {
        this.cache.delete(key);
        this.cache.set(key, {
          data,
          expiresAt: this.now() + (data.length ? POSITIVE_TTL_MS : EMPTY_TTL_MS)
        });
        if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
        return data;
      }).finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, operation);
      this.queue.push({ normalized, resolve, reject });
      this.drain();
    }
    return this.requestResult(await operation, false, startedAt, includeDiagnostics);
  }

  requestResult(data, cacheHit, startedAt, includeDiagnostics) {
    const result = { data: structuredClone(data), cacheHit };
    if (includeDiagnostics) {
      const now = this.now();
      result.diagnostics = {
        elapsedMs: Math.max(0, now - startedAt),
        intervalMs: this.interval,
        queueDepth: this.queue.length,
        activeRequests: this.active,
        cooldownMs: Math.max(0, this.cooldownUntil - now),
        rateLimitEvents: this.rateLimitEvents
      };
    }
    return result;
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && this.active < this.concurrency) {
        const waitMs = Math.max(this.cooldownUntil, this.lastStartedAt + this.interval) - this.now();
        if (waitMs > 0) {
          await this.sleep(waitMs);
          continue;
        }

        const job = this.queue[0];
        let developerToken;
        try {
          developerToken = await this.getDeveloperToken();
        } catch (error) {
          this.recoveryStreak = 0;
          this.queue.shift();
          job.reject(error);
          continue;
        }
        if (this.now() < Math.max(this.cooldownUntil, this.lastStartedAt + this.interval)) continue;

        this.queue.shift();
        const jobs = [job];
        let normalized = job.normalized;
        if (normalized.action === "isrc") {
          let isrcs = new Set(normalized.isrcs);
          for (let index = 0; index < this.queue.length; index += 1) {
            const candidate = this.queue[index];
            if (candidate.normalized.action !== "isrc" || candidate.normalized.storefront !== normalized.storefront) continue;
            const combined = new Set([...isrcs, ...candidate.normalized.isrcs]);
            if (combined.size > 25) continue;
            isrcs = combined;
            jobs.push(candidate);
            this.queue.splice(index, 1);
            index -= 1;
          }
          normalized = { ...normalized, isrcs: [...isrcs].sort() };
        }
        this.active += 1;
        this.send(normalized, developerToken).then((data) => {
          for (const sibling of jobs) {
            sibling.resolve(normalized.action === "isrc"
              ? data.filter((item) => sibling.normalized.isrcs.includes(item.attributes.isrc)) : data);
          }
        }, (error) => {
          for (const sibling of jobs) sibling.reject(error);
        }).finally(() => {
          this.active -= 1;
          this.drain();
        });
      }
    } catch {
      for (const job of this.queue.splice(0)) job.reject(unavailable());
    } finally {
      this.draining = false;
    }
  }

  async getDeveloperToken() {
    if (this.token && (!Number.isFinite(this.token.expiresAt) || this.token.expiresAt * 1000 - this.now() > 60000)) {
      return this.token.developerToken;
    }
    if (!this.tokenPromise) {
      this.tokenPromise = (async () => {
        try {
          this.token = await createAppleDeveloperToken(this.env, Math.floor(this.now() / 1000));
          return this.token.developerToken;
        } catch (error) {
          this.token = null;
          if (error instanceof AppleError && error.code === "apple_credentials_missing") throw error;
          throw unavailable();
        } finally {
          this.tokenPromise = null;
        }
      })();
    }
    return this.tokenPromise;
  }

  async send(normalized, developerToken) {
    const epoch = this.rateLimitEvents;
    const startedAt = this.now();
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(unavailable());
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      const data = await Promise.race([
        this.fetchSongs(normalized, developerToken, controller.signal), deadline
      ]);
      if (epoch === this.rateLimitEvents && startedAt >= this.cooldownUntil && this.interval > this.baseInterval) {
        this.recoveryStreak += 1;
        if (this.recoveryStreak >= 4) {
          this.interval = Math.max(this.baseInterval, Math.ceil(this.interval * 0.8));
          this.recoveryStreak = 0;
        }
      }
      return data;
    } catch (error) {
      if (epoch === this.rateLimitEvents) this.recoveryStreak = 0;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchSongs(normalized, developerToken, signal) {
    const params = normalized.action === "search"
      ? new URLSearchParams({ term: normalized.term, types: "songs", limit: String(normalized.limit) })
      : new URLSearchParams({ "filter[isrc]": normalized.isrcs.join(",") });
    const resource = normalized.action === "search" ? "search" : "songs";
    const url = `https://api.music.apple.com/v1/catalog/${normalized.storefront}/${resource}?${params}`;
    let response;
    try {
      this.lastStartedAt = this.now();
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "manual",
        headers: { Authorization: `Bearer ${developerToken}`, Accept: "application/json" },
        signal
      });
    } catch {
      throw unavailable();
    }
    if (signal.aborted || !response) throw unavailable();

    if (response.status === 429) {
      const now = this.now();
      const retryAfterMs = parseRetryAfter(response.headers?.get("Retry-After"), now);
      this.rateLimitEvents += 1;
      this.recoveryStreak = 0;
      this.cooldownUntil = Math.max(this.cooldownUntil, now + retryAfterMs);
      this.interval = Math.max(this.baseInterval, Math.min(3000, this.interval * 2));
      throw new AppleError(429, "apple_rate_limited", "Apple Music catalog is temporarily rate limited.", {
        retryAfterMs: Math.max(0, this.cooldownUntil - now)
      });
    }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw new AppleError(response.status, "apple_search_failed", "Apple Music catalog request was rejected.");
      }
      throw unavailable();
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw unavailable();
    }
    if (signal.aborted || !isRecord(payload)) throw unavailable();
    let data;
    if (normalized.action === "search") {
      if (!isRecord(payload.results)) throw unavailable();
      const songs = payload.results.songs;
      data = songs === undefined ? [] : songs?.data;
    } else {
      data = payload.data;
    }
    if (!Array.isArray(data)) throw unavailable();
    return publicSongs(data);
  }
}

function publicSongs(data) {
  return data.filter((item) => isRecord(item) && item.type === "songs" && typeof item.id === "string" && item.id)
    .map((item) => {
      const song = { id: item.id, type: "songs", attributes: {} };
      if (typeof item.href === "string") song.href = item.href;
      const attributes = isRecord(item.attributes) ? item.attributes : {};
      for (const field of STRING_ATTRIBUTES) {
        if (typeof attributes[field] === "string") song.attributes[field] = attributes[field];
      }
      if (Number.isFinite(attributes.durationInMillis) && attributes.durationInMillis >= 0) {
        song.attributes.durationInMillis = attributes.durationInMillis;
      }
      if (typeof attributes.hasLyrics === "boolean") song.attributes.hasLyrics = attributes.hasLyrics;
      if (isRecord(attributes.playParams)) {
        song.attributes.playParams = {};
        for (const field of ["id", "kind"]) {
          if (typeof attributes.playParams[field] === "string") {
            song.attributes.playParams[field] = attributes.playParams[field];
          }
        }
      }
      return song;
    });
}

function parseRetryAfter(value, now) {
  if (typeof value !== "string" || !value.trim()) return 3000;
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const milliseconds = Number(normalized) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : 3000;
  }
  const timestamp = /^[a-z]/i.test(normalized) ? Date.parse(normalized) : NaN;
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 3000;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest() {
  return new AppleError(400, "invalid_apple_catalog_request", "Invalid Apple Music catalog request.");
}

function unavailable() {
  return new AppleError(503, "apple_search_unavailable", "Apple Music catalog is temporarily unavailable.");
}
