import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const result = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ["src/matching.js"],
  bundle: true,
  format: "iife",
  globalName: "M2MSongMatcher",
  platform: "browser",
  target: "es2022",
  minify: true,
  charset: "utf8",
  legalComments: "inline",
  write: false
});
const notices = await Promise.all(["LICENSE", "THIRD_PARTY_LICENSES.md"].map(filename =>
  readFile(new URL("node_modules/opencc-js/" + filename, root), "utf8")));
const source = (result.outputFiles[0].text + "\n/*\n" + notices.join("\n\n").replace(/\*\//g, "* /") + "\n*/\n")
  .replace(/<\/script/gi, "<\\/script");
const output = "export const MATCHER_BROWSER_SOURCE = " + JSON.stringify(source) + ";\n";
const destination = new URL("dist/matcher-source.js", root);
await mkdir(new URL("dist/", root), { recursive: true });
let previous;
try {
  previous = await readFile(destination, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (output !== previous) await writeFile(destination, output);
console.log("Browser matcher built (" + Buffer.byteLength(source) + " bytes).");
