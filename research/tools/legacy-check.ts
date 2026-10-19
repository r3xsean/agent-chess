import { readdirSync, readFileSync } from "node:fs";
import { shownLine } from "../../shared/engineLine";
import { shownLine as headLine } from "../../shared/_engineLineHead";
let checked = 0, diff = 0;
for (const f of readdirSync("data/games").filter((x) => x.endsWith(".json"))) {
  const g = JSON.parse(readFileSync(`data/games/${f}`, "utf8"));
  for (const x of g.video?.moments ?? []) {
    if (!x.line) continue;
    const i = g.moves.findIndex((m: any) => m.ply === x.ply);
    const a = shownLine(g, i, x.line.kind, !x.line.deep);
    const b = headLine(g, i, x.line.kind);
    checked++;
    const sig = (l: any) => JSON.stringify(l && { m: l.moves.map((mv: any) => mv.san), p: l.punish?.moves.map((mv: any) => mv.san), f: l.fact });
    if (sig(a) !== sig(b)) { diff++; console.log("DIFF", g.id, x.ply, sig(a), sig(b)); }
  }
}
console.log(`saved plan lines checked: ${checked}, changed: ${diff}`);
