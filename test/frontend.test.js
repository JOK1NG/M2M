import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";

import { renderAppHtml } from "../src/frontend.js";

function functions() {
  const html = renderAppHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const context = vm.createContext({ URLSearchParams, Map, Date, Math, Number, Error,
    AbortSignal, state: {}, SEARCH_RETRY_MAX_MS: 15000, SEARCH_RETRY_BASE_MS: 1200 });
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
  let reopened = null;
  const context = vm.createContext({ state: { parsed: {}, importControl: { running: true } },
    showView: view => { reopened = view; },
    validatePlaylistNameInput: () => assert.fail("must not start another import") });
  vm.runInContext(section, context);
  await context.connectAppleMusic();
  assert.equal(reopened, "import");
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

test("recent matching speed excludes pauses and remains stable beyond 400 and 1000 songs", () => {
  const { script } = functions();
  const section = script.slice(script.indexOf("    function createMatchMeter("), script.indexOf("    async function importToAppleMusic("));
  const context = vm.createContext({ Date, Math });
  vm.runInContext(section, context);
  assert.equal(typeof context.createMatchMeter, "function");
  let time = 0;
  const meter = context.createMatchMeter(() => time);
  let snapshot;
  for (let completed = 1; completed <= 1000; completed += 1) {
    if (completed === 401) {
      meter.pause();
      time += 120000;
      meter.resume();
    }
    time += 500;
    snapshot = meter.sample(completed);
    if ([100, 400, 500, 1000].includes(completed)) {
      assert.equal(snapshot.recentSpeed, 2);
      assert.equal(snapshot.averageSpeed, 2);
    }
  }
  assert.ok(snapshot.sampleCount <= 512);
});

test("recent speed detects a real slowdown rather than reporting only a lifetime average", () => {
  const { script } = functions();
  const section = script.slice(script.indexOf("    function createMatchMeter("), script.indexOf("    async function importToAppleMusic("));
  const context = vm.createContext({ Date, Math });
  vm.runInContext(section, context);
  let time = 0;
  const meter = context.createMatchMeter(() => time);
  let snapshot;
  for (let completed = 1; completed <= 500; completed += 1) {
    time += completed <= 400 ? 500 : 1000;
    snapshot = meter.sample(completed);
  }
  assert.equal(snapshot.recentSpeed, 1);
  assert.ok(snapshot.averageSpeed > snapshot.recentSpeed);
});

test("version alternatives remain pending rather than failed or silently selected", async () => {
  const { script } = functions();
  const section = script.slice(script.indexOf("    async function matchAppleSongs("), script.indexOf("    async function findAppleSong("));
  const context = vm.createContext({ MATCH_CONCURRENCY: 1, SEARCH_REQUEST_INTERVAL_MS: 80, Array, Promise, Map, Math });
  vm.runInContext(section, context);
  context.state = { importControl: { running: true }, catalogCache: new Map() };
  context.createSearchLimiter = () => ({});
  context.waitForImportTurn = async () => {};
  const candidate = { id: "alternative", type: "songs", attributes: { name: "Song (DJ版)", artistName: "Artist" }, confirmationReason: "version_mismatch" };
  context.findAppleSong = async (_music, _region, _source, _cache, _limiter, onUnmatched) => {
    onUnmatched({ reason: "version_mismatch", candidates: [candidate] });
    return null;
  };
  context.setTrackStatus = () => {};
  context.recordFailedTrack = () => assert.fail("An undecided candidate is not a failure");
  let progress;
  const result = await context.matchAppleSongs(null, "cn", [{ id: 1 }], value => { progress = value; });
  assert.equal(result.failed, 0);
  assert.equal(result.pending, 1);
  assert.equal(result.rows[0].apple, null);
  assert.equal(result.rows[0].status, "needs_review");
  assert.equal(result.rows[0].candidates[0].id, "alternative");
  assert.equal(progress.pending, 1);
});

test("catalog diagnostics are collected without exposing subscriber credentials", async () => {
  const { context } = functions();
  context.state = { developerToken: "developer-secret", musicUserToken: "subscriber-secret", catalogMetrics: {
    requests: 0, cacheHits: 0, totalRoundTripMs: 0, rateLimited: 0
  } };
  context.runAppleSearchWithRetry = async (_label, _limiter, operation) => operation();
  context.fetch = async (_url, request) => {
    assert.ok(!JSON.stringify(request).includes("secret"));
    return Response.json({ data: [], cacheHit: true, diagnostics: { intervalMs: 800, queueDepth: 3, cooldownMs: 0,
      elapsedMs: 2, rateLimitEvents: 1, token: "subscriber-secret", otherSearchTerms: ["private playlist"] } });
  };
  await context.requestAppleCatalog({ action: "search", storefront: "cn", term: "Song" }, {});
  assert.equal(context.state.catalogMetrics.requests, 1);
  assert.equal(context.state.catalogMetrics.cacheHits, 1);
  assert.equal(context.state.catalogMetrics.latest.intervalMs, 800);
  assert.ok(!JSON.stringify(context.state.catalogMetrics).includes("secret"));
  assert.ok(!JSON.stringify(context.state.catalogMetrics).includes("private playlist"));
});

function reviewFunctions() {
  const { script } = functions();
  const created = [];
  const node = (tag = "div") => ({
    tagName: tag, children: [], textContent: "", hidden: true, disabled: false,
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
    setAttribute(name, value) { this[name] = value; }
  });
  const elements = Object.fromEntries(["versionReviewPanel", "versionReviewPosition", "versionReviewSource", "versionReviewMetadata",
    "versionReviewReason", "versionReviewCandidates", "confirmVersion", "skipVersion", "skipAllVersions", "importMatched", "importFailed", "importLog", "appStatus"]
    .map(name => [name, node()]));
  const context = vm.createContext({ Array, Promise, Number, Math, String, URL, Date, Error,
    document: { createElement(tag) { const element = node(tag); created.push(element); return element; } },
    state: { importControl: { running: true, canceled: false } }, elements,
    waitForImportTurn: async () => {}, updateImportControlButtons: () => {}, setImportProgress: () => {},
    setTrackStatus: () => {}, addLog: () => {},
    recordFailedTrack: () => {},
    createImportCanceledError: () => Object.assign(new Error("Canceled"), { name: "ImportCanceledError" }) });
  const section = script.slice(script.indexOf("    function unmatchedReason("), script.indexOf("    async function findAppleSong("));
  vm.runInContext(section, context);
  return { context, elements, created };
}

function pendingRow(id = 1) {
  return { source: { id, index: id, name: "Song", artists: ["Artist"], album: "Album", durationMs: 160000 },
    apple: null, status: "needs_review", reason: "时长不一致", candidates: [{
      id: "alternative", type: "songs", confirmationReason: "duration_mismatch", attributes: {
        name: "Song", artistName: "Artist", albumName: "Album", durationInMillis: 210596,
        url: "https://music.apple.com/cn/song/123"
      }
    }] };
}

async function waitForReview(context) {
  for (let turn = 0; turn < 20 && !context.state.versionReview; turn += 1) await Promise.resolve();
  assert.ok(context.state.versionReview);
}

test("manual confirmation requires an explicit selection and preserves the source track order", async () => {
  const { context, elements } = reviewFunctions();
  assert.equal(typeof context.reviewMatchedRows, "function");
  const first = { ...pendingRow(1), apple: { id: "automatic" }, status: "matched" };
  const second = pendingRow(2);
  const summary = { matched: 1, failed: 0, pending: 1 };
  const operation = context.reviewMatchedRows([first, second], summary);
  await waitForReview(context);
  assert.equal(second.apple, null);
  assert.equal(elements.confirmVersion.disabled, true);
  context.completeVersionChoice(false);
  assert.equal(second.apple, null);
  context.selectVersionCandidate(0);
  assert.equal(elements.confirmVersion.disabled, false);
  context.completeVersionChoice(false);
  await operation;
  assert.equal(second.apple.id, "alternative");
  assert.equal(second.confirmed, true);
  assert.equal(first.apple.id, "automatic");
  assert.equal(summary.matched, 2);
  assert.equal(summary.pending, 0);
  assert.equal(context.state.versionReview, null);
});

test("skipping remaining alternatives records failures only after the user's decision", async () => {
  const { context } = reviewFunctions();
  let failures = 0;
  context.recordFailedTrack = () => { failures += 1; };
  const rows = [pendingRow(1), pendingRow(2)];
  const summary = { matched: 0, failed: 0, pending: 2 };
  const operation = context.reviewMatchedRows(rows, summary);
  await waitForReview(context);
  assert.equal(failures, 0);
  context.skipRemainingVersions();
  await operation;
  assert.equal(failures, 2);
  assert.equal(summary.failed, 2);
  assert.equal(summary.pending, 0);
  assert.ok(rows.every(row => !row.apple && row.status === "not_found"));
});

test("canceling version review rejects the import without selecting or failing pending songs", async () => {
  const { context } = reviewFunctions();
  context.recordFailedTrack = () => assert.fail("Cancellation is not a failure");
  const row = pendingRow();
  const operation = context.reviewMatchedRows([row], { matched: 0, failed: 0, pending: 1 });
  const rejection = assert.rejects(operation, { name: "ImportCanceledError" });
  await waitForReview(context);
  context.cancelVersionReview();
  await rejection;
  assert.equal(row.apple, null);
  assert.equal(context.state.versionReview, null);
});

test("candidate metadata remains text and untrusted links are not navigable", async () => {
  const { context, created } = reviewFunctions();
  const row = pendingRow();
  row.candidates[0].attributes.name = "<img src=x onerror=alert(1)>";
  row.candidates[0].attributes.url = "javascript:alert(1)";
  const operation = context.reviewMatchedRows([row], { matched: 0, failed: 0, pending: 1 });
  await waitForReview(context);
  assert.ok(created.some(element => element.textContent.includes("<img src=x")));
  assert.ok(created.every(element => !element.innerHTML));
  assert.ok(created.every(element => !element.href || element.href.startsWith("https://music.apple.com/")));
  context.skipRemainingVersions();
  await operation;
});

test("1000 log updates retain bounded rows and coalesce forced layout reads into one animation frame", () => {
  const { script } = functions();
  const section = script.slice(script.indexOf("    function addLog("), script.indexOf("    function downloadParsedJson("));
  const frames = [];
  let layoutReads = 0;
  const container = {
    children: [],
    appendChild(row) { this.children.push(row); row.remove = () => { this.children.splice(this.children.indexOf(row), 1); }; },
    get firstElementChild() { return this.children[0]; },
    get scrollHeight() { layoutReads += 1; return 100; }
  };
  const context = vm.createContext({ Date, Math, WeakSet, state: {}, document: { createElement: () => ({}) },
    requestAnimationFrame: callback => frames.push(callback), escapeHtml: text => text });
  vm.runInContext(section, context);
  for (let index = 0; index < 1000; index += 1) context.addLog(container, "Query " + index);
  assert.equal(container.children.length, 100);
  assert.equal(layoutReads, 0);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(layoutReads, 1);
  context.addLog(container, "Next frame");
  assert.equal(frames.length, 2);
});
