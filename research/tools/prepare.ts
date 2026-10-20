import { readFileSync } from "node:fs";
import path from "node:path";
import { DATA } from "../../server/paths";
import { shownLine } from "../../shared/engineLine";
import { prepareLines } from "../../server/lineDepth";
// Work out the questions' evidence and branches for given lines of a game, saving them into its file. Usage: npx tsx research/tools/prepare.ts <gameId> <ply><a|i> [...]
const [id, ...specs] = process.argv.slice(2);
const g = JSON.parse(readFileSync(path.join(DATA, "games", `${id}.json`), "utf8"));
const lines = specs.flatMap((s) => {
  const [, ply, k] = /^(\d+)([ai])$/.exec(s)!;
  const sl = shownLine(g, g.moves.findIndex((m: any) => m.ply === Number(ply)), k === "a" ? "after" : "instead", false, true);
  return sl ? [sl] : [];
});
await prepareLines(g, lines);
console.log("prepared", lines.length);
process.exit(0);
