// Ranks finished games as showcases for the narrated engine lines: voiced players, big verdicts, illegal tries, interviews.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const voiced = /^(claude-(opus|fable|sonnet|haiku)\b|gpt-[\d.]+-(sol|astra|luna)$)/;
const rows = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  let g;
  try {
    g = JSON.parse(readFileSync(join(dir, f), "utf8"));
  } catch {
    continue;
  }
  if (g.phase !== "finished" || !g.review || !g.moves?.length) continue;
  const n = (c) => g.moves.filter((m) => m.analysis?.classification === c).length;
  const both = [g.white, g.black].every((p) => p.provider !== "human" && voiced.test(p.model));
  const illegal = g.moves.reduce((s, m) => s + (m.illegalAttempts?.length ?? 0), 0);
  const interviews = ["pre", "post"].reduce((s, w) => s + ["w", "b"].filter((c) => g.interviews?.[w]?.[c]).length, 0);
  const score = (both ? 10 : 0) + n("brilliant") * 4 + n("great") * 2 + n("blunder") * 2 + n("miss") * 2 + n("mistake") + Math.min(illegal, 3) + interviews + (g.moves.length > 40 && g.moves.length < 140 ? 3 : 0);
  rows.push({
    id: g.id,
    w: `${g.white.model}/${g.white.personality}`,
    b: `${g.black.model}/${g.black.personality}`,
    res: `${g.result} ${g.termination}`,
    plies: g.moves.length,
    bril: n("brilliant"),
    great: n("great"),
    blun: n("blunder"),
    miss: n("miss"),
    mist: n("mistake"),
    illegal,
    iv: interviews,
    planned: !!g.video,
    score,
  });
}
rows.sort((a, b) => b.score - a.score);
console.table(rows.slice(0, 15));
