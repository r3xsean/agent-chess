import type { Classification, Color, Game } from "./types";
import { variantOf, type RulesMove } from "./rules";
import { sideName } from "./naming";
import { tally, trade, walk, type Tally } from "./why";

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
}

/** A quiet line is cut after this many plies (an exchange in progress may run a few more). */
const MAX_PLIES = 8;
/** A mate is shown whole when it comes within this many plies (mate in 6). */
const MAX_MATE_PLIES = 11;
/** How much of a line without captures is shown. */
const QUIET_PLIES = 4;

/** The part of an engine line worth playing: up to the mate, or to where its captures have settled, ending on the payoff. */
function settle(all: RulesMove[]): RulesMove[] {
  const mateAt = all.findIndex((mv) => mv.san.endsWith("#"));
  if (mateAt >= 0 && mateAt < MAX_MATE_PLIES) return all.slice(0, mateAt + 1);
  let k = Math.min(all.length, MAX_PLIES);
  // An exchange still going at the cut is played to its end (a few plies more at most), or left out.
  while (k < all.length && k < MAX_PLIES + 4 && all[k].captured) k++;
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

/** The line of a kind for move i, or null when there's none worth showing. */
export function shownLine(g: Game, i: number, kind: LineKind): ShownLine | null {
  const m = g.moves[i];
  const cls = m?.analysis?.classification;
  if (!m || !cls || m.analysis!.unavailable) return null;
  const variant = variantOf(g);
  const mover = m.color;
  const opp: Color = mover === "w" ? "b" : "w";
  const fen = kind === "instead" ? m.fenBefore : m.fenAfter;
  const a = g.analysis[fen];
  if (!a || a.failed || a.depth <= 0 || !a.pv?.length) return null;
  const moves = settle(walk(fen, a.pv, variant));
  if (!moves.length) return null;
  const name = (c: Color) => sideName(g, c);
  const mated = mates(moves);
  const winner = mated ? moves.at(-1)!.color : null;
  const played = walk(m.fenBefore, [m.uci], variant);

  const mateIn = (c: Color) => moves.filter((mv) => mv.color === c).length;

  if (kind === "instead") {
    // The mover's better way. What makes it better is measured against what the move played led to: a
    // mate, material it wins, or just not losing what the move played lost (or not getting mated).
    if (!WRONG.includes(cls) || a.pv[0] === m.uci || (mated && winner !== mover)) return null;
    const after = g.analysis[m.fenAfter];
    const actual = settle([...played, ...walk(m.fenAfter, after && !after.failed ? after.pv : [], variant)]);
    const actualMates = mates(actual) && actual.at(-1)!.color === mover;
    const actualMated = mates(actual) && !actualMates;
    const t = tally(moves, mover, true);
    const tA = tally(actual, mover, true);
    const who = name(mover);
    const first = moves[0].san;
    const line = (fact: string, caption: string, net: number, mate?: number): ShownLine => ({ kind, i, fen, moves, for: mover, mate, net, fact, caption });
    if (mated) {
      if (actualMates && actual.length <= moves.length) return null;
      const mate = mateIn(mover);
      return line(`${who} forces mate in ${mate}`, `${first} would have forced mate in ${mate}.`, 0, mate);
    }
    if (actualMates) return null;
    if (actualMated) return line(`${who} avoids the mate ${m.san} allows`, `${first} would have avoided mate.`, 0);
    const swing = t.net - tA.net;
    if (swing < MIN_GAIN) {
      // No material in it: worth showing only when the move threw away a big share of the winning chances.
      const kept = m.analysis!.winBefore;
      const got = m.analysis!.winAfter;
      if (kept - got < BIG_SWING) return null;
      return line(`${who} keeps ${standing(kept)} (${Math.round(kept)}% instead of ${Math.round(got)}%)`, `${first} would have kept ${standing(kept)}.`, 0);
    }
    if (t.net >= MIN_GAIN || t.promoted.includes(mover)) return line(`${who} ${prize(t, mover, "present")} (+${t.net})`, `${first} would have ${prize(t, mover, "past")}.`, swing);
    const lost = trade(tA.lost, tA.won) || "material";
    return line(`${who} doesn't lose ${lost}, as ${m.san} does (${swing} pawns better)`, `${first} would have avoided losing ${lost}.`, swing);
  }

  // "after": the opponent's punishment of a move that went wrong, when their reply went elsewhere; or the
  // point of a strong move, when the game went another way within the line.
  let side: Color;
  if (WRONG.includes(cls)) {
    side = opp;
    if (g.moves[i + 1]?.uci === moves[0].uci) return null;
  } else if (STRONG.includes(cls)) {
    side = mover;
    if (moves.every((mv, k) => g.moves[i + 1 + k]?.uci === mv.uci)) return null;
  } else return null;
  if (mated && winner !== side) return null;
  // Counted from before the move, so taking back what the move just took isn't a gain.
  const t = tally([...played, ...moves], side, true);
  if (!mated && t.net < MIN_GAIN && !t.promoted.includes(side)) {
    // No material in it: a punishment is still worth showing when the reply let a big winning chance go.
    const reply = g.moves[i + 1]?.analysis;
    if (side !== opp || !reply) return null;
    const could = 100 - m.analysis!.winAfter;
    if (could - reply.winAfter < BIG_SWING) return null;
    const fact = `${name(opp)} reaches ${standing(could)} (${Math.round(could)}% instead of ${Math.round(reply.winAfter)}%)`;
    return { kind, i, fen, moves, for: side, net: 0, fact, caption: `${name(opp)} could have reached ${standing(could)}.` };
  }
  const mate = mated ? mateIn(side) : undefined;

  const fact = `${name(side)} ${prize(t, side, "present", mate)}${mate ? "" : ` (+${t.net})`}`;
  const caption = side === opp ? `${name(opp)} could have ${prize(t, side, "past", mate)}.` : `${m.san} was set to ${prize(t, side, "bare", mate)}.`;
  return { kind, i, fen, moves, for: side, mate, net: mate ? 0 : t.net, fact, caption };
}

/** The lines on offer for move i. */
export function lineOptions(g: Game, i: number): ShownLine[] {
  return LINE_KINDS.map((k) => shownLine(g, i, k)).filter((l): l is ShownLine => !!l);
}
