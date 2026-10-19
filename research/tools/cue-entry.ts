import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { quoteWords } from "../../shared/thoughtMarks";
const file = "data/games/g0x3ixb84e.json";
const g = JSON.parse(readFileSync(file, "utf8"));
mkdirSync("data/backups", { recursive: true });
copyFileSync(file, `data/backups/${g.id}-before-entry-${Date.now()}.json`);
for (const ply of [53, 81]) {
  const beat = g.video.moments.find((m: any) => m.ply === ply).line.beats[0];
  const word = quoteWords(beat.text).findIndex(w => /^rewind\b/i.test(w));
  if (word < 0) throw new Error(`No rewind word at ply ${ply}`);
  beat.enter = word;
  console.log(`Ply ${ply}: enter on word ${word} (Rewind); text unchanged.`);
}
writeFileSync(file, JSON.stringify(g, null, 1));
