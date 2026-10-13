import assert from "node:assert/strict";
import test from "node:test";

import { AppleError } from "../src/apple.js";

test("preserves the native global fetch receiver required by Workers", async (context) => {
  const { AppleCatalogService } = await import("../src/apple-catalog.js");
  context.mock.method(globalThis, "fetch", function () {
    assert.equal(this, globalThis);
    return Promise.resolve(Response.json({ results: { songs: { data: [] } } }));
  });
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake-test-token" });
  const result = await service.request({ action: "search", storefront: "cn", term: "Song" });
  assert.deepEqual(result.data, []);
});

test("uses manual redirects supported by Workers and never forwards authorization to a redirect target", async () => {
  const { AppleCatalogService } = await import("../src/apple-catalog.js");
  let attempts = 0;
  let redirect;
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake-test-token" }, {
    fetcher: async (_url, options) => {
      attempts += 1;
      redirect = options.redirect;
      return new Response(null, { status: 302, headers: { Location: "https://untrusted.example/" } });
    }
  });
  await assert.rejects(service.request({ action: "search", storefront: "cn", term: "Song" }),
    error => error.code === "apple_search_unavailable");
  assert.equal(attempts, 1);
  assert.equal(redirect, "manual");
});

const song = {
  id: "123",
  type: "songs",
  href: "/v1/catalog/cn/songs/123",
  attributes: {
    name: "Song",
    artistName: "Artist",
    albumName: "Album",
    durationInMillis: 180000,
    isrc: "USAAA2400001",
    contentRating: "clean",
    url: "https://music.apple.com/cn/song/123",
    hasLyrics: true,
    playParams: { id: "123", kind: "song" }
  }
};

function response(data = [song], status = 200, headers = {}, action = "search") {
  const body = action === "search" ? { results: { songs: { data } } } : { data };
  return new Response(JSON.stringify(body), { status, headers });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) {
    await Promise.resolve();
  }
}

function clock(start = 0, automatic = false) {
  let timestamp = start;
  const sleepers = [];
  return {
    now: () => timestamp,
    sleep: (milliseconds) => {
      if (automatic) {
        timestamp += milliseconds;
        return Promise.resolve();
      }
      return new Promise((resolve) => sleepers.push({ at: timestamp + milliseconds, resolve }));
    },
    async advance(milliseconds) {
      timestamp += milliseconds;
      await flush();
      while (sleepers.some((entry) => entry.at <= timestamp)) {
        for (let index = sleepers.length - 1; index >= 0; index -= 1) {
          if (sleepers[index].at <= timestamp) {
            sleepers.splice(index, 1)[0].resolve();
          }
        }
        await flush();
      }
    }
  };
}

function search(term = "Song", extra = {}) {
  return { action: "search", term, ...extra };
}

function appleError(status, code, details) {
  return (error) => {
    assert.ok(error instanceof AppleError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (details) assert.deepEqual(error.details, details);
    return true;
  };
}

test("Apple catalog coordination", async (suite) => {
  let catalog;
  try {
    catalog = await import("../src/apple-catalog.js");
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  assert.ok(catalog, "The Apple catalog coordination module must exist");
  const { normalizeCatalogRequest, AppleCatalogService } = catalog;

  function service(fetcher, time = clock(0, true), env = {}) {
    return new AppleCatalogService(
      { APPLE_DEVELOPER_TOKEN: "fake", ...env },
      { fetcher, now: time.now, sleep: time.sleep }
    );
  }

  await suite.test("normalizes search without losing distinct terms", () => {
    assert.deepEqual(normalizeCatalogRequest(search("  \uFF21\uFF22\uFF23  ")), {
      action: "search", storefront: "cn", term: "ABC", limit: 25
    });
    for (const term of ["Song", "song", "Song!", "Song  Artist", "Song Artist"]) {
      assert.equal(normalizeCatalogRequest(search(term)).term, term);
    }
    assert.equal(normalizeCatalogRequest(search("a".repeat(256))).term.length, 256);
    assert.equal(normalizeCatalogRequest(search("Song", { storefront: " US " })).storefront, "us");
  });

  await suite.test("rejects invalid payloads, actions and storefronts", () => {
    const invalid = [null, [], "Song", 2, true, {}, { action: "library" },
      search(""), search("  "), search(null), search(123), search("a".repeat(257)),
      search("Song", { storefront: null }), search("Song", { storefront: "china" }),
      search("Song", { storefront: "../us" }), search("Song", { storefront: "12" })];
    for (const payload of invalid) {
      assert.throws(() => normalizeCatalogRequest(payload), (error) => {
        assert.ok(error instanceof AppleError);
        assert.equal(error.status, 400);
        assert.doesNotMatch(JSON.stringify(error), /personal-secret|example\.com/);
        return true;
      });
    }
  });

  await suite.test("strips arbitrary URLs and user credentials from normalized requests", () => {
    assert.deepEqual(normalizeCatalogRequest(search("Song", {
      url: "https://example.com/private", musicUserToken: "personal-secret", userToken: "personal-secret",
      headers: { Authorization: "personal-secret" }
    })), { action: "search", storefront: "cn", term: "Song", limit: 25 });
  });

  await suite.test("requires strict integer limits between one and 25", () => {
    for (const limit of [0, 26, -1, 1.5, "25", "2junk", null, true, NaN, Infinity]) {
      assert.throws(() => normalizeCatalogRequest(search("Song", { limit })), appleError(400, "invalid_apple_catalog_request"));
    }
    for (const limit of [1, 25]) {
      assert.equal(normalizeCatalogRequest(search("Song", { limit })).limit, limit);
    }
  });

  await suite.test("canonicalizes ISRCs and rejects invalid lists", () => {
    assert.deepEqual(normalizeCatalogRequest({
      action: "isrc", isrcs: [" us-aaa-24-00002 ", "USAAA2400001", "usaaa2400001"]
    }), { action: "isrc", storefront: "cn", isrcs: ["USAAA2400001", "USAAA2400002"] });
    for (const isrcs of [null, [], "USAAA2400001", [null], [123], ["USAAA240001"],
      ["1SAAA2400001"], ["USAAA2X00001"], ["USAAA2400001&"], Array(26).fill("USAAA2400001")]) {
      assert.throws(() => normalizeCatalogRequest({ action: "isrc", isrcs }), appleError(400, "invalid_apple_catalog_request"));
    }
  });

  await suite.test("encodes search parameters and sends only the site developer token", async () => {
    let calls = 0;
    const catalogService = service(async (input, options) => {
      calls += 1;
      const url = new URL(input);
      assert.equal(url.origin, "https://api.music.apple.com");
      assert.equal(url.pathname, "/v1/catalog/cn/search");
      assert.equal(url.searchParams.get("term"), "A & B? / # +");
      assert.equal(url.searchParams.get("types"), "songs");
      assert.equal(url.searchParams.get("limit"), "7");
      assert.deepEqual([...url.searchParams.keys()].sort(), ["limit", "term", "types"]);
      const headers = new Headers(options.headers);
      assert.equal(headers.get("Authorization"), "Bearer fake");
      assert.equal(headers.has("Music-User-Token"), false);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "manual");
      assert.ok(options.signal instanceof AbortSignal);
      return response();
    }, clock(0, true), { MUSIC_USER_TOKEN: "personal-secret" });
    assert.deepEqual(await catalogService.request(search("A & B? / # +", { limit: 7 })), { data: [song], cacheHit: false });
    await assert.rejects(catalogService.request(search("", { userToken: "secret" })), appleError(400, "invalid_apple_catalog_request"));
    assert.equal(calls, 1);
  });

  await suite.test("ISRC lookup uses the requested catalog region", async () => {
    const catalogService = service(async (input) => {
      const url = new URL(input);
      assert.equal(url.pathname, "/v1/catalog/us/songs");
      assert.equal(url.searchParams.get("filter[isrc]"), "USAAA2400001,USAAA2400002");
      assert.equal([...url.searchParams.keys()].length, 1);
      return response([song], 200, {}, "isrc");
    });
    assert.deepEqual(await catalogService.request({ action: "isrc", storefront: "us", isrcs: ["USAAA2400002", "USAAA2400001"] }), { data: [song], cacheHit: false });
  });

  await suite.test("keeps only public song fields and isolates cached data from mutation", async () => {
    const rawSong = {
      ...song, user: { token: "private" }, relationships: { library: "private" },
      attributes: { ...song.attributes, personalNote: "private", artwork: { url: "private" },
        playParams: { ...song.attributes.playParams, userToken: "private", isLibrary: true } }
    };
    const catalogService = service(async () => response([rawSong, { id: "private", type: "library-songs" }, null]));
    const first = await catalogService.request(search());
    assert.deepEqual(first, { data: [song], cacheHit: false });
    first.data[0].attributes.name = "Changed";
    first.data[0].attributes.playParams.id = "Changed";
    first.data.push({ id: "private" });
    assert.deepEqual(await catalogService.request(search()), { data: [song], cacheHit: true });
  });

  await suite.test("deduplicates identical in-flight requests and canonical ISRC lists", async () => {
    const gate = deferred();
    let calls = 0;
    const catalogService = service(async () => {
      calls += 1;
      await gate.promise;
      return response([song], 200, {}, "isrc");
    });
    const first = catalogService.request({ action: "isrc", isrcs: ["USAAA2400002", "USAAA2400001"] });
    const second = catalogService.request({ action: "isrc", storefront: "cn", isrcs: ["usaaa2400001", "USAAA2400002", "USAAA2400001"] });
    await flush();
    assert.equal(calls, 1);
    gate.resolve();
    assert.deepEqual(await first, { data: [song], cacheHit: false });
    assert.deepEqual(await second, { data: [song], cacheHit: false });
    assert.equal((await catalogService.request({ action: "isrc", isrcs: ["USAAA2400001", "USAAA2400002"] })).cacheHit, true);
  });

  await suite.test("does not conflate case, punctuation, spacing, limits or regions in the cache", async () => {
    let calls = 0;
    const catalogService = service(async () => { calls += 1; return response(); });
    const requests = [search("Song"), search("song"), search("Song!"), search("Song  Artist"),
      search("Song Artist"), search("Song", { limit: 1 }), search("Song", { storefront: "us" })];
    for (const payload of requests) {
      assert.equal((await catalogService.request(payload)).cacheHit, false);
      assert.equal((await catalogService.request(payload)).cacheHit, true);
    }
    assert.equal(calls, requests.length);
  });

  await suite.test("positive entries expire at six hours and empty entries at five minutes", async () => {
    for (const [data, ttl] of [[[song], 21600000], [[], 300000]]) {
      const time = clock();
      let calls = 0;
      const catalogService = service(async () => { calls += 1; return response(data); }, time);
      assert.equal((await catalogService.request(search())).cacheHit, false);
      await time.advance(ttl - 1);
      assert.equal((await catalogService.request(search())).cacheHit, true);
      await time.advance(1);
      assert.equal((await catalogService.request(search())).cacheHit, false);
      assert.equal(calls, 2);
    }
  });

  await suite.test("the cache evicts the least recently used entry above 500", async () => {
    let calls = 0;
    const catalogService = service(async () => { calls += 1; return response(); });
    for (let index = 0; index < 500; index += 1) {
      await catalogService.request(search(`Song ${index}`));
    }
    assert.equal((await catalogService.request(search("Song 0"))).cacheHit, true);
    await catalogService.request(search("Song 500"));
    assert.equal((await catalogService.request(search("Song 0"))).cacheHit, true);
    assert.equal((await catalogService.request(search("Song 1"))).cacheHit, false);
    assert.equal(calls, 502);
  });

  await suite.test("spaces all request starts and allows at most two concurrent attempts", async () => {
    const time = clock();
    const gates = [deferred(), deferred(), deferred()];
    const starts = [];
    let active = 0;
    let maximum = 0;
    const catalogService = service(async (input) => {
      const index = starts.length;
      starts.push(time.now());
      active += 1;
      maximum = Math.max(maximum, active);
      await gates[index].promise;
      active -= 1;
      return response([song], 200, {}, new URL(input).pathname.endsWith("/songs") ? "isrc" : "search");
    }, time);
    const requests = [catalogService.request(search("first")),
      catalogService.request({ action: "isrc", storefront: "us", isrcs: ["USAAA2400001"] }),
      catalogService.request(search("third", { storefront: "jp" }))];
    await flush();
    assert.deepEqual(starts, [0]);
    await time.advance(249);
    assert.deepEqual(starts, [0]);
    await time.advance(1);
    assert.deepEqual(starts, [0, 250]);
    await time.advance(250);
    assert.deepEqual(starts, [0, 250]);
    gates[0].resolve();
    await flush();
    assert.deepEqual(starts, [0, 250, 500]);
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(requests);
    assert.equal(maximum, 2);
  });

  await suite.test("uses the default interval and clamps configured intervals", async () => {
    for (const [configured, interval] of [[undefined, 250], ["1", 100], ["10000", 5000], ["200", 200], ["junk", 250], ["250junk", 250]]) {
      const time = clock();
      const starts = [];
      const catalogService = service(async () => { starts.push(time.now()); return response(); }, time,
        configured === undefined ? {} : { APPLE_SEARCH_INTERVAL_MS: configured });
      await catalogService.request(search("first"));
      const second = catalogService.request(search("second"));
      await flush();
      await time.advance(interval - 1);
      assert.deepEqual(starts, [0]);
      await time.advance(1);
      await second;
      assert.deepEqual(starts, [0, interval]);
    }
  });

  await suite.test("a 429 pauses already sleeping requests and new requests for the full Retry-After", async () => {
    const time = clock();
    const firstResponse = deferred();
    const starts = [];
    const catalogService = service(async () => {
      starts.push(time.now());
      return starts.length === 1 ? firstResponse.promise : response();
    }, time);
    const first = catalogService.request(search("first"));
    const failure = assert.rejects(first, appleError(429, "apple_rate_limited", { retryAfterMs: 30000 }));
    const queued = catalogService.request(search("queued"));
    await flush();
    await time.advance(100);
    firstResponse.resolve(response([], 429, { "Retry-After": "30" }));
    await failure;
    const newcomer = catalogService.request(search("newcomer"));
    await time.advance(150);
    assert.deepEqual(starts, [0]);
    await time.advance(29849);
    assert.deepEqual(starts, [0]);
    await time.advance(1);
    await queued;
    assert.deepEqual(starts, [0, 30100]);
    await time.advance(500);
    await newcomer;
    assert.equal(starts.length, 3);
    assert.ok(starts[2] >= 30350);
  });

  await suite.test("honors HTTP-date Retry-After and uses a three-second fallback", async () => {
    const epoch = Date.UTC(2026, 0, 1);
    for (const [header, wait] of [[new Date(epoch + 45000).toUTCString(), 45000], ["bad", 3000], [null, 3000], ["0", 0]]) {
      const time = clock(epoch);
      const catalogService = service(async () => response([], 429, header === null ? {} : { "Retry-After": header }), time);
      await assert.rejects(catalogService.request(search()), appleError(429, "apple_rate_limited", { retryAfterMs: wait }));
    }
  });

  await suite.test("concurrent 429 responses cannot shorten the common cooldown", async () => {
    const time = clock();
    const gates = [deferred(), deferred()];
    const starts = [];
    const catalogService = service(async () => {
      const index = starts.length;
      starts.push(time.now());
      return index < 2 ? gates[index].promise : response();
    }, time);
    const first = assert.rejects(catalogService.request(search("first")), appleError(429, "apple_rate_limited", { retryAfterMs: 60000 }));
    const second = assert.rejects(catalogService.request(search("second")), appleError(429, "apple_rate_limited", { retryAfterMs: 59900 }));
    const queued = catalogService.request(search("queued"));
    await flush();
    await time.advance(250);
    await time.advance(50);
    gates[0].resolve(response([], 429, { "Retry-After": "60" }));
    await first;
    await time.advance(100);
    gates[1].resolve(response([], 429, { "Retry-After": "30" }));
    await second;
    await time.advance(59899);
    assert.deepEqual(starts, [0, 250]);
    await time.advance(1);
    await queued;
    assert.deepEqual(starts, [0, 250, 60300]);
  });

  await suite.test("429 intervals grow to a cap and successes gradually recover without exceeding base speed", async () => {
    const time = clock(0, true);
    const starts = [];
    const catalogService = service(async () => {
      starts.push(time.now());
      return starts.length <= 5 ? response([], 429, { "Retry-After": "0" }) : response();
    }, time);
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(catalogService.request(search(`limited ${index}`)), appleError(429, "apple_rate_limited"));
    }
    for (let index = 0; index < 130; index += 1) {
      await catalogService.request(search(`success ${index}`));
    }
    const gaps = starts.slice(1).map((start, index) => start - starts[index]);
    assert.ok(gaps[0] > 250);
    assert.ok(Math.max(...gaps) <= 3000);
    assert.ok(gaps.every((gap) => gap >= 250));
    assert.ok(gaps[6] < gaps[5]);
    assert.equal(gaps.at(-1), 250);
    const slowTime = clock(0, true);
    const slowStarts = [];
    const slowService = service(async () => { slowStarts.push(slowTime.now()); return response([], 429, { "Retry-After": "0" }); }, slowTime, { APPLE_SEARCH_INTERVAL_MS: "5000" });
    await assert.rejects(slowService.request(search("one")), appleError(429, "apple_rate_limited"));
    await assert.rejects(slowService.request(search("two")), appleError(429, "apple_rate_limited"));
    assert.deepEqual(slowStarts, [0, 5000]);
  });

  await suite.test("bounds unique pending requests at 40 but permits dedupe and cache hits", async () => {
    const gate = deferred();
    let blocked = false;
    let calls = 0;
    const catalogService = service(async () => {
      calls += 1;
      if (blocked) await gate.promise;
      return response();
    });
    await catalogService.request(search("cached"));
    blocked = true;
    const requests = Array.from({ length: 40 }, (_, index) => catalogService.request(search(`pending ${index}`)));
    const duplicate = catalogService.request(search("pending 0"));
    await assert.rejects(catalogService.request(search("overflow")), appleError(429, "apple_queue_full", { retryAfterMs: 2000 }));
    assert.equal((await catalogService.request(search("cached"))).cacheHit, true);
    gate.resolve();
    await Promise.all([...requests, duplicate]);
    assert.equal(calls, 41);
    assert.equal((await catalogService.request(search("overflow"))).cacheHit, false);
  });

  await suite.test("makes one upstream attempt, scrubs failures and never caches them", async () => {
    for (const status of [500, 503]) {
      let calls = 0;
      const catalogService = service(async () => {
        calls += 1;
        return new Response("private upstream body Bearer fake", { status });
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(catalogService.request(search()), (error) => {
          appleError(503, "apple_search_unavailable")(error);
          assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private|Bearer|fake/);
          assert.equal(error.cause, undefined);
          return true;
        });
      }
      assert.equal(calls, 2);
    }
  });

  await suite.test("preserves upstream 4xx statuses as non-retryable scrubbed errors", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      let calls = 0;
      const catalogService = service(async () => {
        calls += 1;
        return new Response("private upstream body Bearer fake", { status });
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(catalogService.request(search()), (error) => {
          appleError(status, "apple_search_failed")(error);
          assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private|Bearer|fake/);
          assert.equal(error.cause, undefined);
          return true;
        });
      }
      assert.equal(calls, 2);
    }
  });

  await suite.test("429 failures are deduplicated but never cached and leave no pending entry", async () => {
    let calls = 0;
    const catalogService = service(async () => {
      calls += 1;
      return calls === 1 ? response([], 429, { "Retry-After": "30" }) : response();
    });
    const first = assert.rejects(catalogService.request(search()), appleError(429, "apple_rate_limited", { retryAfterMs: 30000 }));
    const duplicate = assert.rejects(catalogService.request(search()), appleError(429, "apple_rate_limited", { retryAfterMs: 30000 }));
    await Promise.all([first, duplicate]);
    assert.equal(calls, 1);
    assert.equal((await catalogService.request(search())).cacheHit, false);
    assert.equal(calls, 2);
    assert.equal((await catalogService.request(search())).cacheHit, true);
  });

  await suite.test("network and malformed responses are scrubbed and release pending slots", async () => {
    for (const broken of [
      () => { throw new Error("network error with private Bearer fake"); },
      () => { throw new AppleError(429, "apple_rate_limited", "private fake"); },
      () => new Response("private fake"),
      () => new Response(JSON.stringify({ results: { songs: { data: "private" } } }))
    ]) {
      let calls = 0;
      const catalogService = service(async () => { calls += 1; return calls === 1 ? broken() : response(); });
      await assert.rejects(catalogService.request(search()), (error) => {
        appleError(503, "apple_search_unavailable")(error);
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private|Bearer|fake/);
        return true;
      });
      assert.deepEqual(await catalogService.request(search()), { data: [song], cacheHit: false });
      assert.equal(calls, 2);
    }
  });

  await suite.test("times out an uncooperative fetch at 12 seconds and releases the slot", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    let calls = 0;
    let settled = false;
    const catalogService = service(async (_input, options) => {
      calls += 1;
      signal = options.signal;
      return calls === 1 ? new Promise(() => {}) : response();
    });
    const failure = assert.rejects(catalogService.request(search()), appleError(503, "apple_search_unavailable"));
    failure.then(() => { settled = true; });
    await flush();
    context.mock.timers.tick(11999);
    await flush();
    assert.equal(settled, false);
    assert.equal(signal.aborted, false);
    context.mock.timers.tick(1);
    await failure;
    assert.equal(signal.aborted, true);
    assert.equal((await catalogService.request(search())).cacheHit, false);
    assert.equal(calls, 2);
  });

  await suite.test("the 12-second deadline includes response body parsing", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const catalogService = service(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
    const failure = assert.rejects(catalogService.request(search()), appleError(503, "apple_search_unavailable"));
    await flush();
    context.mock.timers.tick(12000);
    await failure;
  });

  await suite.test("caches developer tokens and refreshes within 60 seconds of expiry", async () => {
    const time = clock(1000000, true);
    const token = (expiresAt) => `header.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString("base64url")}.signature`;
    let currentToken = token(2000);
    let reads = 0;
    const env = { get APPLE_DEVELOPER_TOKEN() { reads += 1; return currentToken; } };
    const sentTokens = [];
    const catalogService = new AppleCatalogService(env, {
      now: time.now, sleep: time.sleep,
      fetcher: async (_input, options) => { sentTokens.push(new Headers(options.headers).get("Authorization")); return response(); }
    });
    await catalogService.request(search("first"));
    const initialReads = reads;
    await time.advance(939000);
    await catalogService.request(search("second"));
    assert.equal(reads, initialReads);
    currentToken = token(4000);
    await time.advance(1000);
    await catalogService.request(search("third"));
    assert.ok(reads > initialReads);
    assert.deepEqual(sentTokens, [`Bearer ${token(2000)}`, `Bearer ${token(2000)}`, `Bearer ${token(4000)}`]);
  });

  await suite.test("credential failures release requests and do not expose secrets", async () => {
    let calls = 0;
    const env = {};
    const catalogService = new AppleCatalogService(env, { fetcher: async () => { calls += 1; return response(); } });
    await assert.rejects(catalogService.request(search()), (error) => {
      assert.ok(error instanceof AppleError);
      assert.equal(error.status, 503);
      return true;
    });
    assert.equal(calls, 0);
    env.APPLE_DEVELOPER_TOKEN = "fake";
    assert.equal((await catalogService.request(search())).cacheHit, false);
    env.APPLE_DEVELOPER_TOKEN = "";
    env.APPLE_TEAM_ID = "private-team";
    env.APPLE_KEY_ID = "private-key";
    env.APPLE_PRIVATE_KEY = "private-invalid-pem";
    const brokenService = new AppleCatalogService(env);
    await assert.rejects(brokenService.request(search()), (error) => {
      appleError(503, "apple_search_unavailable")(error);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-team|private-key|private-invalid-pem/);
      return true;
    });
  });
});
