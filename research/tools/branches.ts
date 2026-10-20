import { readFileSync, readdirSync } from "node:fs";
import { branchCandidates, branchOptions, lineOptions, lineVerdicts } from "../../shared/engineLine";

// Which finished games' lines have branches: candidates to analyse, and options already readable from the analysis.
// Usage: npx tsx research/tools/branches.ts [gameId...]
const ids = process.argv.slice(2);
const files = ids.length ? ids.map((id) => `${id}.json`) : readdirSync("data/games");
const rows: { id: string; lines: number; hard: number; cands: number; opts: number; best: string }[] = [];
for (const f of files) {
  const g = JSON.parse(readFileSync(`data/games/${f}`, "utf8"));
  if (g.status !== "finished" && !g.result) continue;
  let lines = 0, hard = 0, cands = 0, opts = 0;
  let best = "";
  let bestScore = -1;
  g.moves.forEach((m: any, i: number) => {
    for (const sl of lineOptions(g, i)) {
      lines++;
      if (lineVerdicts(g, sl.moves).some((v) => v === "great" || v === "brilliant")) hard++;
      cands += branchCandidates(g, sl).length;
      const o = branchOptions(g, sl);
      opts += o.length;
      if (ids.length) for (const b of o) console.log(`  ply ${m.ply} ${m.san} ${sl.kind}: ${sl.moves.map((x) => x.san).join(" ")} | ${b.role} at ${b.at}: ${b.question} ${b.moves.map((x) => x.san).join(" ")} -> ${b.fact} [${Math.round(b.score)}]`);
      if (o[0] && o[0].score > bestScore) (bestScore = o[0].score), (best = `ply ${m.ply}: ${o[0].question} -> ${o[0].fact}`);
    }
  });
  rows.push({ id: g.id, lines, hard, cands, opts, best: bestScore >= 0 ? `${Math.round(bestScore)} ${best}` : "" });
}
rows.sort((a, b) => b.hard - a.hard || b.opts - a.opts);
for (const r of rows.slice(0, 40)) console.log(`${r.id} lines=${r.lines} hard=${r.hard} cands=${r.cands} opts=${r.opts} ${r.best}`);
