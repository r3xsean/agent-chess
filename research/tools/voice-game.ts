import { readFileSync } from "node:fs";
import { voiceGame, spokenText } from "../../server/voice";
import { videoLines, lineVoice } from "../../shared/videoLines";
const g = JSON.parse(readFileSync("data/games/g0x3ixb84e.json", "utf8"));
const lines = videoLines(g).filter((l) => lineVoice(g, l));
const chars = lines.reduce((n, l) => n + spokenText(l.text, l.delivery).length, 0);
console.log(`lines to voice: ${lines.length} (${lines.filter((l) => l.narrator).length} narrator), about ${chars} characters`);
const r = await voiceGame(g, (d, t) => process.stdout.write(`\r${d}/${t}`));
console.log("\n", r);
