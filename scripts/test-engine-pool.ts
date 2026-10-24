import assert from "node:assert/strict";

// No game watched, so the pool runs at full width.
process.env.GAMING_PROCESSES = "";
const { EnginePool } = await import("../server/engine");

const pool = new EnginePool(2, { label: "test", depth: 8, threads: 1, hashMb: 16 });
pool.start();
const engines = (pool as unknown as { engines: { load: number }[] }).engines;
const fens = [
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2",
];
const done = fens.map((f) => pool.analyze(f, "standard"));
assert.deepEqual(
  engines.map((e) => e.load),
  [2, 2],
  "searches spread over both engines",
);
const results = await Promise.all(done);
assert.ok(results.every((a) => a.depth === 8 && a.bestUci), "every search finishes at its depth goal");
assert.deepEqual(
  engines.map((e) => e.load),
  [0, 0],
);

// Searches queued behind a running one on the first engine: the idle engine takes them.
const first = engines[0] as unknown as { analyze: (f: string) => Promise<unknown> };
const queuedBehind = fens.slice(0, 3).map((f) => first.analyze(f));
assert.deepEqual(engines.map((e) => e.load), [3, 0]);
(engines[1] as unknown as { kick: () => void }).kick();
assert.deepEqual(engines.map((e) => e.load), [2, 1], "an idle engine takes a search queued on a busy one");
await Promise.all(queuedBehind);
pool.stop();
console.log("PASS: the game-review pool spreads searches over its engines, idle engines take queued ones, and all finish");
process.exit(0);
