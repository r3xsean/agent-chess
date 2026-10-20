import type { GamePhase } from "../shared/analytics";
import { HUMAN_RAPID, HUMAN_RAPID_BY_PHASE, type HumanBand } from "./humanCurve";

/*
 * The Chess.com rapid rating a model would plausibly hold, from two readings of its games:
 *
 *  - how it moves: its centipawn loss, blunder rate and error rate over its standard games, each read off the
 *    human curve (humanCurve.ts: how people play at each Lichess rapid rating) and combined;
 *  - how it scores: its arena rating, shifted onto the human scale by where the other models' arena ratings sit
 *    against their own move readings (the arena rating says who beats whom, not what that's worth outside).
 *
 * The two are blended by how sure each is, then carried from Lichess rapid to Chess.com rapid. The middlegame also
 * gets a reading of its own, from its moves alone against how people play it (phaseEstimate, PHASE_SCALES).
 *
 * Every constant here was settled by validating against held-out Lichess players (people the curve never saw,
 * each with ten or more games): the move reading is off by about 280 Lichess points for a typical person, and its
 * 80% range held their real rating 79% of the time. The blended range for a model is the same model's arithmetic,
 * not something that could be checked against a known answer.
 */

/** What one standard game says about how a side moves, each move weighted by how open the position was. */
export interface MoveSample {
  /** Sum of the move weights (4·p·(1−p) on the mover's winning chances before the move). */
  weight: number;
  /** Weighted sums: centipawn loss, blunders (win-% drop over 20) and errors (over 10). */
  cpl: number;
  blunders: number;
  errors: number;
}

export interface ChessComEstimate {
  rating: number;
  /** 80% range. */
  low: number;
  high: number;
}

/** A model needs this much move weight in all, from at least MIN_GAMES games, before its moves are read. */
export const MIN_WEIGHT = 100;
export const MIN_GAMES = 5;

/** What a move reading is measured against and how far to trust it. */
export interface ReadingScale {
  curve: HumanBand[];
  /** How far a player's moves can sit from their rating, beyond what their game count explains (Lichess points). */
  tau: number;
  minWeight: number;
  minGames: number;
  /** Whether its readings held up on held-out players well enough to show. */
  shown: boolean;
}
const WHOLE_GAME: ReadingScale = { curve: HUMAN_RAPID, tau: 275, minWeight: MIN_WEIGHT, minGames: MIN_GAMES, shown: true };

/**
 * Each phase read against how people play that phase alone, fitted and checked on held-out Lichess players the
 * same way as the whole-game reading. Only the middlegame earned a place: typically 264 points off, its 80% range
 * held 73% of people (60–83%). The opening tracks rating (0.85 correlation) but its range only came good on a
 * setting picked after a first one failed, so it waits for fresh players to confirm it. Endgame moves told a
 * person's rating worse than guessing the middle of the field (414 points off against 305).
 */
export const PHASE_SCALES: Record<GamePhase, ReadingScale> = {
  opening: { curve: HUMAN_RAPID_BY_PHASE.opening, tau: 250, minWeight: 100, minGames: MIN_GAMES, shown: false },
  middlegame: { curve: HUMAN_RAPID_BY_PHASE.middlegame, tau: 175, minWeight: 100, minGames: MIN_GAMES, shown: true },
  endgame: { curve: HUMAN_RAPID_BY_PHASE.endgame, tau: 325, minWeight: 75, minGames: MIN_GAMES, shown: false },
};

/** The least the arena's gaps may be taken to differ from human gaps: seven models can't rule out more. */
const MIN_ARENA_SPREAD = 150;
const Z80 = 1.2816;

type Key = Exclude<keyof HumanBand, "elo" | "sides">;
/** Centipawn loss carries most of the reading; accuracy, the fourth candidate, earned no weight. */
const READINGS: { key: Key; weight: number; of: (s: MoveSample) => number }[] = [
  { key: "acpl", weight: 0.7, of: (s) => s.cpl / s.weight },
  { key: "blunders", weight: 0.1, of: (s) => (100 * s.blunders) / s.weight },
  { key: "errors", weight: 0.2, of: (s) => (100 * s.errors) / s.weight },
];

/**
 * The Lichess rapid rating people play this value at (every column gets worse as the value rises). On a flat
 * stretch it's the stretch's start; past either end of the curve, the line through the end band and the band
 * three along carries on.
 */
export function ratingFor(key: Key, value: number, curve: HumanBand[] = HUMAN_RAPID): number {
  const xs = curve.map((b) => b.elo);
  const ys = curve.map((b) => -b[key]);
  const v = -value;
  const n = ys.length;
  const k = Math.min(3, n - 1);
  const along = (i: number, j: number) => (ys[j] === ys[i] ? Math.min(xs[i], xs[j]) : xs[i] + ((v - ys[i]) * (xs[j] - xs[i])) / (ys[j] - ys[i]));
  let elo: number;
  if (v <= ys[0]) elo = along(0, k);
  else if (v >= ys[n - 1]) elo = along(n - 1 - k, n - 1);
  else {
    const i = ys.findIndex((y) => y >= v);
    elo = ys[i] === v ? xs[ys.indexOf(v)] : along(i - 1, i);
  }
  return Math.max(100, Math.min(3200, elo));
}

function pooled(xs: MoveSample[]): MoveSample {
  return xs.reduce((a, x) => ({ weight: a.weight + x.weight, cpl: a.cpl + x.cpl, blunders: a.blunders + x.blunders, errors: a.errors + x.errors }), { weight: 0, cpl: 0, blunders: 0, errors: 0 });
}
const reading = (s: MoveSample, curve: HumanBand[]) => READINGS.reduce((a, r) => a + r.weight * ratingFor(r.key, r.of(s), curve), 0);

/** FNV-1a, to seed each model's bootstrap from its name: the same games always give the same range. */
function fnv1a(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The Lichess rapid rating its moves look like, and its variance: a bootstrap over its games (every standard game,
 * even one whose moves all came in decided positions) plus the spread between people that games don't explain.
 * Samples come one per game side, in a stable order (by game, then colour).
 */
export function moveReading(samples: MoveSample[], seed: string, scale: ReadingScale = WHOLE_GAME): { elo: number; v: number } | null {
  const all = pooled(samples);
  if (all.weight < scale.minWeight || samples.filter((s) => s.weight > 0).length < scale.minGames) return null;
  const elo = reading(all, scale.curve);
  const rand = mulberry32(fnv1a(seed + "round3"));
  const boots: number[] = [];
  while (boots.length < 400) {
    const s = pooled(samples.map(() => samples[Math.floor(rand() * samples.length)]));
    if (s.weight > 0) boots.push(reading(s, scale.curve));
  }
  const mean = boots.reduce((a, b) => a + b, 0) / boots.length;
  const se = Math.max(25, Math.sqrt(boots.reduce((a, b) => a + (b - mean) ** 2, 0) / (boots.length - 1)));
  return { elo, v: se ** 2 + scale.tau ** 2 };
}

/**
 * A phase's estimate from its moves alone (no arena rating speaks to one phase), or null for a phase that isn't
 * shown or doesn't hold enough moves yet. Samples as for moveReading.
 */
export function phaseEstimate(samples: MoveSample[], seed: string, phase: GamePhase): ChessComEstimate | null {
  if (!PHASE_SCALES[phase].shown) return null;
  const m = moveReading(samples, `${seed}:${phase}`, PHASE_SCALES[phase]);
  return m && toChessCom(m.elo, m.v);
}

/**
 * ChessGoals' tables (July 2026), Lichess rapid against Chess.com rapid, joined through Chess.com blitz: straight
 * lines between the points, the end segments carried on beyond them.
 */
const CHESSGOALS: [number, number][] = [
  [1290, 815], [1360, 905], [1425, 995], [1490, 1085], [1555, 1170], [1615, 1255], [1680, 1340], [1710, 1380], [1740, 1420],
  [1765, 1460], [1795, 1500], [1825, 1540], [1850, 1580], [1880, 1620], [1905, 1655], [1935, 1690], [1960, 1730], [1990, 1765],
  [2015, 1800], [2040, 1835], [2065, 1870], [2090, 1900], [2115, 1935], [2140, 1965], [2165, 1995], [2215, 2055], [2260, 2110],
  [2310, 2165], [2355, 2215], [2400, 2260], [2445, 2300], [2490, 2340], [2530, 2375], [2575, 2405], [2615, 2430],
];
export function lichessToChessCom(lichess: number): number {
  const above = CHESSGOALS.findIndex(([l]) => l >= lichess);
  const i = above === -1 ? CHESSGOALS.length - 1 : Math.max(1, above);
  const [a, b] = [CHESSGOALS[i - 1], CHESSGOALS[i]];
  return Math.max(100, a[1] + ((lichess - a[0]) * (b[1] - a[1])) / (b[0] - a[0]));
}

/** A Lichess reading and its variance as a Chess.com rating with its 80% range, each end converted and rounded to 25. */
function toChessCom(elo: number, v: number): ChessComEstimate {
  const round = (x: number) => Math.round(lichessToChessCom(x) / 25) * 25;
  const sd = Math.sqrt(v);
  return { rating: round(elo), low: round(elo - Z80 * sd), high: round(elo + Z80 * sd) };
}

export interface ModelReadings {
  move: { elo: number; v: number } | null;
  /** Arena rating and RD, when it has rated games. */
  rating: number | null;
  rd: number | null;
}

/** Each model's estimate, in order; null for one without enough standard games to read. */
export function chessComEstimates(models: ModelReadings[]): (ChessComEstimate | null)[] {
  const anchors = models.flatMap((m, i) => (m.move && m.rating !== null && m.rd !== null ? [{ i, d: m.move.elo - m.rating, v: m.move.v, rd2: m.rd ** 2 }] : []));

  // How much the arena's gaps differ from human gaps, beyond the noise: what the anchors' disagreement shows, or the floor.
  let spread2 = MIN_ARENA_SPREAD ** 2;
  if (anchors.length >= 3) {
    const u = anchors.map((a) => 1 / (a.v + a.rd2));
    const U = u.reduce((s, x) => s + x, 0);
    const mean = anchors.reduce((s, a, j) => s + u[j] * a.d, 0) / U;
    const Q = anchors.reduce((s, a, j) => s + u[j] * (a.d - mean) ** 2, 0);
    const C = U - u.reduce((s, x) => s + x * x, 0) / U;
    spread2 = Math.max(spread2, (Q - (anchors.length - 1)) / C);
  }

  return models.map((m, i) => {
    if (!m.move) return null;
    let elo = m.move.elo;
    let v = m.move.v;
    // Its arena rating, shifted by the other models only, so its own moves never anchor its own arena reading.
    const others = anchors.filter((a) => a.i !== i);
    if (m.rating !== null && m.rd !== null && others.length) {
      const t = others.map((a) => 1 / (a.v + a.rd2 + spread2));
      const T = t.reduce((s, x) => s + x, 0);
      const offset = others.reduce((s, a, j) => s + t[j] * a.d, 0) / T;
      const arena = { elo: m.rating + offset, v: m.rd ** 2 + spread2 + 1 / T };
      v = 1 / (1 / m.move.v + 1 / arena.v);
      elo = v * (m.move.elo / m.move.v + arena.elo / arena.v);
    }
    return toChessCom(elo, v);
  });
}
