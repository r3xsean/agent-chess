import type { Color, Score } from "./types";

/** Score as centipawns from White's POV, with mates mapped to a large value. */
export function scoreToCp(s: Score): number {
  if (s.mate !== undefined) {
    if (s.mate === 0) return Math.sign(s.cp ?? 0) * 10000;
    return s.mate > 0 ? 10000 - s.mate : -10000 - s.mate;
  }
  return s.cp ?? 0;
}

/** Lichess win-probability model, 0..100 for White. */
export function winPercentWhite(s: Score): number {
  if (s.mate !== undefined) {
    // mate 0 = the position is checkmate; cp carries the sign of the winner.
    const m = s.mate === 0 ? Math.sign(s.cp ?? 0) : s.mate;
    if (m > 0) return 100;
    if (m < 0) return 0;
    return 50;
  }
  const cp = Math.max(-1000, Math.min(1000, s.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export const winPercentFor = (s: Score, color: Color) =>
  color === "w" ? winPercentWhite(s) : 100 - winPercentWhite(s);

/** Lichess per-move accuracy from win% drop. */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  const drop = Math.max(0, winBefore - winAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669 + 1;
  return Math.max(0, Math.min(100, acc));
}

export function formatScore(s: Score | undefined): string {
  if (!s) return "";
  if (s.mate !== undefined) {
    if (s.mate === 0) return (s.cp ?? 0) > 0 ? "1-0" : "0-1";
    return s.mate > 0 ? `M${s.mate}` : `-M${-s.mate}`;
  }
  const v = (s.cp ?? 0) / 100;
  return (v > 0 ? "+" : "") + v.toFixed(Math.abs(v) >= 10 ? 0 : 1);
}

/** Score to pawns (White POV), capped, for charts. */
export function scoreToPawns(s: Score, cap = 10): number {
  if (s.mate !== undefined) {
    const m = s.mate === 0 ? Math.sign(s.cp ?? 0) : s.mate;
    return m > 0 ? cap : m < 0 ? -cap : 0;
  }
  return Math.max(-cap, Math.min(cap, (s.cp ?? 0) / 100));
}
