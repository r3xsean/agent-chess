import { speakable } from "./speech";
import { newRules, type RulesMove, type Variant } from "./rules";
import type { Color } from "./types";

/*
 * A player's calculation drawn on the board while their quote is spoken (see ThoughtMark): the director
 * names the words and the moves, the server works out which position the moves are played from, and the
 * timeline times each arrow to the voice saying it.
 */

export const quoteWords = (q: string) => q.trim().split(/\s+/).filter(Boolean);

/** A word as compared: lower case, plain quotes and dashes, no punctuation at either end. */
const bare = (w: string) =>
  w
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, "-")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** A move number or the dots of a Black move, before a move: "27.", "27...", "...", "…". */
const MOVE_NUMBER = /^\d*\s*(?:\.+|…)\s*/;

/** A move as compared: no move number, capture, check or annotation marks ("27...Rxc2+!" → "rc2"). */
const sanKey = (w: string) =>
  bare(w)
    .replace(MOVE_NUMBER, "")
    .replace(/0/g, "o")
    .replace(/[x+#!?=:]/g, "");

/** A move as written in commentary, ready to play: no move number or annotation. */
export const cleanSan = (s: string) =>
  s
    .trim()
    .replace(MOVE_NUMBER, "")
    .replace(/[!?]+$/, "");

/** The quote's words that say something (a lone dash or ellipsis doesn't), with their indexes. */
const sayingWords = (quote: string) =>
  quoteWords(quote)
    .map((w, k) => ({ w: bare(w), k }))
    .filter((x) => x.w);

/** Where a phrase starts in a quote, as a word index (at or after `from`); -1 if it isn't there. */
export function phraseAt(quote: string, phrase: string, from = 0): number {
  const q = sayingWords(quote);
  const p = quoteWords(phrase).map(bare).filter(Boolean);
  if (!p.length) return -1;
  for (let j = 0; j + p.length <= q.length; j++) if (q[j].k >= from && p.every((w, n) => q[j + n].w === w)) return q[j].k;
  return -1;
}

/** The first word in [from, to) that names this move (as the director wrote it, or as played); -1 if none. */
export function moveWordAt(quote: string, sans: string[], from: number, to: number): number {
  const keys = new Set(sans.map(sanKey).filter(Boolean));
  const ws = quoteWords(quote);
  for (let k = from; k < Math.min(to, ws.length); k++) if (keys.has(sanKey(ws[k]))) return k;
  return -1;
}

/** The first word in [from, to) that names this square: on its own ("on f5"), or ending a move ("Nf5"). */
export function squareWordAt(quote: string, sq: string, from: number, to: number): number {
  const ws = quoteWords(quote).slice(0, to);
  for (const exact of [true, false])
    for (let k = from; k < ws.length; k++) {
      const w = sanKey(ws[k]);
      if (exact ? w === sq : w.endsWith(sq)) return k;
    }
  return -1;
}

/** Where a phrase ends in a quote (its last word's index), looking at or after `from`; -1 if it isn't there. */
export function phraseEnd(quote: string, phrase: string, from = 0): number {
  const start = phraseAt(quote, phrase, from);
  if (start < 0) return -1;
  const n = quoteWords(phrase).map(bare).filter(Boolean).length;
  const q = sayingWords(quote);
  return q[q.findIndex((x) => x.k === start) + n - 1].k;
}

/** A move or a square, as a word reads once compared ("Rxe8+" → "re8", "exd5" → "ed5", "O-O" → "o-o"). */
const SQUARE_OR_MOVE = /^(?:[kqrbn][a-h]?[1-8]?[a-h][1-8]|[a-h][a-h]?[1-8](?:[qrbn])?|o-o(?:-o)?)$/;

/** The words of a quote that name a move or a square ("Kf3", "...Rxe8+", "e2", "O-O"), as written. */
export function boardWords(quote: string): string[] {
  return quoteWords(quote).filter((w) => SQUARE_OR_MOVE.test(sanKey(w)));
}

/** Whether quote word `w` itself names this move (as written or as played) or, ending it, this square. */
export function wordNames(w: string | undefined, what: { sans?: string[]; sq?: string }): boolean {
  if (!w) return false;
  const k = sanKey(w);
  if (!k) return false;
  if (what.sans?.some((s) => sanKey(s) === k)) return true;
  return !!what.sq && k.endsWith(what.sq);
}

/**
 * The last word of the sentence that word k is in. A sentence ends at a full stop, question or exclamation
 * mark, but not at a move number ("27.", "27...") or a move's annotation ("f6!", "Nxe5!?").
 */
export function sentenceEnd(quote: string, k: number): number {
  const ws = quoteWords(quote);
  for (let j = Math.max(0, k); j < ws.length; j++) {
    const w = ws[j].replace(/["'”’)\]]+$/, "");
    if (!/[.!?…]$/.test(w)) continue;
    if (/^\d*\s*(?:\.+|…)$/.test(w)) continue;
    const body = w.replace(/[.!?…]+$/, "");
    const annotation = /[!?]$/.test(w) && SQUARE_OR_MOVE.test(sanKey(body));
    if (!annotation) return j;
  }
  return ws.length - 1;
}

type Piece = { type: string; color: Color };

function boardOf(fen: string): Map<string, Piece> {
  const out = new Map<string, Piece>();
  fen
    .split(" ")[0]
    .split("/")
    .forEach((row, r) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else {
          out.set(`${"abcdefgh"[f]}${8 - r}`, { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? "w" : "b" });
          f++;
        }
      }
    });
  return out;
}

const PIECE_NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

/**
 * Whether the piece on `from` reaches `to` on this board: attacks or defends it, or, for a long-range piece,
 * through one piece in between (a pin, a skewer, a battery, the x-ray of a rook behind a knight). A pawn
 * reaches the squares it captures on and its path up the file (the passer running to promote).
 */
function reaches(board: Map<string, Piece>, from: string, to: string): boolean {
  const pc = board.get(from)!;
  const fx = from.charCodeAt(0) - 97;
  const fy = Number(from[1]) - 1;
  const dx = to.charCodeAt(0) - 97 - fx;
  const dy = Number(to[1]) - 1 - fy;
  if (!dx && !dy) return false;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const between = () => {
    let n = 0;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    for (let x = fx + sx, y = fy + sy; x !== fx + dx || y !== fy + dy; x += sx, y += sy) if (board.has(`${"abcdefgh"[x]}${y + 1}`)) n++;
    return n;
  };
  switch (pc.type) {
    case "n":
      return (ax === 1 && ay === 2) || (ax === 2 && ay === 1);
    case "k":
      return ax <= 1 && ay <= 1;
    case "p": {
      const up = pc.color === "w" ? 1 : -1;
      if (ax === 1 && dy === up) return true;
      return !dx && Math.sign(dy) === up && between() === 0;
    }
    case "b":
      return ax === ay && between() <= 1;
    case "r":
      return (!dx || !dy) && between() <= 1;
    case "q":
      return (ax === ay || !dx || !dy) && between() <= 1;
  }
  return false;
}

/** "d4>f3", "Nd4>f3", "d4->f3", "d4-f3": a piece's reach, drawn as an arrow (see drawnLine). */
const HIT = /^([KQRBNP])?([a-h][1-8])\s*(?:->|>|→|-)\s*([a-h][1-8])$/;
export const isHit = (s: string) => HIT.test(s.trim());

/** One thing a mark draws: a move, or a piece's reach. */
export type Drawn = { san: string; from: string; to: string; color: Color; hit?: boolean };

/**
 * What a mark draws, in order, on the board as it imagines it: each move (SAN) played on from the ones
 * before it, each reach ("d4>f3") from where the pieces stand by then, so "Nd4 hits f3 and e6" draws the
 * fork from d4. The board starts from the first of `fens` where everything holds, sides alternating;
 * failing that, letting a side move twice where the line needs it (a threat named before it's the
 * opponent's turn, or "g6 and then h5"). When nothing holds, `stuck` is the first item none of them could
 * draw, and `why` says what was wrong with it.
 */
export function drawnLine(fens: string[], items: string[], variant: Variant): { drawn: Drawn[] } | { stuck: number; why: string } {
  let best = { stuck: 0, why: "" };
  for (const pass of [false, true])
    for (const fen of fens) {
      let pos = fen;
      const out: Drawn[] = [];
      let why = "";
      for (const item of items) {
        const hit = item.trim().match(HIT);
        if (hit) {
          const [, letter, from, to] = hit;
          const board = boardOf(pos);
          const pc = board.get(from);
          if (!pc) why = `there's no piece on ${from}`;
          else if (letter && letter.toLowerCase() !== pc.type) why = `the piece on ${from} is a ${PIECE_NAME[pc.type]}`;
          else if (!reaches(board, from, to)) why = `the ${PIECE_NAME[pc.type]} on ${from} doesn't reach ${to}`;
          if (why) break;
          out.push({ san: `${from}>${to}`, from, to, color: pc!.color, hit: true });
          continue;
        }
        const mv = tryMove(pos, item, variant) ?? (pass ? tryMove(passed(pos), item, variant) : null);
        if (!mv) {
          why = "it isn't legal there";
          break;
        }
        out.push({ san: mv.san, from: mv.from, to: mv.to, color: mv.color });
        pos = mv.after;
      }
      if (out.length === items.length) return { drawn: out };
      if (out.length >= best.stuck) best = { stuck: out.length, why };
    }
  return best;
}

/** The same position with the other side to move (a threat, or a second move of one's own). */
function passed(fen: string): string {
  const p = fen.split(" ");
  p[1] = p[1] === "w" ? "b" : "w";
  p[3] = "-";
  return p.join(" ");
}

function tryMove(fen: string, san: string, variant: Variant): RulesMove | null {
  try {
    return newRules(fen, variant).move(cleanSan(san));
  } catch {
    return null;
  }
}

/** Which of the spoken words (of `speakable(quote)`) quote word k turns into. */
export const spokenWord = (quote: string, k: number) => quoteWords(speakable(quoteWords(quote).slice(0, k).join(" "))).length;
