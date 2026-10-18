import assert from "node:assert/strict";
import { materialInfo, materialTimeline } from "../shared/material";
import { START_FEN, type Variant } from "../shared/rules";

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
console.log("Navigation material: captures, en passant, promotions, Chess960, and backward scrubbing passed.");
