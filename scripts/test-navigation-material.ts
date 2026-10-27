import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gameMaterialTimeline, materialInfo, materialTimeline } from "../shared/material";
import { newRules, START_FEN, type Variant } from "../shared/rules";

// History scrubbing must keep real captures, not infer them from missing pieces:
// en passant, promotion, and Chess960 castling are deliberately represented here.
const cases: { fen: string; moves: string[]; variant?: Variant }[] = [
  { fen: START_FEN, moves: "e4 a6 e5 d5 exd6 cxd6 Nf3 Nf6 Be2 e6 O-O".split(" ") },
  { fen: "7k/P7/8/8/8/8/7p/4K3 w - - 0 1", moves: ["a8=Q+", "Kh7", "Qh1"] },
  { fen: "4k3/8/8/8/8/8/8/RK5R w AH - 0 1", moves: ["O-O"], variant: "chess960" },
];
for (const { fen, moves, variant } of cases) {
  const timeline = materialTimeline(fen, moves, variant);
  for (let ply = moves.length; ply >= 0; ply--) {
    assert.deepEqual(timeline[ply], materialInfo(fen, moves.slice(0, ply), variant), `material at ply ${ply}`);
  }
  assert.deepEqual(timeline[0].captured, { w: [], b: [] }, "later captures cannot mutate earlier positions");
}
assert.deepEqual(materialTimeline(START_FEN, cases[0].moves)[5].captured.w, ["p"]);

// A game's own moves, read off the positions they record, give the same timeline as replaying them.
const more = [
  ...cases,
  { fen: "1n5k/P7/8/8/8/8/8/4K3 w - - 0 1", moves: ["axb8=N", "Kg7"] },
  { fen: "4k3/8/8/8/8/8/8/R4KR1 w AG - 0 1", moves: ["O-O", "Kd7"], variant: "chess960" as Variant },
  ...["marks-game.json", "director-game.json"].map((f) => {
    const g = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", f), "utf8"));
    return { fen: g.moves[0]?.fenBefore ?? START_FEN, moves: g.moves.map((m: { san: string }) => m.san), variant: g.variant as Variant | undefined };
  }),
];
for (const { fen, moves, variant } of more) {
  const c = newRules(fen, variant);
  const records = moves.map((san) => {
    const fenBefore = c.fen();
    const mv = c.move(san);
    return { color: mv.color, from: mv.from, to: mv.to, fenBefore, fenAfter: c.fen() };
  });
  assert.deepEqual(gameMaterialTimeline(fen, records), materialTimeline(fen, moves, variant), `game timeline: ${moves.join(" ")}`);
}
console.log("Navigation material: captures, en passant, promotions, Chess960, and backward scrubbing passed.");
