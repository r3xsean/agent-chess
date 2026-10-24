import assert from "node:assert/strict";
import os from "node:os";

if (process.platform !== "win32") {
  console.log("SKIP: game detection only runs on Windows");
  process.exit(0);
}

// This test runs under node.exe, so naming it makes the engine believe a game is running.
process.env.GAMING_PROCESSES = "node.exe";
process.env.GAMING_THREADS = "1";
const { Engine, EnginePool } = await import("../server/engine");
const START = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

const e = new Engine({ label: "test", depth: 10, threads: 2, hashMb: 16 });
e.start();
await new Promise((r) => setTimeout(r, 2500)); // the first tasklist check
const a = await e.analyze(START);
const internals = e as unknown as { threadsNow: number; idleNow: boolean; proc: { pid: number } };
assert.equal(a.depth, 10, "a search without a time limit reaches its depth goal, game or not");
assert.equal(internals.threadsNow, 1, "drops to GAMING_THREADS");
assert.equal(internals.idleNow, true);
assert.equal(os.getPriority(internals.proc.pid), os.constants.priority.PRIORITY_LOW, "Stockfish runs at idle priority");
e.stop();

// Review pool: everything goes to the first engine while a game runs.
const pool = new EnginePool(2, { label: "pool", depth: 6, threads: 2, hashMb: 16 });
pool.start();
const spread = (pool as unknown as { engines: { load: number }[] }).engines;
const searches = [
  "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1",
].map((f) => pool.analyze(f, "standard"));
assert.deepEqual(
  spread.map((x) => x.load),
  [2, 0],
  "while a game runs, only the first engine searches",
);
await Promise.all(searches);
pool.stop();

// Lines pool (pauseWhileGaming): background searches wait for the game to end; urgent ones go ahead.
const lines = new EnginePool(1, { label: "lines", depth: 6, threads: 2, hashMb: 16, pauseWhileGaming: true });
lines.start();
let backgroundDone = false;
const background = lines.analyze(START, "standard").then(() => (backgroundDone = true));
const urgent = await lines.analyze("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "standard", undefined, true);
assert.ok(urgent.depth >= 6, "an agent's search runs while a game does");
await new Promise((r) => setTimeout(r, 1500));
assert.equal(backgroundDone, false, "background line work waits while a game runs");
lines.stop();
void background;

console.log("PASS: while a listed game runs, searches keep their depth goal on fewer threads at idle priority, on one engine of the pool, and background line work waits");
process.exit(0);
