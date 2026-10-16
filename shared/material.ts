import { Chess } from "chess.js";
import type { Color } from "./types";

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export interface MaterialInfo {
  /** Piece types each side has captured (from real capture events, so promotions don't confuse it). */
  captured: Record<Color, string[]>;
  /** Material on the board. */
  material: Record<Color, number>;
}

export function materialInfo(startFen: string, sans: string[]): MaterialInfo {
  const c = new Chess(startFen);
  const captured: Record<Color, string[]> = { w: [], b: [] };
  for (const san of sans) {
    const mv = c.move(san);
    if (mv.captured) captured[mv.color].push(mv.captured);
  }
  const material: Record<Color, number> = { w: 0, b: 0 };
  for (const row of c.board()) for (const sq of row) if (sq) material[sq.color] += VALUE[sq.type];
  return { captured, material };
}
