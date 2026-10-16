// Renders the brand SVGs to PNG: node branding/render.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["icon", "banner"]) {
  const svg = readFileSync(path.join(dir, `${name}.svg`), "utf8");
  const png = new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
  writeFileSync(path.join(dir, `${name}.png`), png);
  console.log(`${name}.png`, png.length, "bytes");
}
