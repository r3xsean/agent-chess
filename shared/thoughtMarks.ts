import { speakable } from "./speech";
import { newRules, type RulesMove, type Variant } from "./rules";

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

/**
 * The moves a player named, played out: from the first of `fens` where they make a legal line, sides
 * alternating; failing that, letting a side move twice where the line needs it (a threat named before
 * it's the opponent's turn, or "g6 and then h5"). When no reading is legal, `stuck` is the first move
 * that none of them could play.
 */
export function namedLine(fens: string[], sans: string[], variant: Variant): { moves: RulesMove[] } | { stuck: number } {
  let stuck = 0;
  for (const pass of [false, true])
    for (const fen of fens) {
      let pos = fen;
      const out: RulesMove[] = [];
      for (const san of sans) {
        const mv = tryMove(pos, san, variant) ?? (pass ? tryMove(passed(pos), san, variant) : null);
        if (!mv) break;
        out.push(mv);
        pos = mv.after;
      }
      if (out.length === sans.length) return { moves: out };
      stuck = Math.max(stuck, out.length);
    }
  return { stuck };
}

/** Which of the spoken words (of `speakable(quote)`) quote word k turns into. */
export const spokenWord = (quote: string, k: number) => quoteWords(speakable(quoteWords(quote).slice(0, k).join(" "))).length;
