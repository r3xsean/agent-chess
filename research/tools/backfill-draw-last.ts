import { readFileSync, writeFileSync } from "node:fs";
import { phraseAt, phraseEnd } from "../../shared/thoughtMarks";
const file = "data/games/g0x3ixb84e.json";
const g = JSON.parse(readFileSync(file, "utf8"));
const raw = JSON.parse(readFileSync("data/agents/g0x3ixb84e/d/plan.json", "utf8"));
let fixed = 0;
for (const x of g.video.moments) {
  const beats = x.line?.beats;
  if (!beats) continue;
  const rawBeats = raw.moments.find((m: any) => Number(m.ply) === x.ply)?.line?.beats ?? [];
  beats.forEach((b: any, n: number) => {
    (b.draw ?? []).forEach((d: any, j: number) => {
      const phrase = String(rawBeats[n]?.draw?.[j]?.words ?? "");
      if (!phrase || phraseAt(b.text, phrase) < 0) return console.log(`skip ply ${x.ply} beat ${n} draw ${j}`);
      d.last = phraseEnd(b.text, phrase, d.word);
      fixed++;
      console.log(`ply ${x.ply} beat ${n}: "${phrase}" -> words ${d.word}..${d.last}`);
    });
  });
}
writeFileSync(file, JSON.stringify(g, null, 2));
console.log(`fixed ${fixed} drawings`);
