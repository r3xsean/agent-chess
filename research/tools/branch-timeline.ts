import { readFileSync } from "node:fs";
import { buildTimeline, sfxCues } from "../../web/src/video/timeline";
import { planLine, planBranch } from "../../shared/engineLine";
import { trackAt } from "../../web/src/video/linePlayback";

// A directed game's line scenes with branches, as the timeline builds them: the board path step by step.
// Usage: npx tsx research/tools/branch-timeline.ts <gameId>
const g = JSON.parse(readFileSync(`data/games/${process.argv[2]}.json`, "utf8"));
for (const format of ["landscape", "portrait"] as const) {
  const tl = buildTimeline(g, format);
  sfxCues(tl, g);
  console.log(`== ${format}: ${Math.round(tl.duration)} s`);
  for (const s of tl.scenes) {
    if (s.kind !== "line" || !s.steps) continue;
    const ask = g.video.moments.find((x: any) => x.ply === g.moves[s.i].ply).line;
    const sl = planLine(g, s.i, ask)!;
    const paths = [sl.moves, ...(ask.branches ?? []).map((b: any) => { const br = planBranch(g, sl, b); return br ? [...sl.moves.slice(0, br.at), ...br.moves] : []; })];
    console.log(`ply ${g.moves[s.i].ply}: ${s.dur.toFixed(1)} s, back ${s.back.map((x) => x.toFixed(1)).join("-")} from ${JSON.stringify(s.backFrom)}`);
    for (const st of s.steps) console.log("  ", "end" in st ? `${st.at.toFixed(2)} rewind seg ${st.seg} ${st.from}->${st.to}` : `${st.at.toFixed(2)} seg ${st.seg} k=${st.k}${st.hold ? " hold" : ""} ${paths[st.seg + 1][st.k - 1]?.san ?? ""}`);
    for (const b of s.beats ?? []) console.log(`   beat ${b.at.toFixed(1)}-${b.end.toFixed(1)}: ${b.text.slice(0, 60)}`);
    // The board at every tenth of a second resolves to a legal path position.
    for (let t = 0; t < s.dur; t += 0.1) {
      const T = trackAt(s.steps, paths, t);
      if (T.count > paths[T.seg + 1].length) throw new Error(`bad count at ${t}`);
    }
  }
}
