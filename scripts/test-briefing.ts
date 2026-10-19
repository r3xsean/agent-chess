// Isolated regression checks: no running server, models, or engine required.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Game, MoveRecord, PlayerRef } from "../shared/types";

const data = mkdtempSync(path.join(os.tmpdir(), "agent-chess-briefing-"));
process.env.AGENT_CHESS_DATA = data;
const store = await import("../server/store");
const { createGame } = await import("../server/game");
const { asciiBoard, briefingFen, pregameBrief, turnBrief, postgameBrief } = await import("../server/briefing");
const { newRules, START_FEN, chess960Fen } = await import("../shared/rules");
const player = (model: string): PlayerRef => ({ id: `${model}@high:none`, model, provider: "codex", modelLabel: model, effort: "high", personality: "none" });
const white = player("gpt-6-astra");
const black = player("gpt-6.1-sol");
const makeGame = (learning = true) => createGame({ white, black, broadcaster: null, learning });

try {
  store.writeLessons(white.model, "Original white lesson", null);
  store.writeLessons(black.model, "Original black lesson", null);
  const g = makeGame();
  assert.equal(g.lessonsAtStart?.w.version, 1);
  store.writeLessons(white.model, "Replacement white lesson", null);
  store.writeLessons(black.model, "", null);
  for (const color of ["w", "b"] as const) {
    const expected = color === "w" ? "Original white lesson" : "Original black lesson";
    assert.ok(pregameBrief(g, color).includes(expected));
    assert.ok(turnBrief(g, color).includes(expected));
  }
  assert.ok(!turnBrief(g, "w").includes("Replacement white lesson"));
  const next = makeGame();
  assert.equal(next.lessonsAtStart?.w.text, "Replacement white lesson");
  assert.equal(next.lessonsAtStart?.b.text, "");
  store.writeLessons(black.model, "Later black lesson", null);
  assert.ok(!turnBrief(next, "b").includes("Later black lesson"), "empty snapshots stay empty");
  const off = makeGame(false);
  assert.equal(off.lessonsAtStart, undefined);
  assert.ok(!pregameBrief(off, "w").includes("Replacement white lesson"));

  store.flushAll();
  store.games.clear();
  store.loadAll();
  assert.deepEqual(store.games.get(g.id)?.lessonsAtStart, g.lessonsAtStart, "restart preserves snapshots");
  const legacy = { ...g, id: "legacy-brief-test" };
  delete legacy.lessonsAtStart;
  store.saveGameNow(legacy);
  store.loadAll();
  const migrated = store.games.get(legacy.id)!;
  assert.equal(migrated.lessonsAtStart?.w.text, "Replacement white lesson");
  assert.deepEqual(JSON.parse(readFileSync(path.join(data, "games", `${legacy.id}.json`), "utf8")).lessonsAtStart, migrated.lessonsAtStart);
  store.writeLessons(white.model, "Yet another lesson", null);
  store.loadAll();
  assert.equal(store.games.get(legacy.id)?.lessonsAtStart?.w.text, "Replacement white lesson");

  for (const variant of ["standard", "chess960"] as const) {
    const cases = [
      ["k3r3/3p4/8/4P3/8/8/8/4K3 b - - 0 1", "d5", "d6"], // pinned: no legal ep
      ["k4r2/3p4/8/4P3/8/8/8/4K3 b - - 0 1", "d5", "d6"], // legal ep
      ["4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "e4", "e3"], // no capturer
      ["4k3/8/8/8/8/8/R7/4K3 w - - 0 1", "Ra4", "-"], // rook moving two ranks
    ];
    for (const [startFen, move, ep] of cases) {
      const c = newRules(startFen, variant);
      const played = c.move(move);
      const raw = c.fen();
      const sample = { ...g, id: `${variant}-${move}-${startFen}`, variant, startFen,
        moves: [{ ...played, ply: 1, fenBefore: played.before, fenAfter: played.after } as MoveRecord] };
      const shown = briefingFen(sample, raw).split(" ");
      assert.equal(shown[3], ep);
      assert.deepEqual(shown.filter((_, i) => i !== 3), raw.split(" ").filter((_, i) => i !== 3));
      assert.equal(c.fen(), raw, "display never mutates rules");
      assert.ok(turnBrief(sample, "w").includes(`FEN: ${shown.join(" ")}`));
      const reply = c.move(c.moves()[0].san);
      sample.moves.push({ ...reply, ply: 2, fenBefore: reply.before, fenAfter: reply.after } as MoveRecord);
      assert.equal(briefingFen(sample, c.fen()).split(" ")[3], "-", "target expires next move");
    }
    const c = newRules(variant === "standard" ? START_FEN : chess960Fen(42), variant);
    const sample = { ...g, id: `history-${variant}`, variant, startFen: c.fen(), moves: [] as MoveRecord[] };
    for (const move of ["e4", "e5", "d4"]) {
      const m = c.move(move);
      sample.moves.push({ ...m, ply: sample.moves.length + 1, fenBefore: m.before, fenAfter: m.after } as MoveRecord);
    }
    const brief = turnBrief(sample, "b");
    assert.ok(brief.includes("1. e4 e5 2. d4"));
    assert.ok(brief.includes(asciiBoard(c.fen(), "w")));
  }

  const review: Game = { ...g, result: "1-0", phase: "postgame", termination: "test", moves: [{
    ply: 2, color: "b", san: "e5", from: "e7", to: "e5", fenBefore: START_FEN,
    fenAfter: START_FEN, commentary: "test", analysis: { classification: "blunder", winBefore: 50, winAfter: 10, evalAfter: { cp: 100 } },
  } as MoveRecord] };
  const post = postgameBrief(review, "b");
  assert.ok(post.includes("White at the bottom in every diagram"));
  assert.ok(post.includes(asciiBoard(START_FEN, "w")));
  assert.ok(!post.includes(asciiBoard(START_FEN, "b")));
  assert.ok(post.includes("Later black lesson"), "postgame rewriting still gets latest shared lessons");
  console.log("PASS: lesson isolation, restart migration, display-only en passant, history, and postgame orientation");
} finally {
  store.flushAll();
  // data is a freshly created directory under the OS temp directory, never the app's real data.
  rmSync(data, { recursive: true, force: true });
}
