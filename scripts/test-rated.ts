// An unrated game moves no rating and no leaderboard record; rated games around it rate as if it never happened.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CHESS_DATA = mkdtempSync(path.join(tmpdir(), "agent-chess-rated-"));
const { games, players } = await import("../server/store");
const { rebuildRatings } = await import("../server/game");

let ok = true;
const fail = (msg: string) => ((ok = false), console.log("FAIL", msg));
const a = { id: "opus@high:none", model: "opus", provider: "claudeAgent", modelLabel: "Opus", effort: "high", personality: "none" } as any;
const b = { id: "sol@high:none", model: "sol", provider: "codex", modelLabel: "Sol", effort: "high", personality: "none" } as any;
let n = 0;
const game = (result: string, rated?: boolean) => {
  const g = { id: `g${n}`, createdAt: n, endedAt: ++n, white: a, black: b, result, moves: [], options: rated === undefined ? undefined : { rated } } as any;
  games.set(g.id, g);
  return g;
};

game("1-0");
rebuildRatings();
const after1 = { ...players[a.id] };

const casual = game("0-1", false);
rebuildRatings();
const after2 = players[a.id];
if (after2.rating !== after1.rating || after2.rd !== after1.rd) fail(`unrated game moved the rating: ${after1.rating} → ${after2.rating}`);
if (after2.games !== 1 || after2.losses !== 0) fail(`unrated game counted on the leaderboard: ${after2.games} games, ${after2.losses} losses`);
if (casual.ratingBefore || casual.ratingChange) fail("unrated game was given a rating change");

const rated = game("0-1", true);
rebuildRatings();
if (!rated.ratingChange || players[a.id].games !== 2) fail("a game marked rated should be rated");

console.log(ok ? "ok" : "failed");
process.exit(ok ? 0 : 1);
