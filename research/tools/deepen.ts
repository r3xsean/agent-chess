import { readFileSync } from "node:fs";
import path from "node:path";
import { DATA } from "../../server/paths";
import { deepenLines } from "../../server/lineDepth";

// Follow a finished game's engine lines and their branches (server/lineDepth.ts) outside the server, saving
// the analysis into its file. Restart the server afterwards so it loads it. Usage: npx tsx research/tools/deepen.ts <gameId>
const id = process.argv[2];
const g = JSON.parse(readFileSync(path.join(DATA, "games", `${id}.json`), "utf8"));
const t0 = Date.now();
const ok = await deepenLines(g);
console.log(`${id}: ${ok ? "done" : "incomplete"} in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(0);
