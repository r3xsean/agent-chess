// Checks how replay videos draw and light up a player's thinking (shared/thoughtMarks.ts, server/director.ts),
// on positions from a real game: each case is a mistake the videos once made. Run: npx tsx scripts/test-marks.ts
import { readFileSync } from "node:fs";
import { checkedMarks } from "../server/director";
import { markColors, pointsAt, quoteWords, refProblems, sentenceEnd } from "../shared/thoughtMarks";
import type { Color, Game, ThoughtMark } from "../shared/types";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/marks-game.json", import.meta.url), "utf8"));
const g = { id: "test", moves: fixture.moves } as unknown as Game;
const moveOf = (ply: number) => g.moves.find((m) => m.ply === ply)!;
const fensOf = (ply: number) => {
  const i = g.moves.findIndex((m) => m.ply === ply);
  const m = g.moves[i];
  return [m.fenBefore, m.fenAfter, ...g.moves.slice(Math.max(0, i - 10), i).reverse().map((x) => x.fenBefore)];
};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
};

/** Each lit word of a quote with its colour, from the speaker's side: G(reen), R(ed) or A(mber). */
function lit(ply: number, quote: string, marks: ThoughtMark[]): Map<string, string> {
  const m = moveOf(ply);
  const ws = quoteWords(quote);
  const out = new Map<string, string>();
  const tone = (c?: Color) => (!c ? "A" : c === m.color ? "G" : "R");
  markColors(quote, marks, fensOf(ply), m.color).forEach((mk) => {
    for (const r of mk.refs) out.set(ws.slice(r.words[0], r.words[1] + 1).join(" "), tone(r.color));
    for (const it of [...mk.arrows, ...mk.rings]) for (const l of it.lit) out.set(ws[l.word], tone(l.color));
  });
  return out;
}

function expectLit(name: string, ply: number, quote: string, raw: unknown, want: Record<string, string>) {
  let marks: ThoughtMark[] | undefined;
  try {
    marks = checkedMarks(g, ply, quote, raw);
  } catch (e: any) {
    return check(name, false, `rejected: ${e.message}`);
  }
  const got = lit(ply, quote, marks ?? []);
  const wrong = Object.entries(want).filter(([w, c]) => got.get(w) !== c);
  check(name, !wrong.length, wrong.map(([w, c]) => `"${w}" should be ${c}, is ${got.get(w) ?? "unlit"}`).join("; "));
}

function expectRejected(name: string, ply: number, quote: string, raw: unknown, mentions: string) {
  try {
    checkedMarks(g, ply, quote, raw);
    check(name, false, "was accepted");
  } catch (e: any) {
    check(name, e.message.includes(mentions), `rejected, but not for "${mentions}": ${e.message}`);
  }
}

// 74, Opus (Black): a line, then attacks drawn from where the pieces land; every word in its own side's colour.
const q74 = "...f6! is the only good move: after Rxe8+ Kf7 the king attacks the rook while my Rd6 attacks the Nd7, and White can't save both.";
const m74 = [
  { at: "...f6! is the only good move", arrows: ["f6"], refs: [{ words: "...f6!", to: "f6" }] },
  {
    at: "after Rxe8+ Kf7",
    arrows: ["Rxe8+", "Kf7", { draw: "f7>e8", at: "the king attacks the rook" }, { draw: "d6>d7", at: "my Rd6 attacks the Nd7" }],
    refs: [
      { words: "Rxe8+", to: "Rxe8+" },
      { words: "Kf7", to: "Kf7" },
      { words: "king", to: "f7" },
      { words: "rook", to: "e8" },
      { words: "Rd6", to: "d6" },
      { words: "Nd7", to: "d7" },
    ],
  },
];
expectLit("a word is in the colour of whose piece it names, not of the arrow (Nd7 red)", 74, q74, m74, {
  "...f6!": "G",
  "Rxe8+": "R",
  Kf7: "G",
  king: "G",
  rook: "R",
  Rd6: "G",
  "Nd7,": "R",
});

// 75, Astra (White): the pinned knight Rxe8+ takes is Black's, though the rook lands on its square first.
const q75 = "Black creates an escape on f7, and I take the pinned knight with check. This wins a piece.";
expectLit("a circle on a captured piece is that piece's colour (the knight, red)", 75, q75, [
  { at: "Black creates an escape on f7,", squares: ["f7"], refs: [{ words: "f7,", to: "f7" }] },
  { at: "I take the pinned knight with check.", arrows: [{ draw: "Rxe8+", at: "take" }], squares: [{ sq: "e8", at: "the pinned knight" }], refs: [{ words: "the pinned knight", to: "e8" }] },
], { "f7,": "A", "the pinned knight": "R" });

// 134, Opus (Black): the mating net. f1 is empty once Kg1 is drawn; slashed squares; "my king" vs White's.
const q134 =
  "Box the king. With my king on g3 covering f2/g2, ...Re6 cuts off the e-file, so White's king on f1 has only g1 left - and Kg1 runs into ...Re1 mate (f1 covered by the rook, f2/g2/h2 by my king, h1 by the rook behind the king).";
const m134 = [
  { at: "Box the king.", squares: ["f1"], refs: [{ words: "king.", to: "f1" }] },
  { at: "With my king on g3", arrows: ["g3>f2", "g3>g2"], squares: ["g3"], refs: [{ words: "my king on g3", to: "g3" }, { words: "f2/g2,", to: ["f2", "g2"] }] },
  {
    at: "...Re6 cuts off the e-file",
    arrows: ["Re6", "e6>e1"],
    squares: [{ sq: "f1", at: "White's king on f1" }, { sq: "g1", at: "g1" }],
    refs: [{ words: "...Re6", to: "Re6" }, { words: "White's king on f1", to: "f1" }, { words: "g1", to: "g1" }],
  },
  {
    at: "and Kg1 runs into",
    arrows: ["Kg1", "Re1#"],
    squares: [{ sq: "f1", at: "(f1" }, { sq: "f2", at: "f2/g2/h2" }, { sq: "g2", at: "f2/g2/h2" }, { sq: "h2", at: "f2/g2/h2" }, { sq: "g3", at: "my king," }, { sq: "h1", at: "h1" }],
    refs: [
      { words: "Kg1", to: "Kg1" },
      { words: "...Re1", to: "Re1#" },
      { words: "(f1", to: "f1" },
      { words: "rook,", to: "e1" },
      { words: "f2/g2/h2", to: ["f2", "g2", "h2"] },
      { words: "my king,", to: "g3" },
      { words: "h1", to: "h1" },
      { words: "rook behind", to: "e1" },
      { words: "the king).", to: "g1" },
    ],
  },
];
expectLit("a square a move has just left is empty (f1 amber after Kg1); slashed squares; owners", 134, q134, m134, {
  "king.": "R",
  "my king on g3": "G",
  "f2/g2,": "A",
  "...Re6": "G",
  "White's king on f1": "R",
  g1: "A",
  Kg1: "R",
  "...Re1": "G",
  "(f1": "A",
  "rook,": "G",
  "f2/g2/h2": "A",
  "my king,": "G",
  h1: "A",
  "the king).": "R",
});

// 105, Astra (White): the same words twice point at their two places, so neither needs padding.
const q105 = "I must now preserve the chain of support: g4 protects the knight, and the knight protects d6.";
expectLit("a repeated ref points at the next place its words appear", 105, q105, [
  {
    at: "the chain of support",
    arrows: ["d6", { draw: "g4>f5", at: "g4" }, { draw: "f5>d6", at: "and the knight" }],
    refs: [
      { words: "g4", to: "g4" },
      { words: "the knight", to: "f5" },
      { words: "the knight", to: "f5" },
      { words: "d6.", to: "d6" },
    ],
  },
], { g4: "G", "the knight,": "G", "the knight": "G", "d6.": "G" });

// What the director is sent back for.
const swap = (marks: any[], n: number, refs: unknown[]) => marks.map((mk, i) => (i === n ? { ...mk, refs } : mk));
expectRejected("a word left out of every ref is sent back", 134, q134, swap(m134, 2, [{ words: "...Re6", to: "Re6" }, { words: "White's king on f1", to: "f1" }]), '"g1"');
expectRejected("a ref to a square its mark doesn't draw is sent back", 134, q134, m134.map((mk, i) => (i === 0 ? { ...mk, refs: [{ words: "king.", to: "g3" }] } : mk)), "nothing in its mark is drawn on g3");
expectRejected("a ref whose words name another square is sent back", 134, q134, swap(m134, 2, [{ words: "...Re6", to: "Re6" }, { words: "White's king on f1", to: "f1" }, { words: "g1", to: "h3" }]), "names g1 but points at h3");
expectRejected("a ref naming a piece that isn't there is sent back", 74, q74, [m74[0], { ...m74[1], refs: [...m74[1].refs.filter((r) => r.words !== "Nd7"), { words: "Nd7", to: "d6" }] }], "Nd7");
expectRejected('"my king" on the opponent\'s king is sent back', 134, q134, [
  m134[0],
  { ...m134[1], squares: ["g3", "f1"], refs: [{ words: "my king on g3", to: ["g3"] }, { words: "f2/g2,", to: ["f2", "g2"] }] },
  m134[2],
  { ...m134[3], refs: m134[3].refs.map((r) => (r.words === "my king," ? { ...r, to: "f1" } : r)) },
], "the speaker's king");

// Old plans (no refs) still light up by finding the words: each side's "3 pawns".
const q90 = "Rook + 3 pawns vs knight + 3 pawns: this should be winning if I'm careful.";
const m90: ThoughtMark[] = [
  {
    at: "Rook + 3 pawns",
    word: 0,
    arrows: [],
    rings: [
      ...["f2", "f6", "g7", "h7"].map((sq) => ({ sq, word: 0 })),
      ...["c7", "d5", "g4", "h3"].map((sq) => ({ sq, word: 5 })),
    ],
  },
];
const l90 = lit(90, q90, m90);
check("without refs, each side's pawns light their own \"3 pawns\"", l90.get("pawns") === "G" && l90.get("pawns:") === "R", `pawns ${l90.get("pawns")}, pawns: ${l90.get("pawns:")}`);

// Words.
check('"f2/g2/h2" names three squares', JSON.stringify(pointsAt("f2/g2/h2,")) === JSON.stringify([{ sq: "f2" }, { sq: "g2" }, { sq: "h2" }]));
check('"...f6!" doesn\'t end a sentence, "move:" doesn\'t either', sentenceEnd(q74, 0) === quoteWords(q74).length - 1);
check("the refs' problems are none for a good plan", refProblems(q74, checkedMarks(g, 74, q74, m74) ?? [], fensOf(74), "b").length === 0);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
