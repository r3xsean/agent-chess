// The Chess.com estimate (server/chessCom.ts): reading the human curve backwards, the move reading's range,
// anchoring the arena scale on the other models, and the Lichess-to-Chess.com step. Pure functions, no server.
import assert from "node:assert/strict";
import { HUMAN_RAPID, HUMAN_RAPID_BY_PHASE } from "../server/humanCurve";
import { MIN_GAMES, PHASE_SCALES, chessComEstimates, lichessToChessCom, moveReading, phaseEstimate, ratingFor, type MoveSample } from "../server/chessCom";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${(e as Error).message}`);
  }
}

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} not within ${tol} of ${b}`);
const TAU2 = 250 ** 2;

check("the curve only ever improves with rating", () => {
  for (let i = 1; i < HUMAN_RAPID.length; i++) {
    const [a, b] = [HUMAN_RAPID[i - 1], HUMAN_RAPID[i]];
    assert.ok(b.acpl <= a.acpl && b.blunders <= a.blunders && b.errors <= a.errors, `band ${b.elo}`);
  }
});

check("a band's own numbers read back as its rating", () => {
  for (const b of HUMAN_RAPID) {
    near(ratingFor("acpl", b.acpl), b.elo, 1, `acpl at ${b.elo}`);
    near(ratingFor("errors", b.errors), b.elo, 1, `errors at ${b.elo}`);
  }
});

check("better play reads higher, on every reading, past both ends too", () => {
  assert.ok(ratingFor("acpl", 20) > ratingFor("acpl", 60) && ratingFor("acpl", 60) > ratingFor("acpl", 160));
  assert.ok(ratingFor("blunders", 1) > ratingFor("blunders", 12));
  assert.ok(ratingFor("errors", 3) > ratingFor("errors", 30));
  assert.ok(ratingFor("acpl", 1) <= 3200 && ratingFor("acpl", 500) >= 100);
});

// A model whose open-position moves look like a band's, game after game, with some spread.
function games(band: (typeof HUMAN_RAPID)[number], n: number, weight = 20): MoveSample[] {
  return Array.from({ length: n }, (_, i) => {
    const w = i % 2 ? 1.15 : 0.85;
    return { weight, cpl: band.acpl * weight * w, blunders: (band.blunders * weight * w) / 100, errors: (band.errors * weight * w) / 100 };
  });
}
const b1550 = HUMAN_RAPID.find((b) => b.elo === 1550)!;
const zero: MoveSample = { weight: 0, cpl: 0, blunders: 0, errors: 0 };

check(`no reading under ${MIN_GAMES} games with weight, or under 100 weight in all`, () => {
  assert.equal(moveReading(games(b1550, MIN_GAMES - 1, 40), "m"), null);
  assert.equal(moveReading([...games(b1550, MIN_GAMES - 1, 40), zero, zero], "m"), null);
  assert.equal(moveReading(games(b1550, 8, 10), "m"), null);
  assert.notEqual(moveReading(games(b1550, 6), "m"), null);
});

check("the move reading lands on the band, and its variance never drops below the persistent spread", () => {
  const few = moveReading(games(b1550, 6), "m")!;
  const many = moveReading(games(b1550, 60), "m")!;
  near(few.elo, 1550, 100, "6 games");
  near(many.elo, 1550, 100, "60 games");
  assert.ok(many.v < few.v, `v ${many.v} should be under ${few.v}`);
  assert.ok(many.v >= TAU2 + 25 ** 2 - 1, "tau and the SE floor stay in");
});

check("games decided early stay in: they count for nothing in the reading, but widen it", () => {
  const plain = moveReading(games(b1550, 10), "m")!;
  const padded = moveReading([...games(b1550, 10), zero, zero, zero], "m")!;
  near(padded.elo, plain.elo, 0.001, "point reading");
  assert.ok(padded.v >= plain.v - 1);
});

check("the same games always give the same range, and the seed is per model", () => {
  assert.deepEqual(moveReading(games(b1550, 12), "a"), moveReading(games(b1550, 12), "a"));
  assert.notEqual(moveReading(games(b1550, 12), "a")!.v, moveReading(games(b1550, 12), "b")!.v);
});

check("ChessGoals points carry over, and the curve keeps rising past both ends", () => {
  near(lichessToChessCom(1290), 815, 0.01, "1290");
  near(lichessToChessCom(1765), 1460, 0.01, "1765");
  near(lichessToChessCom(2615), 2430, 0.01, "2615");
  near(lichessToChessCom(1255), 815 - (35 * 90) / 70, 0.01, "below the table, along its first segment");
  assert.ok(lichessToChessCom(1000) < lichessToChessCom(1200) && lichessToChessCom(2800) > 2430);
  assert.equal(lichessToChessCom(200), 100);
});

const model = (elo: number, rating: number | null, rd = 100) => ({ move: { elo, v: 200 ** 2 + TAU2 }, rating, rd: rating === null ? null : rd });

check("a model's own moves never anchor its own arena reading", () => {
  // Alone, it has no other model to anchor its arena rating: its moves are all there is, range and all.
  const [only] = chessComEstimates([model(1700, 2400)]);
  const v = 200 ** 2 + TAU2;
  assert.equal(only!.rating, Math.round(lichessToChessCom(1700) / 25) * 25);
  assert.equal(only!.high, Math.round(lichessToChessCom(1700 + 1.2816 * Math.sqrt(v)) / 25) * 25);
});

check("the arena scale is shifted to sit where the other models' move readings do", () => {
  // Arena ratings 300 above the move readings across the board: the shift takes it all out.
  const est = chessComEstimates([model(1800, 2100), model(1500, 1800), model(1200, 1500), model(1650, 1950)]);
  near(est[0]!.rating, lichessToChessCom(1800), 25, "strong");
  near(est[2]!.rating, lichessToChessCom(1200), 25, "weak");
  assert.ok(est[0]!.low < est[0]!.rating && est[0]!.rating < est[0]!.high);
});

check("where the two readings disagree, the blend sits between them", () => {
  // The same moves, but one wins far more than the others: it ends up above its move reading, never past its arena one.
  const est = chessComEstimates([model(1500, 1900), model(1500, 1500), model(1500, 1500), model(1500, 1500)]);
  assert.ok(est[0]!.rating > lichessToChessCom(1500) && est[0]!.rating < lichessToChessCom(1900));
});

check("adding an arena reading narrows the range, but by no more than its spread allows", () => {
  const alone = chessComEstimates([model(1600, null), model(1500, 1500), model(1400, 1400)])[0]!;
  const blended = chessComEstimates([model(1600, 1600), model(1500, 1500), model(1400, 1400)])[0]!;
  assert.ok(blended.high - blended.low < alone.high - alone.low);
  // The arena part's variance is at least RD² + 150², so the blend's SD stays over 1/√(1/V + 1/(100² + 150²)).
  const floor = 1 / Math.sqrt(1 / (200 ** 2 + TAU2) + 1 / (100 ** 2 + 150 ** 2));
  assert.ok(lichessToChessCom(1600 + 1.2816 * floor) - 25 <= blended.high);
});

check("unread models stay null, and an unrated one stands on its moves", () => {
  const est = chessComEstimates([{ move: null, rating: 1500, rd: 100 }, model(1600, null), model(1500, 1500)]);
  assert.equal(est[0], null);
  near(est[1]!.rating, lichessToChessCom(1600), 25, "moves only");
});

check("each phase's curve only ever improves with rating, and reads its own bands back", () => {
  for (const ph of ["opening", "middlegame", "endgame"] as const) {
    const curve = HUMAN_RAPID_BY_PHASE[ph];
    assert.ok(curve.length >= 10, `${ph} has ${curve.length} bands`);
    for (let i = 1; i < curve.length; i++) assert.ok(curve[i].acpl <= curve[i - 1].acpl && curve[i].errors <= curve[i - 1].errors, `${ph} band ${curve[i].elo}`);
    for (const b of curve) near(ratingFor("acpl", b.acpl, curve), curve.find((c) => c.acpl === b.acpl)!.elo, 1, `${ph} acpl at ${b.elo}`);
  }
});

check("the opening and middlegame read against how people play them, each with its own evidence floor", () => {
  for (const ph of ["opening", "middlegame"] as const) {
    const band = HUMAN_RAPID_BY_PHASE[ph].find((b) => b.elo === 1550)!;
    const est = phaseEstimate(games(band, 10), "m", ph)!;
    near(est.rating, lichessToChessCom(1550), 75, `${ph} at 1550`);
    assert.ok(est.low < est.rating && est.rating < est.high);
    const floor = PHASE_SCALES[ph].minWeight;
    assert.equal(phaseEstimate(games(band, MIN_GAMES, (floor - 1) / MIN_GAMES), "m", ph), null);
    assert.notEqual(phaseEstimate(games(band, MIN_GAMES, (floor + 1) / MIN_GAMES), "m", ph), null);
  }
  assert.ok(PHASE_SCALES.opening.minWeight < PHASE_SCALES.middlegame.minWeight, "the opening needs less evidence");
});

check("the endgame, which didn't hold up on real players, is never shown", () => {
  const band = HUMAN_RAPID_BY_PHASE.endgame.find((b) => b.elo === 1550)!;
  assert.equal(phaseEstimate(games(band, 40), "m", "endgame"), null);
});
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
