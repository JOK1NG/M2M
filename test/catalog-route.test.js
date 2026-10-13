import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

test("catalog requests use the one global Durable Object and strip unrelated credentials", async () => {
  const requests = [];
  const env = { M2M_QUEUE: {
    idFromName: name => { assert.equal(name, "global"); return "global-id"; },
    get: id => { assert.equal(id, "global-id"); return { fetch: async request => {
      requests.push({ path: new URL(request.url).pathname, body: await request.json(), headers: [...request.headers] });
      return Response.json({ data: [{ id: "cn-song" }], cacheHit: false });
    } }; }
  } };
  const response = await worker.fetch(new Request("https://m2m.example/apple/catalog", {
    method: "POST", headers: { "Content-Type": "application/json", "Music-User-Token": "never-forward" },
    body: JSON.stringify({ action: "search", storefront: "cn", term: "生きていたんだよな", limit: 25, musicUserToken: "never-forward" })
  }), env);
  assert.equal(response.status, 200);
  assert.equal(requests[0].path, "/apple/catalog");
  assert.deepEqual(requests[0].body, { action: "search", storefront: "cn", term: "生きていたんだよな", limit: 25 });
  assert.ok(!JSON.stringify(requests).includes("never-forward"));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("rejects invalid catalog payloads before contacting the coordinator", async () => {
  const env = { M2M_QUEUE: { idFromName: () => assert.fail("invalid payload must not reach coordinator") } };
  for (const body of ["null", "[]", JSON.stringify({ action: "search", term: "", storefront: "../me/library" }), "{"]) {
    const response = await worker.fetch(new Request("https://m2m.example/apple/catalog", {
      method: "POST", headers: { "Content-Type": "application/json" }, body
    }), env);
    assert.equal(response.status, 400);
  }
});

test("catalog requests require JSON and enforce a body size bound", async () => {
  const response = await worker.fetch(new Request("https://m2m.example/apple/catalog", { method: "POST", body: "text" }), {});
  assert.equal(response.status, 415);
  const oversized = await worker.fetch(new Request("https://m2m.example/apple/catalog", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ term: "a".repeat(9000) })
  }), {});
  assert.equal(oversized.status, 413);
});

test("catalog rate-limit details survive the Worker response", async () => {
  const env = { M2M_QUEUE: { idFromName: () => "global", get: () => ({ fetch: async () => Response.json({
    error: { code: "apple_rate_limited", message: "Try later", details: { retryAfterMs: 60000 } }
  }, { status: 429, headers: { "Retry-After": "60" } }) }) } };
  const response = await worker.fetch(new Request("https://m2m.example/apple/catalog", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "search", term: "Song", storefront: "cn" })
  }), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal((await response.json()).error.details.retryAfterMs, 60000);
});

test("the queue proxy cannot bypass catalog validation", async () => {
  const response = await worker.fetch(new Request("https://m2m.example/queue/apple/catalog", {
    method: "POST", headers: { "Content-Type": "text/plain", Origin: "https://untrusted.example" },
    body: JSON.stringify({ action: "search", storefront: "cn", term: "Song", extra: "a".repeat(9000) })
  }), { M2M_QUEUE: { idFromName: () => assert.fail("must not proxy an arbitrary path") } });
  assert.equal(response.status, 404);
});

test("catalog rejects chunked oversized bodies without reading the rest of the stream", async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(9000)); },
    cancel() { canceled = true; }
  });
  const response = await worker.fetch(new Request("https://m2m.example/apple/catalog", {
    method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half"
  }), {});
  assert.equal(response.status, 413);
  assert.equal(canceled, true);
});
