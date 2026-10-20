import { readFileSync } from "node:fs";
import { branchOptions, lineVerdicts, planBranch, planLine, shownLine } from "../../shared/engineLine";
import { moveFacts } from "../../shared/lineFacts";
import { formatScore } from "../../shared/evalmath";

// A directed game's engine lines as planned: moves with badges and facts, beats, branches chosen and on offer.
// Usage: npx tsx research/tools/plan-lines.ts <gameId> [ply...]
const g = JSON.parse(readFileSync(`data/games/${process.argv[2]}.json`, "utf8"));
const only = process.argv.slice(3).map(Number);
const steps = (moves: any[]) => {
  const vs = lineVerdicts(g, moves);
  return moves.map((mv, k) => `    ${k + 1}. ${mv.san}${vs[k] ? ` [${vs[k]}]` : ""} (${moveFacts(mv)}) ${formatScore(g.analysis[mv.after]?.score)}`).join("\n");
};
for (const x of g.video.moments) {
  if (!x.line || (only.length && !only.includes(x.ply))) continue;
  const i = g.moves.findIndex((m: any) => m.ply === x.ply);
  const m = g.moves[i];
  const sl = planLine(g, i, x.line)!;
  const full = shownLine(g, i, x.line.kind, !x.line.deep, true)!;
  console.log(`\n## ply ${x.ply} ${m.san} (${m.analysis.classification}) "${x.line.kind}" first=${!!x.line.first}: ${full.fact}\nwhy: ${x.why}\nquote: ${x.thought ?? ""}`);
  console.log(steps(sl.moves));
  for (const b of x.line.beats ?? []) console.log(`  beat@${b.at}${b.cues ? ` cues ${JSON.stringify(b.cues.map((c: any) => c.moves))}` : ""}: ${b.text}`);
  for (const b of x.line.branches ?? []) {
    const br = planBranch(g, sl, b)!;
    console.log(`  BRANCH ${b.when} at ${b.at}: ${br.question} -> ${br.fact}\n${steps(br.moves)}`);
    for (const bb of b.beats ?? []) console.log(`    beat@${bb.at}: ${bb.text}`);
  }
  console.log("  offered:");
  for (const o of branchOptions(g, full)) console.log(`    [${Math.round(o.score)}] ${o.role} at ${o.at} ${o.moves.map((mv) => mv.san).join(" ")}: ${o.question} -> ${o.fact}`);
}
