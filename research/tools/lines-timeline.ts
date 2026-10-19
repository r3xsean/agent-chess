import { readFileSync } from "node:fs";
import { buildTimeline } from "../../web/src/video/timeline";
const g = JSON.parse(readFileSync("data/games/g0x3ixb84e.json", "utf8"));
const tl = buildTimeline(g, "landscape", {});
for (const s of tl.scenes) if (s.kind === "line") console.log(`line i=${s.i} ply=${g.moves[s.i].ply} ${s.line}${s.first ? " first" : ""} start=${s.start.toFixed(1)} dur=${s.dur.toFixed(1)} moves=${s.sans.join(" ")} verdicts=${s.verdicts.join(",")} beats=${(s.beats ?? []).map((b) => b.at.toFixed(1)).join("/")}`);
console.log("narration cues:", tl.asides.filter((a) => a.narrator).length, "duration", tl.duration.toFixed(0));
