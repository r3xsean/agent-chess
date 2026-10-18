import type { Color } from "./types";
import { newRules, type Variant } from "./rules";

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export interface MaterialInfo {
  /** Piece types each side has captured (from real capture events, so promotions don't confuse it). */
  captured: Record<Color, string[]>;
  /** Material on the board. */
  material: Record<Color, number>;
}

export function materialInfo(startFen: string, sans: string[], variant: Variant = "standard"): MaterialInfo {
  const c = newRules(startFen, variant);
  const captured: Record<Color, string[]> = { w: [], b: [] };
  for (const san of sans) {
    const mv = c.move(san);
    if (mv.captured) captured[mv.color].push(mv.captured);
  }
  const material: Record<Color, number> = { w: 0, b: 0 };
  for (const ch of c.fen().split(" ")[0]) {
    const t = ch.toLowerCase();
    if (t in VALUE) material[ch === t ? "b" : "w"] += VALUE[t];
  }
  return { captured, material };
}

/** Replay a line once, retaining captures (including en passant) and promotions at every ply. */
export function materialTimeline(startFen: string, sans: string[], variant: Variant = "standard"): MaterialInfo[] {
  const c = newRules(startFen, variant);
  const captured: Record<Color, string[]> = { w: [], b: [] };
  const snapshot = (): MaterialInfo => {
    const material: Record<Color, number> = { w: 0, b: 0 };
    for (const ch of c.fen().split(" ")[0]) {
      const t = ch.toLowerCase();
      if (t in VALUE) material[ch === t ? "b" : "w"] += VALUE[t];
    }
    return { captured: { w: [...captured.w], b: [...captured.b] }, material };
  };
  const positions = [snapshot()];
  for (const san of sans) {
    const mv = c.move(san);
    if (mv.captured) captured[mv.color].push(mv.captured);
    positions.push(snapshot());
  }
  return positions;
}
