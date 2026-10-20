import { readFileSync } from "node:fs";
import { shownLine, type LineKind } from "../../shared/engineLine";
import { questionLines } from "../../server/lineQuestions";
// The questions a game's lines raise, as the briefs list them. Usage: npx tsx research/tools/questions.ts <gameId> <ply><a|i> [...]
const [id, ...specs] = process.argv.slice(2);
const g = JSON.parse(readFileSync(`data/games/${id}.json`, "utf8"));
for (const s of specs) {
  const [, ply, k] = /^(\d+)([ai])$/.exec(s)!;
  const i = g.moves.findIndex((m: any) => m.ply === Number(ply));
  const sl = shownLine(g, i, (k === "a" ? "after" : "instead") as LineKind, false, true);
  console.log(`\n## ${s}: ${sl ? sl.moves.map((m) => m.san).join(" ") + " → " + sl.fact : "no line"}`);
  if (sl) console.log(questionLines(g, sl, 10).join("\n"));
}
process.exit(0);
