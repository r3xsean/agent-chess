import type { Color, MoveRecord } from "./types";
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

const onBoard = (fen: string) => {
  const at = new Map<string, string>();
  fen
    .split(" ")[0]
    .split("/")
    .forEach((row, r) => {
      let f = 0;
      for (const ch of row) {
        if (ch >= "1" && ch <= "8") f += Number(ch);
        else at.set(`${"abcdefgh"[f++]}${8 - r}`, ch);
      }
    });
  return at;
};

/**
 * materialTimeline for a game's own moves, read off the positions they record rather than replayed: the same
 * captures (a piece of the other side on the square moved to, or a pawn taken en passant) and the same material.
 */
export function gameMaterialTimeline(startFen: string, moves: Pick<MoveRecord, "color" | "from" | "to" | "fenBefore" | "fenAfter">[]): MaterialInfo[] {
  const captured: Record<Color, string[]> = { w: [], b: [] };
  const snapshot = (fen: string): MaterialInfo => {
    const material: Record<Color, number> = { w: 0, b: 0 };
    for (const ch of fen.split(" ")[0]) {
      const t = ch.toLowerCase();
      if (t in VALUE) material[ch === t ? "b" : "w"] += VALUE[t];
    }
    return { captured: { w: [...captured.w], b: [...captured.b] }, material };
  };
  const positions = [snapshot(startFen)];
  for (const m of moves) {
    const before = onBoard(m.fenBefore);
    const target = before.get(m.to);
    const mover = before.get(m.from);
    const theirs = (p: string | undefined) => !!p && (p === p.toLowerCase()) === (m.color === "w");
    if (theirs(target)) captured[m.color].push(target!.toLowerCase());
    else if (!target && mover?.toLowerCase() === "p" && m.from[0] !== m.to[0]) captured[m.color].push("p");
    positions.push(snapshot(m.fenAfter));
  }
  return positions;
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
