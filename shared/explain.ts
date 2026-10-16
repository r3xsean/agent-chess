import type { Chess, Square } from "chess.js";
import { looseChess, newRules, type Variant } from "./rules";
import type { IllegalTry } from "./types";

/** What was sent with each illegal attempt, lined up with the attempts (older games kept only the moves). */
export function triesOf(attempts: string[], details: IllegalTry[] | undefined): (IllegalTry | undefined)[] {
  const d = details ?? [];
  // Attempts made before the server kept details have none: those are the earliest ones.
  const skip = attempts.length - d.length;
  return attempts.map((_, i) => (i >= skip ? d[i - skip] : undefined));
}

const NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const LETTER: Record<string, string> = { N: "n", B: "b", R: "r", Q: "q", K: "k" };

/** Why a calculation line stops: the position after its legal prefix, explained at the broken token. */
export function lineBreakReason(fenBefore: string, line: { san: string[]; brokenAt?: string }, variant: Variant): string | null {
  if (!line.brokenAt) return null;
  const c = newRules(fenBefore, variant);
  for (const s of line.san) c.move(s);
  return explainIllegal(c.fen(), line.brokenAt);
}

/** Whether a piece could go from one square to another on an empty board (pawns move up the board for White). */
function shape(type: string, color: "w" | "b", from: Square, to: Square, capture: boolean): boolean {
  const dx = to.charCodeAt(0) - from.charCodeAt(0);
  const dy = (Number(to[1]) - Number(from[1])) * (color === "w" ? 1 : -1);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (!ax && !ay) return false;
  if (type === "n") return ax * ay === 2;
  if (type === "b") return ax === ay;
  if (type === "r") return !ax || !ay;
  if (type === "q") return ax === ay || !ax || !ay;
  if (type === "k") return ax <= 1 && ay <= 1;
  return capture ? ax === 1 && dy === 1 : !ax && (dy === 1 || (dy === 2 && Number(from[1]) === (color === "w" ? 2 : 7)));
}

/**
 * The move an illegal attempt would have made if the rules didn't apply, like a premove on the board:
 * which of the mover's pieces goes where. The piece is picked leniently — the one matching the
 * notation that could reach the square on an open board, else the nearest one of its kind. Null when
 * the token names no square or the mover has no such piece.
 */
export function illegalMovePath(fen: string, raw: string): { from: string; to: string; promo?: string; rook?: [string, string] } | null {
  const token = raw.trim().replace(/[+#!?]+$/, "");
  let c: Chess;
  try {
    c = looseChess(fen);
  } catch {
    return null;
  }
  const us = c.turn();
  const mine = c.board().flat().filter((s) => s && s.color === us) as { square: Square; type: string }[];

  const castle = /^(O-O(-O)?|0-0(-0)?)$/i.exec(token);
  if (castle) {
    const king = mine.find((s) => s.type === "k");
    if (!king) return null;
    const rank = king.square[1];
    const kingside = !castle[2];
    // The rook on that side of the king, on its rank, farthest out (the corner in standard chess).
    const rooks = mine.filter((s) => s.type === "r" && s.square[1] === rank && (s.square[0] > king.square[0]) === kingside);
    rooks.sort((a, b) => (kingside ? b.square.localeCompare(a.square) : a.square.localeCompare(b.square)));
    const to = `${kingside ? "g" : "c"}${rank}`;
    return { from: king.square, to, rook: rooks[0] ? [rooks[0].square, `${kingside ? "f" : "d"}${rank}`] : undefined };
  }

  const uci = /^([a-h][1-8])-?([a-h][1-8])([qrbn])?$/i.exec(token);
  if (uci && mine.some((s) => s.square === uci[1].toLowerCase())) return { from: uci[1].toLowerCase(), to: uci[2].toLowerCase(), promo: uci[3]?.toLowerCase() };

  const m = /^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(=?([QRBN]))?$/.exec(token);
  if (!m) return null;
  const [, pieceLetter, file, rank, x, target, , promoLetter] = m;
  const type = pieceLetter ? LETTER[pieceLetter] : "p";
  const to = target as Square;
  // A pawn move names its file only when capturing; otherwise the pawn comes from the target's own file.
  const fromFile = file ?? (type === "p" && !x ? to[0] : undefined);
  const capture = !!x || (type === "p" && !!file && file !== to[0]);
  let cands = mine.filter((s) => s.type === type && s.square !== to);
  const exact = cands.filter((s) => (!fromFile || s.square[0] === fromFile) && (!rank || s.square[1] === rank));
  if (exact.length) cands = exact;
  if (!cands.length) return null;
  const dx = (s: Square) => s.charCodeAt(0) - to.charCodeAt(0);
  const dy = (s: Square) => Number(s[1]) - Number(to[1]);
  // A bishop that can't reach the square is still more plausible on its colour.
  const offColour = (s: Square) => type === "b" && (dx(s) + dy(s)) % 2 !== 0;
  const score = (s: Square) => (shape(type, us, s, to, capture) ? 0 : 20) + (offColour(s) ? 10 : 0) + Math.hypot(dx(s), dy(s));
  const from = cands.reduce((a, b) => (score(b.square) < score(a.square) ? b : a)).square;
  const lastRank = to[1] === (us === "w" ? "8" : "1");
  return { from, to, promo: promoLetter ? LETTER[promoLetter] : type === "p" && lastRank ? "q" : undefined };
}

/**
 * Human-readable reason a move token is illegal in a position. For spectators only —
 * agents are never told why a move was rejected.
 */
export function explainIllegal(fen: string, raw: string): string {
  const token = raw.trim().replace(/[+#!?]+$/, "");
  let c: Chess;
  try {
    c = looseChess(fen);
  } catch {
    return "illegal";
  }
  const us = c.turn();
  const them = us === "w" ? "b" : "w";
  const side = us === "w" ? "White" : "Black";

  if (/^(O-O(-O)?|0-0(-0)?)$/i.test(token)) {
    if (c.inCheck()) return `${side} can't castle out of check`;
    return `${side} can't castle there (rights lost, pieces in the way, or the king would pass through an attacked square)`;
  }
  const m = /^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])(=?[QRBN])?$/.exec(token);
  if (!m) return `"${raw}" isn't valid move notation`;
  const [, pieceLetter, , , target] = m;
  const type = pieceLetter ? LETTER[pieceLetter] : "p";

  const kingSq = c.board().flat().find((s) => s && s.type === "k" && s.color === us)?.square as Square | undefined;
  const attackersOf = (sq: Square) =>
    c
      .attackers(sq, them)
      .map((a) => `the ${NAME[c.get(a)!.type]} on ${a}`)
      .join(" and ");

  if (type === "k" && kingSq) {
    // Lift the king off the board so it can't shield the square it's moving along.
    const king = c.remove(kingSq);
    const attacked = c.isAttacked(target as Square, them);
    const who = attacked ? attackersOf(target as Square) : "";
    if (king) c.put(king, kingSq);
    if (attacked) return `the king would walk into check from ${who}`;
    const own = c.get(target as Square);
    if (own && own.color === us) return `${target} is occupied by ${side}'s own ${NAME[own.type]}`;
    return `the king on ${kingSq} can't reach ${target}`;
  }

  const own = c.get(target as Square);
  if (own && own.color === us) return `${target} is occupied by ${side}'s own ${NAME[own.type]}`;
  // Pieces of this type that can legally go there: if any exist, the notation itself is the problem.
  const legal = c.moves({ verbose: true }).filter((mv) => mv.piece === type && mv.to === target);
  if (legal.length > 1) return `ambiguous — ${legal.map((mv) => `the ${NAME[type]} on ${mv.from}`).join(" and ")} can both go to ${target}, so the move must say which (${legal.map((mv) => mv.san).join(" / ")})`;
  if (legal.length === 1) return `the notation doesn't match the position — the only such move is ${legal[0].san}`;
  if (c.inCheck() && kingSq) return `${side} is in check from ${attackersOf(kingSq)}, and ${token} doesn't stop it`;

  // Lifting the piece off its square exposes our king → it's genuinely pinned.
  const isPinned = (sq: Square) => {
    if (!kingSq) return false;
    const piece = c.remove(sq);
    const exposed = c.isAttacked(kingSq, them);
    if (piece) c.put(piece, sq);
    return exposed;
  };

  if (type === "p") {
    const file = target.charCodeAt(0);
    const rank = Number(target[1]);
    const dir = us === "w" ? 1 : -1;
    const occupant = c.get(target as Square);
    if (token.includes("x")) {
      const shooters = c.attackers(target as Square, us).filter((sq) => c.get(sq)?.type === "p");
      if (!shooters.length) return `no ${side.toLowerCase()} pawn can capture on ${target}`;
      if (!occupant) return `there's nothing on ${target} to capture`;
      const pinnedPawn = shooters.find(isPinned);
      return pinnedPawn ? `the pawn on ${pinnedPawn} is pinned — capturing would expose the king` : `that capture isn't possible here`;
    }
    if (occupant) return `${target} is occupied — pawns can't capture straight ahead`;
    const one = `${String.fromCharCode(file)}${rank - dir}` as Square;
    const two = `${String.fromCharCode(file)}${rank - 2 * dir}` as Square;
    const isOwnPawn = (sq: Square) => c.get(sq)?.type === "p" && c.get(sq)?.color === us;
    let from: Square | null = null;
    if (isOwnPawn(one)) from = one;
    else if (rank === (us === "w" ? 4 : 5) && !c.get(one) && isOwnPawn(two)) from = two;
    else if (rank === (us === "w" ? 4 : 5) && c.get(one) && isOwnPawn(two)) return `the pawn on ${two} is blocked by the piece on ${one}`;
    if (!from) return `no ${side.toLowerCase()} pawn can reach ${target}`;
    return isPinned(from) ? `the pawn on ${from} is pinned — moving it would expose the king` : `that pawn move isn't possible here`;
  }

  // Any other piece that attacks the square but can't legally go there must be pinned to its king.
  const pinned = c.attackers(target as Square, us).filter((sq) => c.get(sq)?.type === type);
  const reallyPinned = pinned.find(isPinned);
  if (reallyPinned) return `the ${NAME[type]} on ${reallyPinned} is pinned — moving it would expose the king`;
  if (pinned.length) return `that move isn't possible here`;
  if (c.inCheck() && kingSq) return `${side} is in check from ${attackersOf(kingSq)}, and ${token} doesn't stop it`;
  const mine = c.board().flat().filter((s) => s && s.type === type && s.color === us);
  if (!mine.length) return `${side} has no ${NAME[type]} left`;
  return `no ${side.toLowerCase()} ${NAME[type]} can reach ${target}`;
}
