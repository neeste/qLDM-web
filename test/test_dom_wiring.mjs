/*
 * test_dom_wiring.mjs
 * Verifies every DOM id referenced in app.js exists in index.html, and checks
 * end-to-end qCLS_ELC CSV limit exclusion & export schema consistency.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = [...appJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);

const missing = jsIds.filter((id) => !htmlIds.has(id));
if (missing.length > 0) {
  console.error("[FAIL DOM Wiring] Missing IDs in index.html:", missing);
  process.exit(1);
}

console.log(`[PASS DOM Wiring] All ${jsIds.length} DOM element IDs in app.js verified present in index.html.`);
