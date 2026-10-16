import type { Game, MoveRecord, Score } from "./types";
import { winPercentFor } from "./evalmath";

/*
 * What a player believed versus what was true. Every move an agent plays comes with its own evaluation;
 * when that is far from the engine's, the player is misjudging the position. The director brief, the
 * game page and the replay video all mark the same moments, so the rule lives here.
 */

/** How far apart a player's own winning chances and the engine's must be (win-percentage points) to count. */
export const MISJUDGED_AT = 30;

/** "over": thinks it's doing far better than it is. "under": thinks it's doing far worse than it is. */
export type Misjudgment = "over" | "under" | null;

export interface Belief {
  /** The mover's own winning chances, 0–100, from the mover's side. */
  self: number;
  /** The engine's winning chances for the mover, 0–100. */
  engine: number;
  state: Misjudgment;
  /** Where this move sits in a stretch of misjudgment: it starts here, flips direction, or ends ("realizes"). */
  change: "starts" | "flips" | "realizes" | null;
}

/** The player's own evaluation as a score (pawns, White's view; a claimed mate counts as ±10). */
export const selfScore = (m: MoveRecord): Score | undefined =>
  m.selfEval === null ? undefined : { cp: Math.max(-10, Math.min(10, m.selfEval)) * 100 };

/**
 * The engine's score after a move: the review's verdict, or the live analysis of the position. A review
 * made without engine data (`unavailable`) carries a placeholder score, so it doesn't count.
 */
export function engineAfter(g: Game, m: MoveRecord): Score | undefined {
  if (m.analysis?.evalAfter && !m.analysis.unavailable) return m.analysis.evalAfter;
  const a = g.analysis[m.fenAfter];
  return a && !a.failed && a.depth > 0 ? a.score : undefined;
}

/** Whether a belief (win%, one side's view) is far from the engine's: the rule every view uses. */
export function judge(self: number, engine: number): Misjudgment {
  const gap = self - engine;
  return gap >= MISJUDGED_AT ? "over" : gap <= -MISJUDGED_AT ? "under" : null;
}

/**
 * Each move's belief, by move index (null for moves without both evaluations, such as a human's).
 * A stretch of misjudgment is tracked per player, so `change` marks only where it begins and ends.
 */
export function beliefs(g: Game): (Belief | null)[] {
  const current: Record<"w" | "b", Misjudgment> = { w: null, b: null };
  return g.moves.map((m) => {
    const own = selfScore(m);
    const engine = engineAfter(g, m);
    if (!own || !engine) return null;
    const self = winPercentFor(own, m.color);
    const real = winPercentFor(engine, m.color);
    const state = judge(self, real);
    const was = current[m.color];
    const change = state && !was ? "starts" : state && state !== was ? "flips" : !state && was ? "realizes" : null;
    current[m.color] = state;
    return { self, engine: real, state, change };
  });
}

/** Win% (from one side) as words, for labels. */
export function standing(win: number): string {
  if (win >= 97) return "winning";
  if (win >= 75) return "clearly better";
  if (win >= 58) return "slightly better";
  if (win > 42) return "about equal";
  if (win > 25) return "slightly worse";
  if (win > 3) return "clearly worse";
  return "lost";
}
