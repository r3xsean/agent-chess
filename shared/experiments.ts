import type { SeatSetup } from "./types";

/*
 * The Experiments page: every reviewed seat grouped by its toggles (shared/seatSetup.ts), so the combinations
 * can be set side by side. Each number comes with its 95% range (±), from how much it varies game to game: two
 * arms whose ranges overlap a lot aren't shown to differ yet.
 */

/** A number and its 95% range (value ± ci); null when there's nothing to measure (ci null too with fewer than five games). */
export interface Estimate {
  value: number | null;
  ci: number | null;
}

/**
 * An arm's difference from the first arm on one number, measured game by game (a split game counts once, for both
 * sides at once), and whether it's clear of the noise: bigger than its 95% range, with at least five games each.
 */
export interface Difference {
  value: number | null;
  ci: number | null;
  clear: boolean;
}

export const ARM_METRICS = ["accuracy", "balancedAccuracy", "blunders", "mistakes", "illegal", "codeRefusals", "positionRefusals", "score"] as const;
export type ArmMetric = (typeof ARM_METRICS)[number];

/** One toggle combination's play: in a scope, or one model's. */
export interface ArmStats {
  key: string;
  label: string;
  setup: SeatSetup;
  /** Reviewed games played under it (one seat each). */
  games: number;
  /** Its moves that say something about quality (no book, forced or arena moves). */
  graded: number;
  /** The game accuracy the site shows, averaged over its games. */
  accuracy: Estimate;
  /** Move accuracy only where the position was still open (the engine within ±2 pawns before the move): a side already winning plays easy moves. */
  balancedAccuracy: Estimate;
  /** Per 100 graded moves. */
  blunders: Estimate;
  /** Mistakes and misses, per 100 graded moves. */
  mistakes: Estimate;
  /** Illegal attempts per 100 moves played. */
  illegal: Estimate;
  /** Turns refused for a missing or stale board-picture code, per 100 moves played. */
  codeRefusals: Estimate;
  /** Turns refused for a written-out position that didn't match the board, per 100 moves played. */
  positionRefusals: Estimate;
  /** Average thinking time per move, in seconds (each side's first move left out: it includes starting up). */
  thinkSec: number | null;
  /** Points per game, in % (a draw is half). */
  score: Estimate;
  /** Every arm but the first: its differences from the first. */
  vsFirst?: Partial<Record<ArmMetric, Difference>>;
}

/** Two combinations meeting in the same games, from the first's side. */
export interface HeadToHeadArms {
  a: string;
  b: string;
  aLabel: string;
  bLabel: string;
  games: number;
  aWins: number;
  draws: number;
  bWins: number;
  /** a's points per game, in %. */
  aScore: Estimate;
}

export interface ExperimentScope {
  id: string;
  label: string;
  games: number;
}

export interface ExperimentReport {
  scope: string;
  scopes: ExperimentScope[];
  /** Reviewed games in the scope. */
  games: number;
  /** Every combination in the scope, the plain text briefing first. */
  arms: ArmStats[];
  /** Each model's arms, for models that played under more than one combination. */
  models: { model: string; label: string; arms: ArmStats[] }[];
  headToHead: HeadToHeadArms[];
}
