import assert from "node:assert/strict";
import test from "node:test";
import { AppleCatalogService } from "../src/apple-catalog.js";

async function flush() {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

function clock() {
  let timestamp = 0;
  const sleepers = [];
  return { now: () => timestamp, sleep: delay => new Promise(resolve => sleepers.push({ at: timestamp + delay, resolve })),
    async advance(delay) {
      timestamp += delay;
      await flush();
      while (sleepers.some(sleeper => sleeper.at <= timestamp)) {
        for (let index = sleepers.length - 1; index >= 0; index -= 1) {
          if (sleepers[index].at <= timestamp) sleepers.splice(index, 1)[0].resolve();
        }
        await flush();
      }
    }
  };
}

const search = term => ({ action: "search", term });
const response = () => Response.json({ results: { songs: { data: [] } } });

test("catalog diagnostics separate queue time from upstream time and report bounded runtime indicators", async () => {
  const time = clock();
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake", APPLE_SEARCH_CONCURRENCY: "1" }, {
    now: time.now, sleep: time.sleep, fetcher: async () => { await time.sleep(1000); return response(); }
  });
  const first = service.request(search("first"), { diagnostics: true });
  const second = service.request(search("second"), { diagnostics: true });
  await flush();
  await time.advance(1000);
  await time.advance(1000);
  const results = await Promise.all([first, second]);
  assert.equal(results[0].diagnostics.upstreamMs, 1000);
  assert.equal(results[0].diagnostics.queueWaitMs, 0);
  assert.equal(results[1].diagnostics.upstreamMs, 1000);
  assert.equal(results[1].diagnostics.queueWaitMs, 1000);
  assert.equal(results[1].diagnostics.elapsedMs, 2000);
  assert.equal(results[1].diagnostics.concurrencyLimit, 1);
  assert.equal(results[1].diagnostics.pendingLimit, 40);
  assert.equal(results[1].diagnostics.upstreamRequests, 2);
  assert.equal(results[1].diagnostics.upstreamFailures, 0);
  assert.equal(results[1].diagnostics.serverUptimeMs, 2000);
  assert.ok(results[1].diagnostics.memoryCacheBytes > 0);
  assert.ok(!("cpuUsage" in results[1].diagnostics));
  assert.ok(!("heapUsed" in results[1].diagnostics));
  assert.doesNotMatch(JSON.stringify(results[1].diagnostics), /first|second|fake|token/);
});

test("200ms configured pacing improves cold-search starts and a single 503 does not pause unrelated jobs", async () => {
  const time = clock();
  const starts = [];
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake", APPLE_SEARCH_INTERVAL_MS: "200" }, {
    now: time.now, sleep: time.sleep, fetcher: async () => {
      starts.push(time.now());
      return starts.length === 1 ? new Response(null, { status: 503 }) : response();
    }
  });
  const failure = assert.rejects(service.request(search("failed"), { diagnostics: true }), error => {
    assert.equal(error.status, 503);
    assert.equal(error.diagnostics.upstreamFailures, 1);
    return true;
  });
  const healthy = service.request(search("healthy"), { diagnostics: true });
  await flush();
  await time.advance(200);
  await failure;
  const result = await healthy;
  assert.deepEqual(starts, [0, 200]);
  assert.equal(result.diagnostics.cooldownMs, 0);
  assert.equal(result.diagnostics.intervalMs, 200);
});

test("late coalesced callers measure only their own overlap with queue and upstream stages", async () => {
  const time = clock();
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake", APPLE_SEARCH_CONCURRENCY: "1" }, {
    now: time.now, sleep: time.sleep, fetcher: async () => { await time.sleep(1000); return response(); }
  });
  const blocker = service.request(search("blocker"));
  const original = service.request(search("shared"), { diagnostics: true });
  await flush();
  await time.advance(500);
  const late = service.request(search("shared"), { diagnostics: true });
  await time.advance(500);
  await blocker;
  await time.advance(500);
  const inFlight = service.request(search("shared"), { diagnostics: true });
  await time.advance(500);
  const results = await Promise.all([original, late, inFlight]);
  assert.equal(results[0].diagnostics.queueWaitMs, 1000);
  assert.equal(results[0].diagnostics.upstreamMs, 1000);
  assert.equal(results[1].diagnostics.queueWaitMs, 500);
  assert.equal(results[1].diagnostics.upstreamMs, 1000);
  assert.equal(results[2].diagnostics.queueWaitMs, 0);
  assert.equal(results[2].diagnostics.upstreamMs, 500);
  assert.equal(results[2].diagnostics.coalesced, 1);
});

test("three consecutive upstream failures back off globally and successful recovery returns to the configured floor", async () => {
  const time = clock();
  let calls = 0;
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake", APPLE_SEARCH_INTERVAL_MS: "200" }, {
    now: time.now, sleep: time.sleep, fetcher: async () => {
      calls += 1;
      return calls <= 3 ? new Response(null, { status: 503 }) : response();
    }
  });
  for (let index = 0; index < 3; index += 1) {
    const failure = assert.rejects(service.request(search("failure " + index)), error => error.status === 503);
    await flush();
    await time.advance(200);
    await failure;
  }
  assert.ok(service.interval > 200);
  assert.ok(service.cooldownUntil > time.now());
  assert.equal(service.rateLimitEvents, 0);
  const recovering = service.request(search("recovering"), { diagnostics: true });
  await flush();
  assert.equal(calls, 3);
  await time.advance(2000);
  await recovering;
  for (let index = 0; index < 12; index += 1) {
    const pending = service.request(search("success " + index));
    await time.advance(300);
    await pending;
  }
  assert.equal(service.interval, 200);
});

for (const staleStatus of [200, 503]) {
  test("stale HTTP " + staleStatus + " cannot alter recovery after a three-failure cooldown", async () => {
    const time = clock();
    let releaseOld;
    const oldResponse = new Promise(resolve => { releaseOld = resolve; });
    const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake", APPLE_SEARCH_INTERVAL_MS: "200" }, {
      now: time.now, sleep: time.sleep, fetcher: async input => {
        const term = new URL(input).searchParams.get("term");
        if (term === "old") return oldResponse;
        return term.startsWith("failure") ? new Response(null, { status: 503 }) : response();
      }
    });
    const old = service.request(search("old"));
    const oldOutcome = old.then(result => result, error => error);
    await flush();
    for (let index = 0; index < 3; index += 1) {
      const failure = assert.rejects(service.request(search("failure " + index)), error => error.status === 503);
      await time.advance(200);
      await failure;
    }
    const firstSuccess = service.request(search("healthy 0"));
    await time.advance(2000);
    await firstSuccess;
    for (let index = 1; index < 3; index += 1) {
      const pending = service.request(search("healthy " + index));
      await time.advance(300);
      await pending;
    }
    assert.equal(service.recoveryStreak, 3);
    releaseOld(staleStatus === 200 ? response() : new Response(null, { status: 503 }));
    await oldOutcome;
    assert.equal(service.interval, 300);
    assert.equal(service.recoveryStreak, 3);
    const fourthSuccess = service.request(search("healthy 3"));
    await time.advance(300);
    await fourthSuccess;
    assert.equal(service.interval, 240);
  });
}

test("memory cache byte reporting is bounded and accounting handles eviction and expiry", async () => {
  let timestamp = 0;
  const service = new AppleCatalogService({ APPLE_DEVELOPER_TOKEN: "fake" }, {
    now: () => timestamp, sleep: async delay => { timestamp += delay; }, memoryCacheMaxBytes: 64,
    fetcher: async () => response()
  });
  for (let index = 0; index < 100; index += 1) {
    const result = await service.request(search("small " + index), { diagnostics: true });
    assert.ok(result.diagnostics.memoryCacheBytes <= 64);
    assert.ok(result.diagnostics.memoryCacheEntries <= 32);
  }
  timestamp += 300000;
  await service.request(search("small 99"), { diagnostics: true });
  assert.ok(service.memoryCacheBytes >= 0 && service.memoryCacheBytes <= 64);
});
