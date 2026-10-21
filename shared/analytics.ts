import type { Variant } from "./rules";
import type { Classification, Color } from "./types";

/*
 * Per-model analytics (the Agents tab), worked out from every finished game by server/analytics.ts.
 * Ratings and the leaderboard record only ever count rated games; everything else counts the games in
 * the chosen scope (all finished games, or rated ones only). A human is never the subject, only an opponent.
 */

export type AnalyticsScope = "all" | "rated";
/** Which games by how they started: every one, only those the players opened themselves, or only set openings. */
export type AnalyticsStart = "all" | "free" | "set";
export type GamePhase = "opening" | "middlegame" | "endgame";
export type Outcome = "W" | "D" | "L";

/** Think time: wall-clock from the opponent's move to this one, every delay included. */
export interface TimeStats {
  n: number;
  avgMs: number | null;
  medianMs: number | null;
}

export interface WDL {
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

/** One model's row in the comparison table. */
export interface AgentRow {
  model: string;
  label: string;
  provider: string;
  /** Its best-rated player (model + effort), from rated standard games. */
  rating: number | null;
  rd: number | null;
  bestPlayerId: string | null;
  /** Rated standard games only, as on the leaderboard. */
  record: WDL;
  /** The same from rated Chess960 games: Chess960 is rated apart, so its results never move the standard rating. */
  rating960: number | null;
  rd960: number | null;
  record960: WDL;
  /** Games and moves in scope. */
  games: number;
  moves: number;
  /** Mean game accuracy (Lichess-style), and the Elo it plays like (from its centipawn loss). */
  accuracy: number | null;
  estElo: number | null;
  /**
   * The Chess.com rapid rating it would plausibly hold, with an 80% range: its standard games' moves set
   * against how people play at each rating, blended with its arena rating (server/chessCom.ts). Null until
   * its standard games hold 100 graded moves from at least five games.
   */
  chessCom: { rating: number; low: number; high: number } | null;
  /** Points per game in scope (win 1, draw ½), as a percentage. */
  score: number | null;
  blundersPer100: number | null;
  illegalPer100: number | null;
  /** Mean gap between its own winning chances and the engine's, in win-% points. */
  calibration: number | null;
  think: TimeStats;
  /** Colour-swapped pairs (see PairResult): how many, and how it came out of them. */
  pairs: { played: number; won: number; split: number; lost: number };
}

/**
 * Two games between the same two players from the same start (a set opening, or a Chess960 position), once with
 * each colour: scored together, so neither the colours nor the opening favour either side. `score` is this
 * model's points from both (0–2).
 */
export interface PairResult {
  opponent: string;
  start: string;
  score: number;
  gameIds: [string, string];
  ts: number;
}

/** How it did from one set opening (or a free game that reached the same position). */
export interface SetOpeningRow {
  id: string;
  name: string;
  games: number;
  score: number;
  accuracy: number | null;
  white: { games: number; score: number | null };
  black: { games: number; score: number | null };
}

/** Every model against every set opening, for the comparison page. */
export interface OpeningGrid {
  openings: { id: string; name: string }[];
  rows: { model: string; label: string; provider: string; cells: Record<string, { games: number; score: number; accuracy: number | null }> }[];
}

/** Its first moves of a game: after the arena's set opening, or in an opening it chose itself. */
export interface HandoverStats {
  games: number;
  moves: number;
  /** Mean move accuracy. */
  accuracy: number | null;
  /** Share of those moves that were still theory (book). */
  book: number | null;
  blundersPer100: number | null;
}

/** How many first moves of each game the handover comparison looks at. */
export const HANDOVER_MOVES = 10;

/**
 * The chance a rating of (r1 ± rd1) belongs to the stronger player than (r2 ± rd2): the gap between them, against
 * how uncertain both still are (Glicko's deviations taken as normal errors).
 */
export function strongerChance(r1: number, rd1: number, r2: number, rd2: number): number {
  const z = (r1 - r2) / Math.sqrt(rd1 * rd1 + rd2 * rd2 || 1);
  // The normal distribution's CDF, from erf (Abramowitz–Stegun 7.1.26).
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export interface RatingPoint {
  ts: number;
  gameId: string;
  rating: number;
  rd: number;
  result: Outcome;
  opponent: string;
}

export interface RatingSeries {
  playerId: string;
  effort: string;
  /** Which ratings these are: standard and Chess960 are kept apart. */
  variant: Variant;
  games: number;
  current: number;
  rd: number;
  points: RatingPoint[];
}

export interface PhaseStats {
  /** Moves that count for quality (book and forced moves left out). */
  moves: number;
  /** Mean move accuracy. */
  accuracy: number | null;
  blundersPer100: number | null;
  think: TimeStats;
  /**
   * The Chess.com rapid rating its moves in this phase look like, against how people of each rating play the
   * phase, with an 80% range: moves only, no arena rating. The endgame's didn't hold up on real players
   * (server/chessCom.ts PHASE_SCALES), so it's always null; the others are null until they hold enough moves.
   */
  chessCom: { rating: number; low: number; high: number } | null;
}

export interface FormGame {
  gameId: string;
  ts: number;
  result: Outcome;
  accuracy: number | null;
  opponent: string;
}

export interface IllegalKind {
  kind: "check" | "pin" | "reach" | "missing" | "castle" | "notation";
  label: string;
  count: number;
  /** `played`: the move it then made (null: it resigned instead). */
  example?: { gameId: string; ply: number; tried: string; played: string | null };
}

export interface BlownGame {
  gameId: string;
  opponent: string;
  /** Its best winning chances in the game, and the move it let them go on. */
  peak: number;
  ply: number;
  san: string;
  result: Outcome;
}

export interface OpeningRow {
  name: string;
  games: number;
  score: number;
  accuracy: number | null;
}

export interface HeadToHead extends WDL {
  /** "human" for every human opponent together. */
  model: string;
  label: string;
  provider: string;
  myAccuracy: number | null;
  theirAccuracy: number | null;
  /** The chance this model is the stronger of the two, from both best standard ratings (null: one is unrated). */
  stronger: number | null;
}

export interface ModelAnalytics {
  scope: AnalyticsScope;
  start: AnalyticsStart;
  row: AgentRow;
  ratingHistory: RatingSeries[];
  form: { last: FormGame[]; scoreLast10: number | null; accuracyLast10: number | null };
  upsets: { wins: number; losses: number; winsOver: FormGame[]; lossesTo: FormGame[] };
  quality: {
    /** Analysed moves by verdict, for this model and for every model together. */
    counts: Partial<Record<Classification, number>>;
    field: Partial<Record<Classification, number>>;
    phases: Record<GamePhase, PhaseStats>;
    byColor: Record<Color, { games: number; accuracy: number | null; score: number | null }>;
  };
  thinking: {
    overall: TimeStats;
    /** Its own moves split in thirds by how long they took, each with how well they were played. */
    buckets: { label: string; minMs: number; maxMs: number; moves: number; accuracy: number | null; blundersPer100: number | null }[];
    byVerdict: { group: "good" | "inaccuracy" | "bad"; label: string; think: TimeStats }[];
    /** Positions with one good move (the engine's best far ahead of its second), against the rest. */
    critical: { positions: number; found: number; think: TimeStats; normal: TimeStats };
  };
  mind: {
    calibration: number | null;
    samples: number;
    /** Its own winning chances in tenths, against what the engine said they were. */
    curve: { bin: number; n: number; self: number; engine: number }[];
    /** Share of moves where it thought it was doing far better (over) or far worse (under) than it was. */
    over: number | null;
    under: number | null;
    resign: { count: number; justified: number; avgWin: number | null; premature: { gameId: string; ply: number; win: number; opponent: string }[] };
    draws: {
      offered: number;
      /** Its winning chances when it offered: worse (under 40%), level, better (over 60%). */
      offeredWorse: number;
      offeredLevel: number;
      offeredBetter: number;
      received: number;
      accepted: number;
      acceptedBetter: number;
    };
  };
  rules: { moves: number; attempts: number; movesWithIllegal: number; movesWithRepeat: number; games: number; kinds: IllegalKind[] };
  calc: { movesWithLines: number; lines: number; legalLines: number; avgClaimed: number | null; avgLegal: number | null; avgBeforeBreak: number | null };
  conversion: {
    winning: number;
    converted: number;
    losing: number;
    saved: number;
    blown: BlownGame[];
    firstMistake: { games: number; clean: number; avgMove: number | null };
  };
  tactics: { mates: number; matesFound: number; mateIn1: number; mateIn1Found: number; onlyMoves: number; onlyFound: number };
  openings: Record<Color, OpeningRow[]>;
  /** By set opening, whoever chose it (shared/openingSuite.ts). */
  setOpenings: SetOpeningRow[];
  pairs: PairResult[];
  /** Its first HANDOVER_MOVES moves of each game: after a set opening, and in openings it chose. */
  handover: { set: HandoverStats; free: HandoverStats };
  endings: {
    wins: Record<string, number>;
    losses: Record<string, number>;
    draws: Record<string, number>;
    avgLength: Record<Outcome, number | null>;
    /** Draws it drew from a position it was winning (90%+ in its last ten moves). */
    drawnFromWinning: number;
  };
  h2h: HeadToHead[];
  setup: {
    efforts: { effort: string; games: number; score: number | null; accuracy: number | null; think: TimeStats }[];
    players: { playerId: string; effort: string; variant: Variant; rating: number; rd: number; record: WDL }[];
  };
}
