// Simulates a multi-board tournament: every pairing gets played, the board limit holds, and no model
// is ever in two unfinished games (counting a game outside the tournament).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENT_CHESS_DATA = mkdtempSync(path.join(tmpdir(), "agent-chess-boards-"));
const { games, tournaments } = await import("../server/store");
const { startablePairings } = await import("../server/game");
const { roundRobin } = await import("../server/schedule");

let ok = true;
const fail = (msg: string) => ((ok = false), console.log("FAIL", msg));
const models = ["opus", "sonnet", "haiku", "fable", "sol", "astra", "luna"];
const refs = models.map((m) => ({ id: `${m}@high:none`, model: m }) as any);
let n = 0;
const fakeGame = (white: any, black: any) => {
  const g = { id: `fake${n++}`, phase: "playing", white, black } as any;
  games.set(g.id, g);
  return g;
};

for (let trial = 0; trial < 50; trial++) {
  games.clear();
  const t = { id: "t", players: refs, pairings: roundRobin(refs.map((r) => r.id), true), boards: 3, status: "running" } as any;
  tournaments.set(t.id, t);
  // A casual game keeps Opus busy at the start.
  const outside = fakeGame(refs[0], { id: "human:human", model: "human", provider: "human" });
  for (let step = 0; step < 500; step++) {
    for (const p of startablePairings(t)) p.gameId = fakeGame(refs.find((r) => r.id === p.white), refs.find((r) => r.id === p.black)).id;
    const live = [...games.values()].filter((g) => g.phase !== "finished");
    const liveT = t.pairings.filter((p: any) => p.gameId && games.get(p.gameId)!.phase !== "finished");
    if (liveT.length > 3) fail(`trial ${trial}: ${liveT.length} boards live`);
    const seen = new Set<string>();
    for (const g of live)
      for (const p of [g.white, g.black]) {
        if (p.model === "human") continue;
        if (seen.has(p.model)) fail(`trial ${trial}: ${p.model} in two games`);
        seen.add(p.model);
      }
    if (!live.length) break;
    live[Math.floor(Math.random() * live.length)].phase = "finished";
  }
  if (outside.phase !== "finished") fail(`trial ${trial}: outside game never finished`);
  const left = t.pairings.filter((p: any) => !p.gameId).length;
  if (left) fail(`trial ${trial}: ${left} pairings never started`);
}

// One board keeps the old behaviour: one game at a time, regardless of other games.
games.clear();
const single = { id: "s", players: refs, pairings: roundRobin(refs.map((r) => r.id), false), status: "running" } as any;
fakeGame(refs[0], refs[1]);
const first = startablePairings(single);
if (first.length !== 1 || first[0] !== single.pairings[0]) fail("single board should start the first pairing");
first[0].gameId = fakeGame(refs[0], refs[1]).id;
if (startablePairings(single).length) fail("single board should wait for its live game");

console.log(ok ? "ok" : "failed");
process.exit(ok ? 0 : 1);
