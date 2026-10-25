import { looseChess } from "../shared/rules";
import type { Color } from "../shared/types";

/*
 * What a seat's experiment toggles (shared/seatSetup.ts) ask of each move before it's played: the board picture's
 * check code, and the player's own list of every piece on the board.
 */

/** One piece as written ("Kg1", "Pa2", "a2" for a pawn, "N f3"), as "<type><square>", or null if it isn't one. */
function piece(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // "b4" is a pawn on b4; "bc4" a bishop on c4.
  const m = /^\s*([KQRBNP])?\s*-?\s*([a-h][1-8])\s*$/i.exec(raw);
  if (!m) return null;
  return `${(m[1] ?? "p").toLowerCase()}${m[2].toLowerCase()}`;
}

/**
 * Why a written-out position can't be checked (it isn't in the asked-for shape), or null. Checked apart from
 * whether it matches, so a format slip isn't counted as a misread.
 */
export function positionShapeError(input: unknown): string | null {
  const ex = '"position": { "white": ["Kg1", "Qd1", "Pa2", …], "black": ["Ke8", "Pa7", …] }';
  if (!input || typeof input !== "object") return `\`position\` is required: every piece on the board, as ${ex}.`;
  const o = input as Record<string, unknown>;
  for (const side of ["white", "black"]) {
    const list = o[side];
    if (!Array.isArray(list)) return `\`position.${side}\` must be a list of pieces, as ${ex}.`;
    const bad = list.find((x) => piece(x) === null);
    if (bad !== undefined) return `\`position.${side}\` has ${JSON.stringify(bad)}, which isn't a piece and a square (write each as a letter K Q R B N P and a square, e.g. "Nf3", "Pa2").`;
  }
  return null;
}

/** Whether a written-out position (in the right shape) has exactly the pieces on the board: no more, no fewer, none moved. */
export function positionMatches(fen: string, input: unknown): boolean {
  const o = input as Record<string, unknown[]>;
  const board = looseChess(fen)
    .board()
    .flat()
    .filter((s): s is NonNullable<typeof s> => !!s);
  for (const color of ["w", "b"] as Color[]) {
    const want = board.filter((s) => s.color === color).map((s) => `${s.type}${s.square}`).sort();
    const got = (o[color === "w" ? "white" : "black"] ?? []).map(piece).sort();
    if (want.length !== got.length || want.some((x, i) => x !== got[i])) return false;
  }
  return true;
}

/** Whether a sent check code is the picture's (letters in any case, spaces ignored). */
export const codeMatches = (sent: unknown, code: string) => typeof sent === "string" && sent.replace(/\s+/g, "").toUpperCase() === code;
