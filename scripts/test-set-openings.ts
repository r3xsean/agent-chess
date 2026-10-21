// Set openings: the arena's moves, the "next for this pair" pick, and what players and stats see. No server or engine needed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlayerRef } from "../shared/types";

const data = mkdtempSync(path.join(os.tmpdir(), "agent-chess-openings-"));
process.env.AGENT_CHESS_DATA = data;
const store = await import("../server/store");
const { board, createGame, playedMoves, submitTurn, ActionError } = await import("../server/game");
const { pregameBrief, turnBrief, postgameBrief } = await import("../server/briefing");
const { playerPrompt } = await import("../server/prompts");
const { reviewSide } = await import("../server/classify");
const { nextOpening, openingStats } = await import("../server/setOpenings");
const { openFor } = await import("../server/predictions");
const { gameToPgn } = await import("../server/pgn");
const { OPENINGS, openingById } = await import("../shared/openingSuite");
const { modelAnalytics, openingGrid } = await import("../server/analytics");
const { strongerChance } = await import("../shared/analytics");
const { newRules, START_FEN } = await import("../shared/rules");
const player = (model: string): PlayerRef => ({ id: `${model}@high`, model, provider: "codex", modelLabel: model, effort: "high" });
const a = player("gpt-6-astra");
const b = player("gpt-6.1-sol");

try {
  // Every line is legal from the normal start, and the ids are unique.
  assert.equal(new Set(OPENINGS.map((o) => o.id)).size, OPENINGS.length);
  for (const o of OPENINGS) {
    const c = newRules(START_FEN, "standard");
    for (const san of o.moves) assert.doesNotThrow(() => c.move(san), `${o.id}: ${san}`);
  }

  // The arena's moves are on the board before the game starts, each marked, and the right side takes over.
  for (const o of OPENINGS) {
    const g = createGame({ white: a, black: b, opening: o.id });
    assert.deepEqual(g.setOpening, { id: o.id, name: o.name, plies: o.moves.length, version: 1 });
    assert.equal(g.moves.length, o.moves.length);
    assert.ok(g.moves.every((m, i) => m.supplied && m.ply === i + 1 && m.color === (i % 2 ? "b" : "w") && m.commentary === "" && m.thinkMs === 0));
    assert.equal(playedMoves(g).length, 0);
    assert.equal(board(g).turn(), o.moves.length % 2 ? "b" : "w");
    store.games.delete(g.id);
  }
  assert.throws(() => createGame({ white: a, black: b, opening: "najdorf" }), ActionError);
  assert.throws(() => createGame({ white: a, black: b, opening: "french", chess960: 518 }), ActionError);

  // Players see the moves, never the name.
  const g = createGame({ white: a, black: b, opening: "catalan" });
  const name = openingById("catalan")!.name;
  for (const c of ["w", "b"] as const) {
    for (const text of [pregameBrief(g, c), playerPrompt(g, c)]) {
      assert.ok(text.includes("1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2"), text);
      assert.ok(!text.includes(name), "the opening's name stays out of what a player reads");
    }
  }
  g.phase = "playing";
  g.turnStartedAt = Date.now();
  const brief = turnBrief(g, "b");
  assert.ok(brief.includes("set by the arena") && brief.includes("=== YOUR MOVE ===") && !brief.includes(name), brief);

  // The players' own moves count; the arena's don't.
  submitTurn(g, "b", { move: "Be7", commentary: "Solid.", eval: "+0.2" });
  assert.equal(playedMoves(g).length, 1);
  assert.ok(!g.moves[g.moves.length - 1].supplied);
  for (const m of g.moves) m.analysis = { classification: m.supplied ? "book" : "best", winBefore: 50, winAfter: 50, accuracy: 100, cpLoss: 0, evalAfter: { cp: 20 } };
  assert.deepEqual(reviewSide(g, "b").counts, { best: 1 });
  assert.deepEqual(reviewSide(g, "w").counts, {});
  submitTurn(g, "w", { move: "Nf3", commentary: "Develop.", eval: "+0.2" });
  submitTurn(g, "b", { move: "O-O", commentary: "Castle.", eval: "+0.2" });
  g.moves.forEach((m, i) => (m.analysis = { classification: m.supplied ? "book" : "good", winBefore: 50, winAfter: 50 - (i % 3) * 7, accuracy: 100 - (i % 3) * 20, cpLoss: 0, evalAfter: { cp: 20 } }));
  // The arena's moves don't even weigh the players' moves: accuracy is as if the game began at the handover.
  for (const c of ["w", "b"] as const) assert.equal(reviewSide(g, c).accuracy, reviewSide({ ...g, moves: playedMoves(g) }, c).accuracy);
  Object.assign(g, { result: "1/2-1/2", termination: "draw agreed", phase: "postgame" });
  assert.ok(postgameBrief(g, "w").includes("set by the arena"));
  assert.ok(gameToPgn(g).includes('[SetOpening "Catalan (first 7 plies set by the arena)"]'));

  // Result calls stay open for ten moves of the players' own play.
  const live = createGame({ white: a, black: b, opening: "berlin" });
  assert.equal(openFor(live).result, true);
  store.games.delete(live.id);

  // "Next for this pair": not the one they just played with these colours, but its return game with the colours swapped.
  const first = nextOpening(a.id, b.id);
  assert.equal(nextOpening(a.id, b.id), first, "the pick is stable");
  store.games.delete(g.id);
  const played = createGame({ white: a, black: b, opening: first });
  assert.notEqual(nextOpening(a.id, b.id), first);
  assert.equal(nextOpening(b.id, a.id), first, "the colours-swapped return game comes next");
  // A pairing already planned (a tournament's) counts too.
  assert.notEqual(nextOpening(b.id, a.id, [{ white: b.id, black: a.id, opening: first }]), first);

  // The form's numbers: only finished games, seen from the seats asked about.
  const statsOf = (id: string, w?: string, bl?: string) => openingStats(w, bl).find((s) => s.id === id)!;
  assert.equal(statsOf(first, b.id, a.id).all.games, 0);
  Object.assign(played, { result: "1-0", termination: "checkmate" });
  const s = statsOf(first, b.id, a.id);
  assert.deepEqual(s.pair, { games: 1, a: 0, draws: 0, b: 1 });
  assert.deepEqual([s.players!.w.losses, s.players!.b.wins], [1, 1]);
  assert.deepEqual(s.all, { games: 1, white: 1, draws: 0, black: 0 });
  assert.equal(statsOf(first).pair, null, "a tournament's form has no seats");
  // A free game that reaches a handover position counts for that opening too.
  const free = createGame({ white: a, black: b });
  free.phase = "playing";
  for (const [c, move] of [["w", "e4"], ["b", "e6"]] as const) submitTurn(free, c, { move, commentary: "x", eval: "0" });
  Object.assign(free, { result: "1/2-1/2", termination: "draw agreed" });
  assert.deepEqual(statsOf("french", a.id, b.id).pair?.draws, 1);
  for (const x of [played, free]) store.games.delete(x.id);

  // The Agents page: "is it really stronger?", colour-swapped pairs, the openings grid, the handover comparison.
  assert.ok(Math.abs(strongerChance(1600, 60, 1600, 60) - 0.5) < 1e-6);
  assert.ok(strongerChance(1700, 50, 1500, 50) > 0.99);
  assert.ok(Math.abs(strongerChance(1650, 90, 1600, 120) + strongerChance(1600, 120, 1650, 90) - 1) < 1e-9);
  const g1 = createGame({ white: a, black: b, opening: "french" });
  g1.phase = "playing";
  submitTurn(g1, "w", { move: "d4", commentary: "x", eval: "0.3" });
  submitTurn(g1, "b", { move: "d5", commentary: "x", eval: "0.3" });
  for (const m of g1.moves) m.analysis = { classification: m.supplied ? "book" : "best", winBefore: 50, winAfter: 50, accuracy: 90, cpLoss: 0, evalAfter: { cp: 30 } };
  Object.assign(g1, { result: "1-0", termination: "checkmate", phase: "finished", endedAt: Date.now() });
  const g2 = createGame({ white: b, black: a, opening: "french" });
  Object.assign(g2, { result: "1/2-1/2", termination: "draw agreed", phase: "finished", endedAt: Date.now() + 1 });
  const astra = modelAnalytics(a.model, "all")!;
  assert.deepEqual([astra.pairs.length, astra.pairs[0].score, astra.pairs[0].start], [1, 1.5, "French"]);
  assert.deepEqual(astra.row.pairs, { played: 1, won: 1, split: 0, lost: 0 });
  assert.deepEqual(modelAnalytics(b.model, "all")!.row.pairs, { played: 1, won: 0, split: 0, lost: 1 });
  assert.equal(modelAnalytics(a.model, "all", "free")!.pairs.length, 0, "the start filter applies to pairs too");
  assert.deepEqual(astra.setOpenings.map((o) => [o.id, o.games, o.white.games, o.black.games]), [["french", 2, 1, 1]]);
  assert.equal(openingGrid("all").rows.find((r) => r.model === a.model)?.cells.french.games, 2);
  assert.deepEqual([astra.handover.set.games, astra.handover.set.moves, astra.handover.set.accuracy, astra.handover.free.moves], [2, 1, 90, 0]);
  for (const x of [g1, g2]) store.games.delete(x.id);

  console.log("PASS: set openings");
} finally {
  store.flushAll();
  // data is a freshly created directory under the OS temp directory, never the app's real data.
  rmSync(data, { recursive: true, force: true });
}
