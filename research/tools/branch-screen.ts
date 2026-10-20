import { readFileSync, readdirSync } from "node:fs";
import { branchCandidates, lineOptions } from "../../shared/engineLine";

// A cheap pre-screen for games whose lines could carry branches, before the engine follows any: big swings,
// brilliant/great/miss moves, and players' own calculations that leave a line (feared candidates).
const rows: { id: string; score: number; note: string }[] = [];
for (const f of readdirSync("data/games")) {
  const g = JSON.parse(readFileSync(`data/games/${f}`, "utf8"));
  if (!g.result || g.moves.length < 20) continue;
  let score = 0;
  const notes: string[] = [];
  g.moves.forEach((m: any, i: number) => {
    const a = m.analysis;
    if (!a || a.unavailable) return;
    for (const sl of lineOptions(g, i)) {
      const swing = sl.kind === "instead" ? a.winBefore - a.winAfter : 100 - a.winAfter - (g.moves[i + 1]?.analysis?.winAfter ?? 100 - a.winAfter);
      if (swing < 30) continue;
      const c = branchCandidates(g, sl);
      const feared = c.filter((x) => x.role === "feared").length;
      const s = swing / 10 + feared * 3 + (["brilliant", "great", "miss"].includes(a.classification) ? 4 : 0) + (sl.moves.length >= 4 ? 2 : 0);
      score += s;
      if (s > 8) notes.push(`ply ${m.ply} ${m.san} (${a.classification}) ${sl.kind} swing ${Math.round(swing)} feared ${feared}`);
    }
  });
  rows.push({ id: g.id, score: Math.round(score), note: `${g.white.model} v ${g.black.model} ${g.result} video=${!!g.video} | ${notes.slice(0, 3).join("; ")}` });
}
rows.sort((a, b) => b.score - a.score);
for (const r of rows.slice(0, 15)) console.log(r.id, r.score, r.note);
