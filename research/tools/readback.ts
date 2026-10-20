import { readFileSync } from "node:fs";
import { narratedReadback } from "../../server/director";
// The narration readback of a game's saved plan. Usage: npx tsx research/tools/readback.ts <gameId>
const g = JSON.parse(readFileSync(`data/games/${process.argv[2]}.json`, "utf8"));
console.log(narratedReadback(g, g.video).join("\n"));
process.exit(0);
