// The board picture (server/boardImage.ts) drawn with its own two fonts comes out byte for byte as it did with
// every system font loaded, across codes, positions, check, last moves and Chess960; and faster.
//   node node_modules/tsx/dist/cli.mjs scripts/test-board-image.ts
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { boardSvg, renderPng } from "../server/boardImage";
import { chess960Fen, START_FEN } from "../shared/rules";

const systemFonts = (svg: string) => new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
const cases: [string, "w" | "b", string, { from: string; to: string }?][] = [
  [START_FEN, "w", "ACD"],
  [START_FEN, "b", "EFH"],
  ["rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "w", "JKM", { from: "e7", to: "e5" }],
  ["rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3", "w", "NPR", { from: "d8", to: "h4" }],
  ["8/P7/8/8/8/8/8/k6K w - - 0 1", "w", "TVW"],
  ["Q7/8/8/8/8/8/8/k6K b - - 0 1", "b", "XY3", { from: "a7", to: "a8" }],
  ["r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1", "w", "479", { from: "e1", to: "g1" }],
  [chess960Fen(0), "w", "AYW"],
  [chess960Fen(959), "b", "7KD"],
  ["4k3/8/8/8/8/8/4q3/4K3 w - - 0 1", "w", "MMM", { from: "e8", to: "e2" }],
];
let fast = 0;
let slow = 0;
for (const [fen, side, code, last] of cases) {
  const svg = boardSvg(fen, side, code, last);
  let t = performance.now();
  const want = systemFonts(svg);
  slow += performance.now() - t;
  t = performance.now();
  const got = renderPng(svg);
  fast += performance.now() - t;
  assert.ok(Buffer.compare(got, want) === 0, `picture differs: ${fen} ${side} ${code}`);
}
console.log(`${cases.length} pictures identical — system fonts ${(slow / cases.length).toFixed(0)} ms each, own fonts ${(fast / cases.length).toFixed(0)} ms each`);
console.log("ok");
