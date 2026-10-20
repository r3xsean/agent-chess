import { readFileSync } from "node:fs";
import { probeCommand } from "../../server/probe";
// Ask a game's engine questions outside the server (nothing saved unless the game is saved). Usage: npx tsx research/tools/probe-try.ts <gameId> <cmd> <args...>
const [id, cmd, ...args] = process.argv.slice(2);
const g = JSON.parse(readFileSync(`data/games/${id}.json`, "utf8"));
console.log(await probeCommand(g, cmd, args));
process.exit(0);
