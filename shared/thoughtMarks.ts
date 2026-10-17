import { speakable } from "./speech";
import { newRules, type RulesMove, type Variant } from "./rules";
import type { Color, ThoughtMark } from "./types";

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
      // "f2/g2/h2" names each of its squares.
      const parts = sanKey(ws[k]).split("/");
      if (exact ? parts.includes(sq) : parts.some((w) => w.endsWith(sq))) return k;
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

/** A word naming a piece by its kind: "rook", "knights", "the d-pawn", "e8-knight", "passer". */
const PIECE_WORD = /(?:^|-)(?:king|queen|rook|bishop|knight|pawn|passer)(?:s|'s)?$/;

/** The quote's sentences, as word-index spans [first, last]. */
export function sentences(quote: string): [number, number][] {
  const out: [number, number][] = [];
  const n = quoteWords(quote).length;
  for (let k = 0; k < n; ) {
    const end = sentenceEnd(quote, k);
    out.push([k, end]);
    k = end + 1;
  }
  return out;
}

const KIND: Record<string, string> = { king: "k", queen: "q", rook: "r", bishop: "b", knight: "n", pawn: "p", passer: "p" };

export type Pointed = { sq: string } | { kind: string };

/**
 * What word w of a quote points at on the board: squares (on their own, or the square a move goes to or a
 * piece stands on: "e4", "Nc5", "Rxe8+", each of "f2/g2/h2"), or a piece by its kind ("the rook", "3
 * pawns", "the d-pawn"). Nothing, for any other word.
 */
export function pointsAt(w: string): Pointed[] {
  const key = sanKey(w);
  const parts = key.split("/");
  if (parts.every((p) => SQUARE_OR_MOVE.test(p)))
    return parts.flatMap((p) => {
      const sq = p.match(/([a-h][1-8])[qrbn]?$/)?.[1];
      return sq ? [{ sq }] : [];
    });
  const piece = bare(w).match(PIECE_WORD);
  return piece ? [{ kind: KIND[piece[0].replace(/^-/, "").replace(/(?:s|'s)$/, "")] }] : [];
}

/** A word a drawn item lights up, and whose piece it names (none for an empty square or no piece). */
export type WordLight = { word: number; color?: Color };

/**
 * A drawn item's colour comes from what it points at: `side`, the side whose piece it is (an arrow's piece,
 * the piece in a circle), or none for a circle on an empty square. Its words are coloured the same way.
 */
export type ItemColors = { side?: Color; lit: WordLight[] };

/** The kind of piece a move moves ("Rxe8+" a rook, "exd5" a pawn, castling the king). */
const moverKind = (san: string) => (/^[KQRBN]/.test(san) ? san[0].toLowerCase() : /^O-O/.test(san) ? "k" : "p");

/**
 * What each drawn item points at, by mark, which sets its colour on the board and in the bubble alike
 * (see ItemColors): the side of an arrow's piece, or of the piece in a circle (none, an empty square). And
 * the words it lights up: the nearest words in its mark's part of the quote naming the squares it touches
 * ("Rxe8+", "Rd6" for an arrow from d6) or the pieces it touches, by kind and owner ("the king attacks the
 * rook" for an arrow from the king to the rook, "Rook + 3 pawns" for circles on them), each in the colour
 * of whose piece it names. Pieces are read off the board as the mark imagines it: from the first of `fens`
 * (before the move, after it, then further back) where the mark's first arrow starts on a piece, each move
 * played on from there; a circle is on the piece a move drawn before it brought there, or else on what
 * stands there before the move.
 */
export function markColors(quote: string, marks: ThoughtMark[], fens: string[], mover: Color): { arrows: ItemColors[]; rings: ItemColors[] }[] {
  const ws = quoteWords(quote);
  const named = ws.map(pointsAt);
  const shown = boardOf(fens[0]);
  // Whose piece a piece word means, when the words before it say: "my king" is the speaker's, "White's
  // king" White's, "his rook" the opponent's; "the king" could be either.
  const other: Color = mover === "w" ? "b" : "w";
  const owner = ws.map((_, k): Color | undefined => {
    for (const w of [ws[k - 1], ws[k - 2]].map((x) => (x ? bare(x) : ""))) {
      if (/^(?:my|our|mine)$/.test(w)) return mover;
      if (/^white(?:'s)?$/.test(w)) return "w";
      if (/^black(?:'s)?$/.test(w)) return "b";
      if (/^(?:his|her|their|its|opponent's|enemy|your)$/.test(w)) return other;
    }
    return undefined;
  });
  return marks.map((mk, n) => {
    const lo = mk.word;
    const hi = (marks[n + 1]?.word ?? ws.length) - 1;
    // The nearest word in the mark's part of the quote that points at this square or kind of piece.
    // The nearest matching word from where the item is drawn on (what's about to be said: "vs knight + 3
    // pawns" for circles drawn on "knight"), or else the nearest before it ("my Rd6" for an arrow on "Nd7").
    const nearest = (word: number, test: (p: Pointed, k: number) => boolean) => {
      for (let k = Math.max(word, lo); k <= hi; k++) if (named[k].some((p) => test(p, k))) return k;
      for (let k = Math.min(word - 1, hi); k >= lo; k--) if (named[k].some((p) => test(p, k))) return k;
      return -1;
    };
    type Touched = Piece | undefined;
    // `squares`: each square with the piece on it (if any); `moved`: the word that names the move itself;
    // `say`: the words the director gave for the item, which are the ones lit when any of them names it.
    const lights = (word: number, squares: [string, Touched][], pieces: Touched[], moved?: Color, say?: [number, number]) => {
      const kindOk = (p: Pointed, at: number, pc: Piece) => "kind" in p && p.kind === pc.type && (!owner[at] || owner[at] === pc.color);
      // A move's own name is the side making it's; any other word naming a square, the piece on it.
      const sqColor = (k: number, pc: Touched) => (moved && k === word ? moved : pc?.color);
      if (say) {
        const given = new Map<number, Color | undefined>();
        for (let k = say[0]; k <= say[1]; k++)
          for (const p of named[k] ?? []) {
            const sq = squares.find(([s]) => "sq" in p && p.sq === s);
            if (sq && !given.has(k)) given.set(k, sqColor(k, sq[1]));
            const pc = pieces.find((x): x is Piece => !!x && kindOk(p, k, x));
            if (pc && !given.has(k)) given.set(k, pc.color);
          }
        if (given.size) return [...given].map(([w, color]) => ({ word: w, ...(color && { color }) }));
      }
      const out = new Map<number, Color | undefined>();
      for (const [sq, pc] of squares) {
        const k = nearest(word, (p) => "sq" in p && p.sq === sq);
        if (k >= 0 && !out.has(k)) out.set(k, sqColor(k, pc));
      }
      for (const pc of pieces) {
        if (!pc) continue;
        const k = nearest(word, (p, at) => kindOk(p, at, pc));
        if (k >= 0 && !out.has(k)) out.set(k, pc.color);
      }
      return [...out].map(([w, color]) => ({ word: w, ...(color && { color }) }));
    };
    const first = mk.arrows[0];
    const start = first ? fens.map(boardOf).find((b) => b.get(first.from) && (first.hit || b.get(first.from)!.type === moverKind(first.san))) : undefined;
    const board = new Map(start ?? shown);
    const arrived = new Map<string, { pc: Piece; word: number }>();
    const arrows = mk.arrows.map((a) => {
      const from = board.get(a.from) ?? (a.hit ? undefined : { type: moverKind(a.san), color: a.color });
      const to = board.get(a.to);
      if (!a.hit && from) {
        board.delete(a.from);
        board.set(a.to, from);
        arrived.set(a.to, { pc: from, word: a.word });
      }
      // A move's landing square, empty until it lands, is the moving piece's ("d4 attacks both…").
      const landing = to ?? (a.hit ? undefined : from);
      return { side: from?.color ?? a.color, lit: lights(a.word, [[a.from, from], [a.to, landing]], [from, to], a.hit ? undefined : a.color, a.say) };
    });
    const rings = mk.rings.map((r) => {
      // A square a move lands on has two pieces to circle: the one arriving and the one standing there
      // (the knight Rxe8+ takes). The circle's own words say which ("the pinned knight"); otherwise it's
      // the one arriving.
      const came = arrived.get(r.sq);
      const there = shown.get(r.sq);
      const options = [came && came.word <= r.word ? came.pc : undefined, there].filter((p): p is Piece => !!p);
      const [s0, s1] = r.say ?? [r.word, Math.min(r.word + 3, hi)];
      const says = (pc: Piece) => ws.slice(s0, s1 + 1).some((_, j) => named[s0 + j].some((p) => "kind" in p && p.kind === pc.type) && (!owner[s0 + j] || owner[s0 + j] === pc.color));
      const pc = options.find(says) ?? options[0];
      return { ...(pc && { side: pc.color }), lit: lights(r.word, [[r.sq, pc]], [pc], undefined, r.say) };
    });
    return { arrows, rings };
  });
}

/** A word as shown in a message: no surrounding punctuation. */
export const plainWord = (w: string) => w.replace(/^[^\p{L}\p{N}.]+|[^\p{L}\p{N}+#]+$/gu, "");

type Piece = { type: string; color: Color };

export function boardOf(fen: string): Map<string, Piece> {
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
