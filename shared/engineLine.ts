import type { Classification, Color, Game, LineRef } from "./types";
import { variantOf, type RulesMove } from "./rules";
import { sideName } from "./naming";
import { tally, trade, walk, type Tally } from "./why";
import { boardOf, describe, owners, plainWord, pointsAt, quoteWords, type Piece, type RefColor } from "./thoughtMarks";

const PIECE_NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

/*
 * An engine line the replay plays out on the board right after a key move, when the director asks for
 * one. Two kinds:
 * - "instead": what the engine wanted in place of the move (a miss, a mistake, a blunder);
 * - "after": the engine's best play from the position the move left, worth showing only when the game
 *   went another way: the punishment of a bad move that the reply didn't find, or the point of a
 *   brilliant or great move that never got played out. When the game follows the engine, the real moves
 *   already show it.
 * A line is only on offer when it shows something concrete: a mate, a promotion, at least MIN_GAIN pawns
 * of material, or (when no material changes hands) a winning chance of BIG_SWING points kept or thrown
 * away: the pawn ending a king step loses, the won position a quiet push gives back.
 */

export type LineKind = "instead" | "after";
export const LINE_KINDS: LineKind[] = ["instead", "after"];

export interface ShownLine {
  kind: LineKind;
  /** The move it's about (index into moves). */
  i: number;
  /** The position it starts from: before move i ("instead") or after it ("after"). */
  fen: string;
  moves: RulesMove[];
  /** The side it's good for. */
  for: Color;
  /** Moves the winning side needs to mate, when it ends in mate. */
  mate?: number;
  /**
   * What it's worth to that side in material, in pawns, once the captures have settled: what it wins, or
   * for an "instead" line, how much better it does than the move played (0 for a mate).
   */
  net: number;
  /** What it shows in plain words, for the director's brief: "Black mates in 3", "White wins a knight". */
  fact: string;
  /** The one-liner shown under it when the director writes none. */
  caption: string;
  /**
   * For an "instead" line, what the move played allowed, when that shows something concrete (a mate, or at
   * least MIN_GAIN pawns lost): the move played, then the engine's line after it, cut where its captures
   * settle. `fact` says it in plain words for the brief. What it means is the director's to say.
   */
  punish?: { moves: RulesMove[]; fact: string };
}

/**
 * A quiet line is cut after `plies` (an exchange in progress may run a few more); a mate is shown whole when
 * it comes within `mate` plies. Lines followed move by move (deep) run longer than the ones read off a single
 * PV, which plans saved before deep lines still use (`legacy`), so a saved plan's lines never change shape.
 */
const CAPS = { deep: { plies: 14, mate: 21 }, legacy: { plies: 8, mate: 11 } };
/** How much of a line without captures is shown. */
const QUIET_PLIES = 4;
/** How far an engine line is followed, position by position (server/lineDepth.ts analyses that far). */
export const LINE_WALK = 24;

/**
 * The engine's line from a position: its best move there, then the best move in the position that leaves,
 * and so on, for as long as the positions along it have been analysed (server/lineDepth.ts analyses them
 * one by one, deeper and more reliable than one search's PV); then the rest of the last analysed position's PV.
 */
export function enginePath(g: Game, fen: string, max = LINE_WALK): RulesMove[] {
  const variant = variantOf(g);
  const out: RulesMove[] = [];
  let pos = fen;
  while (out.length < max) {
    const a = g.analysis[pos];
    if (!a || a.failed || !a.pv?.length) break;
    const [first] = walk(pos, [a.bestUci ?? a.pv[0]], variant);
    if (!first) break;
    const next = g.analysis[first.after];
    if (!next || next.failed) {
      out.push(...walk(pos, a.pv, variant).slice(0, max - out.length));
      break;
    }
    out.push(first);
    pos = first.after;
  }
  return out;
}

/**
 * The verdict on each move of an engine line (best, great: the only move, brilliant: a sound sacrifice,
 * forced: the only legal one), where the position it's played from has been analysed that far; a move the
 * game played keeps the game's verdict.
 */
export function lineVerdicts(g: Game, moves: RulesMove[]): (Classification | undefined)[] {
  return moves.map((mv) => {
    const played = g.moves.find((m) => m.fenBefore === mv.before && m.uci === mv.uci);
    if (played?.analysis && !played.analysis.unavailable) return played.analysis.classification;
    const a = g.analysis[mv.before];
    return a && !a.failed && (a.bestUci ?? a.pv?.[0]) === mv.uci ? a.bestVerdict : undefined;
  });
}

/**
 * A line cut back to its payoff: the first point where it has won all it's going to win (a mate is kept
 * whole), so the trades that follow a win don't drag on.
 */
function toPayoff(moves: RulesMove[], side: Color): RulesMove[] {
  if (mates(moves)) return moves;
  const all = tally(moves, side, true);
  for (let k = 1; k < moves.length; k++) {
    const mv = moves[k - 1];
    if (!mv.captured && !mv.promotion) continue;
    if (moves[k].captured) continue;
    const t = tally(moves.slice(0, k), side, true);
    if (t.net === all.net && t.promoted.length === all.promoted.length) return moves.slice(0, k);
  }
  return moves;
}

/** The part of an engine line worth playing: up to the mate, or to where its captures have settled, ending on the payoff. */
function settle(all: RulesMove[], legacy = false): RulesMove[] {
  const { plies, mate } = CAPS[legacy ? "legacy" : "deep"];
  const mateAt = all.findIndex((mv) => mv.san.endsWith("#"));
  if (mateAt >= 0 && mateAt < mate) return all.slice(0, mateAt + 1);
  let k = Math.min(all.length, plies);
  // An exchange still going at the cut is played to its end (a few plies more at most), or left out.
  while (k < all.length && k < plies + 4 && all[k].captured) k++;
  if (k < all.length && all[k].captured) while (k > 0 && all[k - 1].captured) k--;
  // It ends on the payoff: the last capture or promotion. A line with neither (a quiet move that just
  // keeps everything, say) shows its first few moves.
  while (k > 0 && !all[k - 1].captured && !all[k - 1].promotion) k--;
  return all.slice(0, k || Math.min(QUIET_PLIES, all.length));
}

const mates = (moves: RulesMove[]) => !!moves.at(-1)?.san.endsWith("#");

/** What a line wins for a side: "a knight", "a pawn promoted and a rook"; as a verb phrase in the tense asked. */
function prize(t: Tally, side: Color, form: "bare" | "past" | "present", mate?: number): string {
  const [force, win, promote] = form === "bare" ? ["force", "win", "promote"] : form === "past" ? ["forced", "won", "promoted"] : ["forces", "wins", "promotes"];
  if (mate) return `${force} mate in ${mate}`;
  const won = trade(t.won, t.lost);
  if (t.promoted.includes(side)) return `${promote} a pawn${won ? ` and ${win} ${won}` : ""}`;
  return `${win} ${won || "material"}`;
}

/**
 * Moves that went wrong: what the engine wanted instead, or how they could have been punished. An
 * inaccuracy counts too (an unsound sacrifice often rates only that), but like any line it still has to
 * show something concrete.
 */
const WRONG: Classification[] = ["inaccuracy", "mistake", "miss", "blunder"];
/** Moves whose point a line can show, when the game didn't play it out. */
const STRONG: Classification[] = ["brilliant", "great"];
/** Material a line has to win to be worth playing, in pawns (a mate or a promotion always is). */
const MIN_GAIN = 2;
/** Without material, the winning chance (in points of win%) a line has to keep or give for it to be worth playing. */
const BIG_SWING = 25;

/** What a winning chance amounts to, in words: "a winning position", "the balance". */
function standing(win: number): string {
  if (win >= 80) return "a winning position";
  if (win >= 65) return "a clear advantage";
  if (win >= 55) return "the better game";
  if (win >= 40) return "the balance";
  return "drawing chances";
}

/**
 * The line of a kind for move i, or null when there's none worth showing. `legacy`: read off the stored PV
 * alone, as plans saved before deep lines were validated (see CAPS), so they keep exactly their lines.
 * `asked`: a line a plan asks for by name (a what-if the user wants), shown whenever the engine has one the
 * game didn't play, even when it wouldn't be offered (lineOptions) for winning too little. A line the move's
 * best-move arrow already shows (obvious) still isn't.
 */
export function shownLine(g: Game, i: number, kind: LineKind, legacy = false, asked = false): ShownLine | null {
  const l = rawLine(g, i, kind, legacy, asked);
  return l && !legacy && obvious(g, l) ? null : l;
}

/**
 * A line the viewer already sees from the move and its best-move arrow: its first move is a capture (or a
 * promotion) that wins everything the line wins, with no mate and no hard move (great, brilliant) after it.
 * A line that starts quietly always shows something: the move that holds, or sets something up.
 */
export function obvious(g: Game, l: ShownLine): boolean {
  if (lineVerdicts(g, l.moves).some((v) => v === "great" || v === "brilliant")) return false;
  const first = l.moves[0];
  if (!first.captured && !first.promotion) return false;
  const one = tally(l.moves.slice(0, 1), l.for, true);
  // A first move that wins a piece or more is the whole story, even when a long mate follows (that's mopping up).
  if (one.net >= OBVIOUS_GAIN) return true;
  if (mates(l.moves)) return false;
  const all = tally(l.moves, l.for, true);
  return one.net >= all.net && one.promoted.length >= all.promoted.length;
}
/** What a first move has to win on its own, in pawns, for its line to be what the arrow already shows. */
const OBVIOUS_GAIN = 3;

function rawLine(g: Game, i: number, kind: LineKind, legacy: boolean, asked: boolean): ShownLine | null {
  const m = g.moves[i];
  const cls = m?.analysis?.classification;
  if (!m || !cls || m.analysis!.unavailable) return null;
  const variant = variantOf(g);
  const mover = m.color;
  const opp: Color = mover === "w" ? "b" : "w";
  const fen = kind === "instead" ? m.fenBefore : m.fenAfter;
  const a = g.analysis[fen];
  if (!a || a.failed || a.depth <= 0 || !a.pv?.length) return null;
  const path = (from: string) => (legacy ? walk(from, g.analysis[from] && !g.analysis[from].failed ? g.analysis[from].pv : [], variant) : enginePath(g, from));
  const trim = (ms: RulesMove[], side: Color) => (legacy ? ms : toPayoff(ms, side));
  let moves = settle(path(fen), legacy);
  if (!moves.length) return null;
  const name = (c: Color) => sideName(g, c);
  const mated = mates(moves);
  const winner = mated ? moves.at(-1)!.color : null;
  const played = walk(m.fenBefore, [m.uci], variant);

  const mateIn = (c: Color) => moves.filter((mv) => mv.color === c).length;

  if (kind === "instead") {
    // The mover's better way. What makes it better is measured against what the move played led to: a
    // mate, material it wins, or just not losing what the move played lost (or not getting mated).
    if ((!WRONG.includes(cls) && !asked) || (a.bestUci ?? a.pv[0]) === m.uci || (mated && winner !== mover)) return null;
    moves = trim(moves, mover);
    const actual = trim(settle([...played, ...path(m.fenAfter)], legacy), opp);
    const actualMates = mates(actual) && actual.at(-1)!.color === mover;
    const actualMated = mates(actual) && !actualMates;
    const t = tally(moves, mover, true);
    const tA = tally(actual, mover, true);
    const who = name(mover);
    const first = moves[0].san;
    // What the move played allowed, counted to the end (settle already stops where the captures do).
    const tP = tally(actual, mover, true);
    const punish =
      actual.length > 1 && (actualMated || tP.net <= -MIN_GAIN)
        ? { moves: actual, fact: actualMated ? `${name(opp)} mates` : `${name(opp)} wins ${trade(tP.lost, tP.won) || "material"}` }
        : undefined;
    const line = (fact: string, caption: string, net: number, mate?: number): ShownLine => ({ kind, i, fen, moves, for: mover, mate, net, fact, caption, ...(punish && { punish }) });
    const kept = m.analysis!.winBefore;
    const got = m.analysis!.winAfter;
    // Not worth offering, but asked for: the engine's way, said plainly.
    const plain = () =>
      !asked
        ? null
        : kept - got >= 1
          ? line(`${who} keeps ${standing(kept)} (${Math.round(kept)}% instead of ${Math.round(got)}%)`, `${first} would have kept ${standing(kept)}.`, 0)
          : line(`the engine's choice, played out`, `${first} was the engine's choice.`, 0);
    if (mated) {
      if (actualMates && actual.length <= moves.length) return plain();
      const mate = mateIn(mover);
      return line(`${who} forces mate in ${mate}`, `${first} would have forced mate in ${mate}.`, 0, mate);
    }
    if (actualMates) return plain();
    if (actualMated) return line(`${who} avoids the mate ${m.san} allows`, `${first} would have avoided mate.`, 0);
    const swing = t.net - tA.net;
    if (swing < MIN_GAIN) {
      // No material in it: worth showing only when the move threw away a big share of the winning chances.
      if (kept - got < BIG_SWING) return plain();
      return line(`${who} keeps ${standing(kept)} (${Math.round(kept)}% instead of ${Math.round(got)}%)`, `${first} would have kept ${standing(kept)}.`, 0);
    }
    if (t.net >= MIN_GAIN || t.promoted.includes(mover)) return line(`${who} ${prize(t, mover, "present")} (+${t.net})`, `${first} would have ${prize(t, mover, "past")}.`, swing);
    const lost = trade(tA.lost, tA.won) || "material";
    return line(`${who} doesn't lose ${lost}, as ${m.san} does (${swing} pawns better)`, `${first} would have avoided losing ${lost}.`, swing);
  }

  // "after": the opponent's punishment of a move that went wrong, when their reply went elsewhere; or the
  // point of a strong move, when the game went another way within the line.
  // Asked for, it only has to leave the game somewhere along it.
  const followed = (n: number) => moves.slice(0, n).every((mv, k) => g.moves[i + 1 + k]?.uci === mv.uci);
  let side: Color;
  if (WRONG.includes(cls)) {
    side = opp;
    if (followed(asked ? moves.length : 1)) return null;
  } else if (STRONG.includes(cls) || asked) {
    side = STRONG.includes(cls) ? mover : opp;
    if (followed(moves.length)) return null;
  } else return null;
  if (mated && winner !== side) return null;
  moves = trim(moves, side);
  // Counted from before the move, so taking back what the move just took isn't a gain.
  const t = tally([...played, ...moves], side, true);
  if (!mated && t.net < MIN_GAIN && !t.promoted.includes(side)) {
    // No material in it: a punishment is still worth showing when the reply let a big winning chance go.
    const reply = g.moves[i + 1]?.analysis;
    const could = 100 - m.analysis!.winAfter;
    const plain = (): ShownLine | null =>
      asked ? { kind, i, fen, moves, for: side, net: 0, fact: `${name(side)}'s best play from here (${standing(side === opp ? could : 100 - could)})`, caption: `${name(side)}'s best play from here.` } : null;
    if (side !== opp || !reply) return plain();
    if (could - reply.winAfter < BIG_SWING) return plain();
    const fact = `${name(opp)} reaches ${standing(could)} (${Math.round(could)}% instead of ${Math.round(reply.winAfter)}%)`;
    return { kind, i, fen, moves, for: side, net: 0, fact, caption: `${name(opp)} could have reached ${standing(could)}.` };
  }
  const mate = mated ? mateIn(side) : undefined;

  const fact = `${name(side)} ${prize(t, side, "present", mate)}${mate ? "" : ` (+${t.net})`}`;
  const caption = side === opp ? `${name(opp)} could have ${prize(t, side, "past", mate)}.` : `${m.san} was set to ${prize(t, side, "bare", mate)}.`;
  return { kind, i, fen, moves, for: side, mate, net: mate ? 0 : t.net, fact, caption };
}

/**
 * The line a plan shows for move i: the one it chose (deep, or as it was for plans from before), cut to the
 * `end` the director gave it.
 */
export function planLine(g: Game, i: number, ask: { kind: LineKind; deep?: true; end?: number }): ShownLine | null {
  const sl = shownLine(g, i, ask.kind, !ask.deep, true);
  if (!sl || !ask.end || ask.end >= sl.moves.length) return sl;
  return { ...sl, moves: sl.moves.slice(0, Math.max(1, ask.end)) };
}

/** The lines on offer for move i. */
export function lineOptions(g: Game, i: number): ShownLine[] {
  return LINE_KINDS.map((k) => shownLine(g, i, k)).filter((l): l is ShownLine => !!l);
}

/*
 * A caption's refs (see LineRef), on the board as it stands when the caption shows: `k` of `moves` played
 * from `fen` (the line's moves, or the punishment's, the move played first). Colours are by side; the
 * video shows the side the line favours green.
 */

/** The position once k of the moves are played. */
export const fenAt = (fen: string, moves: RulesMove[], k: number) => (k ? moves[k - 1].after : fen);

/**
 * What each ref points at: a move is its side's; squares are what stands on them, or, when its words name
 * a kind of piece ("the rook", "White's knight", "Nd4"), the piece of that kind there or there earlier in
 * the line (the rook a capture took). A ref naming a piece that isn't there is a problem. Nothing is
 * guessed: a caption without refs lights nothing.
 */
export function resolveLineRefs(caption: string, refs: LineRef[], fen: string, moves: RulesMove[], k: number, side: Color): RefColor[] {
  const ws = quoteWords(caption);
  const owner = owners(ws, side);
  const now = boardOf(fenAt(fen, moves, k));
  const boards = Array.from({ length: k }, (_, j) => boardOf(fenAt(fen, moves, j)));
  const before = (sq: string) => boards.map((b) => b.get(sq)).filter((p): p is Piece => !!p);
  return refs.map((ref) => {
    if (ref.move !== undefined) return { color: moves[ref.move].color, pieces: [] };
    const [k0, k1] = ref.words;
    const said = ws.slice(k0, k1 + 1).join(" ");
    const wanted: { kind: string; owner?: Color; sq?: string }[] = [];
    for (let w = k0; w <= k1; w++) {
      for (const p of pointsAt(ws[w])) if ("kind" in p) wanted.push({ kind: p.kind, owner: owner[w] });
      const san = ws[w].replace(/^[^A-Za-z]+/, "").match(/^([KQRBN])x?[a-h]?[1-8]?x?([a-h][1-8])/);
      if (san) wanted.push({ kind: san[1].toLowerCase(), sq: san[2] });
    }
    const pieces: (Piece | undefined)[] = [];
    for (const sq of ref.sqs ?? []) {
      const here = now.get(sq);
      const forSq = wanted.filter((w) => !w.sq || w.sq === sq);
      if (!forSq.length) {
        pieces.push(here);
        continue;
      }
      const fits = (pc: Piece) => forSq.some((w) => w.kind === pc.type && (!w.owner || w.owner === pc.color));
      const pc = [here, ...before(sq)].find((p): p is Piece => !!p && fits(p));
      if (!pc) return { problem: `"${said}" names ${forSq.map((w) => `${w.owner ? (w.owner === "w" ? "White's " : "Black's ") : ""}${PIECE_NAME[w.kind]}`).join(" or ")}, but ${sq} holds ${describe(here)} then` };
      pieces.push(pc);
    }
    const sides = [...new Set(pieces.filter((p): p is Piece => !!p).map((p) => p.color))];
    if (sides.length > 1) return { problem: `"${said}" points at both sides' pieces (${(ref.sqs ?? []).join(", ")}); give each side its own ref` };
    return { ...(sides[0] && { color: sides[0] }), pieces };
  });
}

/**
 * Everything wrong with a caption's refs, for the director to fix: every word naming a square, a move or a
 * piece is in a ref; refs don't overlap; a ref's own square words are among its squares; each square it
 * points at is among the `drawn` ones (as the caller counts them); a move it points at is on the board by then;
 * and what it names is really there (resolveLineRefs).
 */
export function lineRefProblems(caption: string, refs: LineRef[], fen: string, moves: RulesMove[], k: number, side: Color, drawn: string[]): string[] {
  const ws = quoteWords(caption);
  const out: string[] = [];
  ws.forEach((w, n) => {
    if (pointsAt(w).length && !refs.some((r) => n >= r.words[0] && n <= r.words[1])) out.push(`"${plainWord(w)}" isn't in any ref: add one saying what it points at`);
  });
  refs.forEach((r, j) => {
    const said = ws.slice(r.words[0], r.words[1] + 1).join(" ");
    if (refs.some((o, i) => i < j && o.words[0] <= r.words[1] && r.words[0] <= o.words[1])) out.push(`refs "${said}" and another overlap: give each its own words`);
    if (r.move !== undefined) {
      if (r.move >= k) out.push(`"${said}" points at ${moves[r.move].san}, which isn't played yet when the caption shows`);
      return;
    }
    for (let n = r.words[0]; n <= r.words[1]; n++)
      for (const p of pointsAt(ws[n])) if ("sq" in p && !(r.sqs ?? []).includes(p.sq)) out.push(`"${said}" names ${p.sq} but points at ${(r.sqs ?? []).join(", ")}`);
    for (const sq of r.sqs ?? []) if (!drawn.includes(sq)) out.push(`"${said}" points at ${sq}, but nothing is drawn on ${sq}: circle it in \`squares\`, or draw a reach that starts or ends there`);
  });
  resolveLineRefs(caption, refs, fen, moves, k, side).forEach((c) => "problem" in c && out.push(c.problem));
  return [...new Set(out)];
}
