/*
 * Glicko-2 (Glickman, "Example of the Glicko-2 system", 2013). Every game is its own rating period,
 * as on lichess: both players are updated from their pre-game ratings. RD only shrinks with games;
 * there is no decay for time away, so a player's uncertainty reflects how much they've played.
 */

export interface Glicko {
  /** Rating on the familiar 1500 scale. */
  rating: number;
  /** Rating deviation: the uncertainty, in rating points (350 = unknown). */
  rd: number;
  /** Volatility: how erratic the player's results are. */
  vol: number;
}

export const GLICKO_START: Glicko = { rating: 1500, rd: 350, vol: 0.06 };

const SCALE = 173.7178;
const TAU = 0.5;
const EPSILON = 0.000001;
/** RD never drops below this, so a long-standing rating can still move. */
const MIN_RD = 45;

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** One player's new rating after one game against `opp`, scoring `score` (1, 0.5 or 0). */
export const glickoUpdate = (me: Glicko, opp: Glicko, score: number): Glicko => glickoPeriod(me, [{ opp, score }]);

/** A player's new rating after a rating period with these results. */
export function glickoPeriod(me: Glicko, results: { opp: Glicko; score: number }[]): Glicko {
  const mu = (me.rating - 1500) / SCALE;
  const phi = me.rd / SCALE;
  let vInv = 0;
  let sum = 0;
  for (const { opp, score } of results) {
    const muJ = (opp.rating - 1500) / SCALE;
    const gJ = g(opp.rd / SCALE);
    const e = expected(mu, muJ, opp.rd / SCALE);
    vInv += gJ * gJ * e * (1 - e);
    sum += gJ * (score - e);
  }
  const v = 1 / vInv;
  const delta = v * sum;

  // New volatility: solve f(x) = 0 with the Illinois algorithm (step 5 of the paper).
  const a = Math.log(me.vol * me.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > EPSILON; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  return {
    rating: muNew * SCALE + 1500,
    rd: Math.max(MIN_RD, Math.min(GLICKO_START.rd, phiNew * SCALE)),
    vol,
  };
}
