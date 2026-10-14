import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { SqliteCatalogCache } from "../src/catalog-cache.js";
import { AppleCatalogService, normalizeCatalogRequest } from "../src/apple-catalog.js";

function database() {
  const db = new DatabaseSync(":memory:");
  return { db, sql: { exec(query, ...bindings) {
    const rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } };
}

const publicSong = { id: "123", type: "songs", attributes: {
  name: "Song", artistName: "Artist", durationInMillis: 180000, isrc: "USAAA2400001"
} };
const query = (term, storefront = "cn") => ({ action: "search", term, storefront, limit: 25 });
const key = term => JSON.stringify(normalizeCatalogRequest(query(term)));

test("persistent catalog entries survive service recreation without an Apple request", async () => {
  const { db, sql } = database();
  try {
    let calls = 0;
    const options = { now: () => 1000, sleep: async () => {}, fetcher: async () => {
      calls += 1;
      return Response.json({ results: { songs: { data: [{ ...publicSong,
        musicUserToken: "private-token", attributes: { ...publicSong.attributes, owner: "private-owner" }
      }] } } });
    } };
    const first = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake-secret" }, {
      ...options, persistentCache: new SqliteCatalogCache(sql)
    });
    assert.equal((await first.request(query("Song"))).cacheHit, false);
    const second = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake-secret" }, {
      ...options, persistentCache: new SqliteCatalogCache(sql)
    });
    const result = await second.request({ ...query("Song"), clientId: "private-client", musicUserToken: "private-token" }, { diagnostics: true });
    assert.equal(result.cacheHit, true);
    assert.equal(result.cacheSource, "persistent");
    assert.equal(result.diagnostics.upstreamMs, 0);
    assert.equal(result.diagnostics.persistentCacheEntries, 1);
    assert.deepEqual(result.data, [publicSong]);
    assert.equal(calls, 1);
    const stored = JSON.stringify(db.prepare("SELECT * FROM m2m_catalog_cache_v1").all());
    assert.doesNotMatch(stored, /fake-secret|private-token|private-client|private-owner|\"term\"/);
  } finally { db.close(); }
});

test("persistent cache expires positive and empty entries and keeps regions and limits distinct", async () => {
  const { db, sql } = database();
  try {
    const cache = new SqliteCatalogCache(sql);
    await cache.put(key("Song"), [publicSong], 21600000, 0);
    await cache.put(key("Empty"), [], 300000, 0);
    assert.deepEqual(await cache.get(key("Song"), 21599999), { data: [publicSong], expiresAt: 21600000 });
    assert.deepEqual(await cache.get(key("Empty"), 299999), { data: [], expiresAt: 300000 });
    assert.equal(await cache.get(key("Empty"), 300000), null);
    assert.equal(await cache.get(JSON.stringify(query("Song", "us")), 1000), null);
    assert.equal(await cache.get(JSON.stringify({ ...query("Song"), limit: 1 }), 1000), null);
    assert.equal(await cache.get(key("Song"), 21600000), null);
    assert.equal(cache.stats().entries, 0);
    assert.equal(cache.stats().bytes, 0);
  } finally { db.close(); }
});

test("persistent cache has entry and serialized-byte bounds, without updating every cache hit", async () => {
  const { db, sql } = database();
  try {
    const cache = new SqliteCatalogCache(sql, { maxEntries: 3, maxBytes: 4096 });
    for (let index = 0; index < 10; index += 1) {
      await cache.put(key("Song " + index), [publicSong], 21600000, index);
      assert.ok(cache.stats().entries <= 3);
      assert.ok(cache.stats().bytes <= 4096);
    }
    assert.equal(await cache.get(key("Song 0"), 10), null);
    assert.deepEqual(await cache.get(key("Song 9"), 10), { data: [publicSong], expiresAt: 21600000 });
    const before = db.prepare("SELECT updated_at FROM m2m_catalog_cache_v1").all();
    await cache.get(key("Song 9"), 200);
    assert.deepEqual(db.prepare("SELECT updated_at FROM m2m_catalog_cache_v1").all(), before);
    const byteBound = new SqliteCatalogCache(sql, { maxEntries: 3, maxBytes: 400 });
    await byteBound.put(key("New"), [publicSong], 21600000, 300);
    assert.ok(byteBound.stats().bytes <= 400);
    await byteBound.put(key("Oversized"), [{ ...publicSong, attributes: { name: "a".repeat(1000) } }], 21600000, 400);
    assert.equal(await byteBound.get(key("Oversized"), 401), null);
    assert.ok(byteBound.stats().bytes <= 400);
  } finally { db.close(); }
});

test("persistent cache recovers from corrupt payloads and falls back on storage failures", async () => {
  const { db, sql } = database();
  try {
    const cache = new SqliteCatalogCache(sql);
    await cache.put(key("Song"), [publicSong], 21600000, 0);
    db.prepare("UPDATE m2m_catalog_cache_v1 SET payload = ?").run("not-json");
    assert.equal(await cache.get(key("Song"), 1), null);
    assert.equal(cache.stats().entries, 0);
    const broken = new SqliteCatalogCache({ exec() { throw new Error("private-storage-error"); } });
    assert.equal(await broken.get(key("Song"), 1), null);
    await broken.put(key("Song"), [publicSong], 21600000, 1);
    assert.ok(broken.stats().errors >= 1);
    assert.doesNotMatch(JSON.stringify(broken.stats()), /private-storage-error/);
  } finally { db.close(); }
});

test("valid JSON with invalid song records is invalidated instead of becoming a false empty hit", async () => {
  const { db, sql } = database();
  try {
    const cache = new SqliteCatalogCache(sql);
    for (const payload of ["[null]", '[{"type":"songs","attributes":{}}]', '[{"id":"bad","type":"songs","attributes":null}]']) {
      await cache.put(key("Song"), [publicSong], 21600000, 0);
      db.prepare("UPDATE m2m_catalog_cache_v1 SET payload = ?").run(payload);
      assert.equal(await cache.get(key("Song"), 1), null);
      assert.equal(cache.stats().entries, 0);
      assert.equal(cache.stats().bytes, 0);
    }
    assert.equal(cache.stats().errors, 3);
  } finally { db.close(); }
});

test("a recovered SQLite store can be retried after a bounded failure cooldown", async () => {
  const { db, sql } = database();
  try {
    let broken = false;
    const cache = new SqliteCatalogCache({ exec(...args) {
      if (broken) throw new Error("temporarily-unavailable");
      return sql.exec(...args);
    } });
    await cache.put(key("Song"), [publicSong], 21600000, 0);
    broken = true;
    assert.equal(await cache.get(key("Song"), 100), null);
    broken = false;
    assert.equal(await cache.get(key("Song"), 101), null);
    assert.deepEqual(await cache.get(key("Song"), 60100), { data: [publicSong], expiresAt: 21600000 });
    assert.equal(cache.stats().entries, 1);
    assert.equal(cache.stats().errors, 1);
  } finally { db.close(); }
});

test("persistent hits do not extend the remaining lifetime when loaded into memory", async () => {
  const { db, sql } = database();
  try {
    let timestamp = 0;
    let calls = 0;
    const cache = new SqliteCatalogCache(sql);
    await cache.put(key("Song"), [publicSong], 1000, 0);
    const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake" }, {
      persistentCache: cache, now: () => timestamp, sleep: async delay => { timestamp += delay; },
      fetcher: async () => { calls += 1; return Response.json({ results: { songs: { data: [publicSong] } } }); }
    });
    timestamp = 999;
    assert.equal((await service.request(query("Song"))).cacheHit, true);
    timestamp = 1000;
    assert.equal((await service.request(query("Song"))).cacheHit, false);
    assert.equal(calls, 1);
  } finally { db.close(); }
});

test("staggered persistent misses stay deduplicated even after the first upstream call finishes", async () => {
  let readCount = 0;
  let releaseSecond;
  const secondRead = new Promise(resolve => { releaseSecond = resolve; });
  let calls = 0;
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake" }, {
    persistentCache: { get: async () => { readCount += 1; return readCount === 1 ? null : secondRead; },
      put: async () => {}, stats: () => ({ entries: 0, bytes: 0, errors: 0 }) },
    fetcher: async () => { calls += 1; return Response.json({ results: { songs: { data: [publicSong] } } }); }
  });
  const first = service.request(query("Song"));
  const second = service.request(query("Song"));
  await first;
  releaseSecond(null);
  await second;
  assert.equal(calls, 1);
  assert.equal(readCount, 1);
});

test("slow cache lookups are admitted to the same pending bound as upstream work", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  let reads = 0;
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake" }, {
    persistentCache: { get: async () => { reads += 1; return gate; }, put: async () => {},
      stats: () => ({ entries: 0, bytes: 0, errors: 0 }) },
    now: () => 0, sleep: async () => {}, fetcher: async () => Response.json({ results: { songs: { data: [publicSong] } } })
  });
  const pending = Array.from({ length: 40 }, (_, index) => service.request(query("slow " + index)));
  const rejected = assert.rejects(service.request(query("overflow")), error => error.code === "apple_queue_full");
  resolve({ data: [publicSong], expiresAt: 1000 });
  await Promise.all(pending);
  await rejected;
  assert.equal(reads, 40);
});

test("cancelled or older writes cannot replace a newer persistent recording result", async () => {
  const { db, sql } = database();
  try {
    const cache = new SqliteCatalogCache(sql);
    const newer = [{ ...publicSong, id: "newer" }];
    await cache.put(key("Song"), newer, 21600000, 100);
    await cache.put(key("Song"), [publicSong], 21600000, 50);
    assert.deepEqual((await cache.get(key("Song"), 101)).data, newer);
    const controller = new AbortController();
    const cancelled = cache.put(key("Song"), [publicSong], 21600000, 200, { signal: controller.signal });
    controller.abort();
    await cancelled;
    assert.deepEqual((await cache.get(key("Song"), 201)).data, newer);
    assert.equal(cache.stats().entries, 1);
    assert.equal(cache.stats().bytes, new TextEncoder().encode(JSON.stringify(newer)).byteLength);
  } finally { db.close(); }
});

test("cache read and write deadlines fail open, fence late mutations, and release pending work", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let timestamp = 0;
  let readSignal;
  let writeSignal;
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake" }, {
    now: () => timestamp,
    persistentCache: { get: async (_key, _now, options) => {
      readSignal = options?.signal;
      return new Promise(() => {});
    }, put: async (_key, _data, _expiresAt, _now, options) => {
      writeSignal = options?.signal;
      return new Promise(() => {});
    }, stats: () => ({ entries: 0, bytes: 0, errors: 0 }) },
    fetcher: async () => Response.json({ results: { songs: { data: [publicSong] } } })
  });
  const pending = service.request(query("Song"), { diagnostics: true });
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
  timestamp = 1000;
  context.mock.timers.tick(1000);
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
  timestamp = 2000;
  context.mock.timers.tick(1000);
  const result = await pending;
  assert.ok(readSignal?.aborted);
  assert.ok(writeSignal?.aborted);
  assert.equal(result.cacheHit, false);
  assert.deepEqual(result.data, [publicSong]);
  assert.equal(result.diagnostics.cacheReadMs, 1000);
  assert.equal(result.diagnostics.cacheWriteMs, 1000);
  assert.equal(result.diagnostics.persistentCacheErrors, 2);
  assert.equal(service.inFlight.size, 0);
  assert.equal((await service.request(query("Song"))).cacheHit, true);
});

test("a repeated 1000-query playlist uses persistent results beyond the 500-entry memory cache", async (context) => {
  const { db, sql } = database();
  try {
    let timestamp = 0;
    let calls = 0;
    const options = { now: () => timestamp, sleep: async delay => { timestamp += delay; }, fetcher: async () => {
      calls += 1;
      return Response.json({ results: { songs: { data: [publicSong] } } });
    } };
    const env = { APPLE_DEVELOPER_TOKEN: "fake" };
    const first = new AppleCatalogService(env, { ...options, persistentCache: new SqliteCatalogCache(sql) });
    for (let index = 0; index < 1000; index += 1) await first.request(query("Playlist " + index));
    assert.equal(calls, 1000);
    const restarted = new AppleCatalogService(env, { ...options, persistentCache: new SqliteCatalogCache(sql) });
    for (let index = 0; index < 1000; index += 1) {
      const result = await restarted.request(query("Playlist " + index), { diagnostics: true });
      assert.equal(result.cacheHit, true);
      assert.equal(result.cacheSource, "persistent");
    }
    assert.equal(calls, 1000);
    assert.ok(restarted.cache.size <= 500);
    context.diagnostic("1000 unique catalog queries: cold pass = 1000 upstream calls; service restart and replay = 0 additional calls");
  } finally { db.close(); }
});

test("persistent cache failures and concurrent misses cannot duplicate upstream requests or cache errors", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  let calls = 0;
  let writes = 0;
  const options = { persistentCache: { get: async () => null, put: async () => { writes += 1; },
    stats: () => ({ entries: 0, bytes: 0, errors: 0 }) }, fetcher: async () => {
    calls += 1;
    await gate;
    return Response.json({ results: { songs: { data: [publicSong] } } });
  } };
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake" }, options);
  const operations = Array.from({ length: 12 }, () => service.request(query("Song")));
  resolve();
  await Promise.all(operations);
  assert.equal(calls, 1);
  assert.equal(writes, 1);
  const failed = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake" }, {
    ...options, fetcher: async () => new Response(null, { status: 503 })
  });
  await assert.rejects(failed.request(query("Failure")), error => error.status === 503);
  assert.equal(writes, 1);
});
