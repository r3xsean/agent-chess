import { readFileSync } from "node:fs";
import { buildTimeline, LINE_SLIDE } from "../../web/src/video/timeline";
import { lineVerdicts, planLine } from "../../shared/engineLine";
const g = JSON.parse(readFileSync("data/games/g0x3ixb84e.json", "utf8"));
const tl = buildTimeline(g, "landscape", {});
for (const s of tl.scenes) if (s.kind === "line") {
  const x = g.video.moments.find((m: any) => m.ply === g.moves[s.i].ply);
  const sl = planLine(g, s.i, x.line)!;
  const v = lineVerdicts(g, sl.moves);
  console.log(`ply ${g.moves[s.i].ply} (${s.dur.toFixed(1)} s):`, s.sans.map((san, k) => `${san}${v[k] && v[k] !== "best" ? `(${v[k]})` : ""} alone ${(((s.moveAt[k + 1] ?? s.dur) - s.moveAt[k] - LINE_SLIDE)).toFixed(1)}s`).join(", "));
}
