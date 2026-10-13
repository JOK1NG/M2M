import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";

import { renderAppHtml } from "../src/frontend.js";

function functions() {
  const html = renderAppHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const context = vm.createContext({ URLSearchParams, Map, Date, Math, Number, Error,
    AbortSignal, SEARCH_RETRY_MAX_MS: 15000, SEARCH_RETRY_BASE_MS: 1200 });
  const section = script.slice(script.indexOf("    async function searchAppleSongs("), script.indexOf("    async function createApplePlaylist("));
  vm.runInContext(section, context);
  return { script, context };
}

test("honors long Retry-After values instead of retrying before the server allows", () => {
  const { context } = functions();
  assert.equal(context.appleSearchRetryDelay({ retryAfterMs: 60000 }, 0), 60000);
});

test("catalog search stays on the coordinated backend without sending the subscriber token", async () => {
  const { context } = functions();
  context.state = { developerToken: "developer-secret", musicUserToken: "subscriber-secret" };
  context.SEARCH_RESULT_LIMIT = 25;
  context.runAppleSearchWithRetry = async (_label, _limiter, operation) => operation();
  context.fetch = async (url, request) => {
    assert.equal(url, "/apple/catalog");
    assert.equal(request.method, "POST");
    assert.deepEqual(JSON.parse(request.body), { action: "search", storefront: "cn", term: "生きていたんだよな", limit: 25 });
    assert.ok(!JSON.stringify(request).includes("secret"));
    return new Response(JSON.stringify({ data: [{ id: "song" }] }), { status: 200 });
  };
  const result = await context.searchAppleSongs(null, "cn", "生きていたんだよな", new Map(), {});
  assert.equal(result[0].id, "song");
});

test("canceling a catalog operation does not turn the current track into a failed match", () => {
  const { script } = functions();
  const section = script.slice(script.indexOf("    async function matchAppleSongs("), script.indexOf("    async function findAppleSong("));
  const context = vm.createContext({ MATCH_CONCURRENCY: 1, Array, Promise });
  vm.runInContext(section, context);
  context.state = { importControl: { canceled: true } };
  context.waitForImportTurn = async () => {};
  context.findAppleSong = async () => { throw Object.assign(new Error("Canceled"), { name: "ImportCanceledError" }); };
  context.createImportCanceledError = () => Object.assign(new Error("Canceled"), { name: "ImportCanceledError" });
  context.createSearchLimiter = () => ({});
  context.recordFailedTrack = () => assert.fail("Cancellation must not be recorded as failure");
  context.setTrackStatus = () => {};
  context.readableError = error => error.message;
  context.SEARCH_REQUEST_INTERVAL_MS = 250;
  return assert.rejects(context.matchAppleSongs(null, "cn", [{ id: 1 }], () => {}), { name: "ImportCanceledError" });
});

test("exhausted rate-limit retries pause and retry the same track without inflating failure counts", async () => {
  const { script } = functions();
  const section = script.slice(script.indexOf("    async function matchAppleSongs("), script.indexOf("    async function findAppleSong("));
  const context = vm.createContext({ MATCH_CONCURRENCY: 1, SEARCH_REQUEST_INTERVAL_MS: 180, Array, Promise, Map });
  vm.runInContext(section, context);
  context.state = { importControl: { running: true, paused: false, canceled: false }, catalogCache: new Map() };
  context.createSearchLimiter = () => ({});
  context.waitForImportTurn = async () => { context.state.importControl.paused = false; };
  let calls = 0;
  let pauses = 0;
  context.findAppleSong = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("429"), { status: 429 });
    return { id: "matched" };
  };
  context.shouldRetryAppleSearch = error => error.status === 429;
  context.pauseForAppleSearch = () => { pauses += 1; context.state.importControl.paused = true; };
  context.recordFailedTrack = () => assert.fail("Transient errors must not become song failures");
  context.setTrackStatus = () => {};
  const result = await context.matchAppleSongs(null, "cn", [{ id: 1 }], () => {});
  assert.equal(pauses, 1);
  assert.equal(calls, 2);
  assert.equal(result.matched, 1);
  assert.equal(result.failed, 0);
});

test("backend network failures become retryable rather than missing songs", async () => {
  const { context } = functions();
  context.runAppleSearchWithRetry = async (_label, _limiter, operation) => operation();
  context.fetch = async () => { throw new TypeError("Network connection lost"); };
  await assert.rejects(context.requestAppleCatalog({ action: "search", term: "Song", storefront: "cn" }, {}),
    error => error.status === 503);
});

test("cancel waits for sibling match workers before an import can finish", async () => {
  const { script } = functions();
  const section = script.slice(script.indexOf("    async function matchAppleSongs("), script.indexOf("    async function findAppleSong("));
  const context = vm.createContext({ MATCH_CONCURRENCY: 2, SEARCH_REQUEST_INTERVAL_MS: 180, Array, Promise, Map });
  vm.runInContext(section, context);
  context.state = { importControl: { running: true, canceled: false }, catalogCache: new Map() };
  context.createSearchLimiter = () => ({});
  context.createImportCanceledError = () => Object.assign(new Error("Canceled"), { name: "ImportCanceledError" });
  context.waitForImportTurn = async () => { if (context.state.importControl.canceled) throw context.createImportCanceledError(); };
  let releaseSibling;
  const sibling = new Promise(resolve => { releaseSibling = resolve; });
  context.findAppleSong = async (_music, _region, source) => {
    if (source.id === 1) { context.state.importControl.canceled = true; throw context.createImportCanceledError(); }
    return sibling;
  };
  context.recordFailedTrack = () => assert.fail("Canceled songs must not be failures");
  context.setTrackStatus = () => {};
  let settled = false;
  const operation = context.matchAppleSongs(null, "cn", [{ id: 1 }, { id: 2 }], () => {}).finally(() => { settled = true; });
  const rejection = assert.rejects(operation, { name: "ImportCanceledError" });
  for (let iteration = 0; iteration < 12; iteration += 1) await Promise.resolve();
  assert.equal(settled, false);
  releaseSibling({ id: "late-result" });
  await rejection;
});

test("a second import cannot replace a running import's control", async () => {
  const { script } = functions();
  const section = script.slice(script.indexOf("    async function connectAppleMusic("), script.indexOf("    function configureMusicKit("));
  const context = vm.createContext({ state: { parsed: {}, importControl: { running: true } },
    validatePlaylistNameInput: () => assert.fail("must not start another import") });
  vm.runInContext(section, context);
  await context.connectAppleMusic();
});

test("distinguishes an unavailable recording in the account region from an unconfirmed match", async () => {
  const { script } = functions();
  const section = script.slice(script.indexOf("    async function matchAppleSongs("), script.indexOf("    async function findAppleSong("));
  const context = vm.createContext({ MATCH_CONCURRENCY: 2, SEARCH_REQUEST_INTERVAL_MS: 80, Array, Promise, Map });
  vm.runInContext(section, context);
  context.state = { importControl: { running: true }, catalogCache: new Map() };
  context.createSearchLimiter = () => ({});
  context.waitForImportTurn = async () => {};
  context.findAppleSong = async (_music, _region, source, _cache, _limiter, onUnmatched) => {
    if (onUnmatched) onUnmatched({ reason: source.id === 1 ? "recording_unavailable" : "unconfirmed" });
    return null;
  };
  context.setTrackStatus = () => {};
  context.recordFailedTrack = () => {};
  const result = await context.matchAppleSongs(null, "us", [{ id: 1 }, { id: 2 }], () => {});
  assert.match(result.rows[0].reason, /目标地区.*同一录音/);
  assert.ok(result.rows[0].reason.includes("US"));
  assert.ok(!result.rows[0].reason.includes("版权"));
  assert.notEqual(result.rows[0].reason, result.rows[1].reason);
});

test("browser workers can keep four upstream requests busy without imposing the upstream throttle on cache hits", () => {
  const { script } = functions();
  const concurrency = Number(script.match(/const MATCH_CONCURRENCY = (\d+)/)[1]);
  const interval = Number(script.match(/const SEARCH_REQUEST_INTERVAL_MS = (\d+)/)[1]);
  assert.equal(concurrency, 8);
  assert.ok(interval > 0 && interval <= 100);
});
