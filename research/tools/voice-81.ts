import { readFileSync } from "node:fs";
import { voiceGame, spokenText } from "../../server/voice";
import { videoLines } from "../../shared/videoLines";
const g = JSON.parse(readFileSync("data/games/g0x3ixb84e.json", "utf8"));
const only = (id: string) => id.startsWith("beat:81:");
const chars = videoLines(g).filter((l) => only(l.id)).reduce((n, l) => n + spokenText(l.text, l.delivery).length, 0);
console.log(`narrator lines for 41.Nf4: about ${chars} characters`);
const r = await voiceGame(g, undefined, only);
console.log(JSON.stringify(r));
