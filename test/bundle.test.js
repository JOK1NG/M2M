import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { unstable_readConfig } from "wrangler";

test("the browser matcher executes after Workers bundling with the deployment configuration", async () => {
  const config = unstable_readConfig({ config: "wrangler.toml" });
  const result = await build({
    entryPoints: [config.main], bundle: true, format: "esm", platform: "browser", target: "es2022",
    keepNames: config.keep_names, minify: config.minify, write: false
  });
  const url = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64");
  const { default: worker } = await import(url);
  const html = await (await worker.fetch(new Request("https://m2m.example/"), {})).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const context = vm.createContext({});
  vm.runInContext(script.slice(0, script.indexOf("    const state =")) + ";globalThis.matcher = songMatcher;", context);
  assert.equal(context.matcher.normalizeText("ＧＵＭＩ"), "gumi");
  const match = await context.matcher.match({ name: "Song", artists: ["Artist"] }, {
    storefront: "cn", search: async () => [{ id: "song", attributes: { name: "Song", artistName: "Artist" } }]
  });
  assert.equal(match.id, "song");
});
