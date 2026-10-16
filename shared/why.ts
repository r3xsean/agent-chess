import type { Classification, Color, Game, PositionAnalysis, Score } from "./types";
import { newRules, variantOf, type RulesMove, type Variant } from "./rules";
import { formatScore, winPercentFor } from "./evalmath";
import { standing } from "./belief";
import { sideName } from "./naming";

/*
 * Why a move got its verdict, from the engine data the game already holds: the line the engine wanted
 * before the move, the line that follows the move played, and a one-line reason found by playing both
 * through (mates, and material that changes hands once the captures have settled). Nothing is guessed:
 * when neither shows anything concrete, the reason is just how the position changed.
 */

export interface EngineLine {
  /** The position the line starts from. */
  fen: string;
  san: string[];
  /** The engine's score of the starting position (White's view). */
  score: Score;
  depth: number;
  /** The line's first move, for a board arrow. */
  from?: string;
  to?: string;
}

export type WhyKind = "bad" | "miss" | "great" | "brilliant" | "fine" | "book" | "forced";

export interface Why {
  kind: WhyKind;
  cls: Classification;
  /** The mover's winning chances (0–100) before and after the move. */
  winBefore: number;
  winAfter: number;
  /** The engine's choice, when the move played wasn't it. */
  bestSan?: string;
  /** The engine's line from the position before the move (for a move that went wrong). */
  best?: EngineLine;
  /** The engine's line from the position the move left. */
  after?: EngineLine;
  reason?: string;
}

const KIND: Record<Classification, WhyKind> = {
  inaccuracy: "bad",
  mistake: "bad",
  blunder: "bad",
  miss: "miss",
  great: "great",
  brilliant: "brilliant",
  best: "fine",
  excellent: "fine",
  good: "fine",
  book: "book",
  forced: "forced",
};

const usable = (a: PositionAnalysis | undefined): a is PositionAnalysis => !!a && !a.failed && a.depth > 0;

export function walk(fen: string, uci: string[], variant: Variant): RulesMove[] {
  const c = newRules(fen, variant);
  const out: RulesMove[] = [];
  for (const u of uci) {
    try {
      out.push(c.move(u));
    } catch {
      break;
    }
  }
  return out;
}

function engineLine(fen: string, a: PositionAnalysis, variant: Variant): EngineLine {
  const moves = walk(fen, a.pv, variant);
  return { fen, san: moves.map((m) => m.san), score: a.score, depth: a.depth, from: moves[0]?.from, to: moves[0]?.to };
}

/** Moves to mate from a side's view: positive when it mates, negative when it gets mated, null for none. */
export function mateFor(s: Score | undefined, c: Color): number | null {
  if (!s || s.mate === undefined || s.mate === 0) return null;
  return c === "w" ? s.mate : -s.mate;
}

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export interface Tally {
  /** Material won minus material lost, in pawns, from the mover's side (promotions included). */
  net: number;
  lost: string[];
  won: string[];
  /** Sides that promoted a pawn. */
  promoted: Color[];
}

/**
 * The material that changes hands along a line, from the mover's side, counted up to where the captures
 * have settled (the next move isn't a capture), so a line cut off mid-exchange doesn't count half of it.
 */
export function tally(moves: RulesMove[], mover: Color, endsInMate: boolean): Tally {
  let k = moves.length;
  if (!endsInMate && k && moves[k - 1].captured) {
    k--;
    while (k > 0 && moves[k].captured) k--;
  }
  const t: Tally = { net: 0, lost: [], won: [], promoted: [] };
  for (const m of moves.slice(0, k)) {
    const sign = m.color === mover ? 1 : -1;
    if (m.captured) {
      (sign > 0 ? t.won : t.lost).push(m.captured);
      t.net += sign * VALUE[m.captured];
    }
    if (m.promotion) {
      t.promoted.push(m.color);
      t.net += sign * (VALUE[m.promotion] - 1);
    }
  }
  return t;
}

const NAME: Record<string, [string, string]> = {
  q: ["the queen", "queens"],
  r: ["a rook", "rooks"],
  b: ["a bishop", "bishops"],
  n: ["a knight", "knights"],
  p: ["a pawn", "pawns"],
};
const NUMBER = ["", "", "two", "three", "four", "five", "six", "seven", "eight"];

function pieces(list: string[]): string {
  const parts = Object.keys(NAME)
    .filter((t) => list.includes(t))
    .map((t) => {
      const n = list.filter((x) => x === t).length;
      return n === 1 ? NAME[t][0] : `${NUMBER[n] ?? n} ${NAME[t][1]}`;
    });
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * What one side gives for what it gets ("a knight for a pawn", "the exchange"), with even trades left
 * out (a knight for a bishop counts as even). Empty when it comes out even or ahead.
 */
export function trade(give: string[], get: string[]): string {
  const a = [...give];
  const b = [...get];
  for (let i = a.length - 1; i >= 0; i--) {
    const j = b.findIndex((x) => VALUE[x] === VALUE[a[i]]);
    if (j >= 0) (a.splice(i, 1), b.splice(j, 1));
  }
  const sum = (l: string[]) => l.reduce((s, x) => s + VALUE[x], 0);
  if (!a.length || sum(a) <= sum(b)) return "";
  if (a.length === 1 && a[0] === "r" && b.length === 1 && VALUE[b[0]] === 3) return "the exchange";
  return b.length ? `${pieces(a)} for ${pieces(b)}` : pieces(a);
}

/** "Loses a knight", with a promotion the line allows added on. */
function losing(t: Tally, them: string, opp: Color): string {
  const lost = trade(t.lost, t.won);
  const promotes = t.promoted.includes(opp);
  if (lost && promotes) return `Loses ${lost} and lets ${them} promote a pawn`;
  if (promotes) return `Lets ${them} promote a pawn`;
  return lost ? `Loses ${lost}` : "Loses material";
}

/** What a line gains: "wins a knight", "promotes a pawn and wins a rook" (present or past tense). */
function gaining(t: Tally, mover: Color, past: boolean): string {
  const won = trade(t.won, t.lost);
  const promo = t.promoted.includes(mover);
  const [w, p] = past ? ["won", "promoted"] : ["wins", "promotes"];
  if (promo) return `${p} a pawn${won ? ` and ${w} ${won}` : ""}`;
  return `${w} ${won || "material"}`;
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The engine's case for a move's verdict, or null while the move has none. */
export function explainMove(g: Game, i: number): Why | null {
  const m = g.moves[i];
  const a = m?.analysis;
  if (!m || !a || a.unavailable) return null;
  const variant = variantOf(g);
  const mover = m.color;
  const opp: Color = mover === "w" ? "b" : "w";
  const who = sideName(g, mover);
  const them = sideName(g, opp);
  const kind = KIND[a.classification];
  const before = g.analysis[m.fenBefore];
  const afterA = g.analysis[m.fenAfter];
  const playedBest = !!a.bestUci && a.bestUci === m.uci;

  const best = usable(before) && !playedBest && (kind === "bad" || kind === "miss") ? engineLine(m.fenBefore, before, variant) : undefined;
  const after = usable(afterA) ? engineLine(m.fenAfter, afterA, variant) : undefined;
  const why: Why = { kind, cls: a.classification, winBefore: a.winBefore, winAfter: a.winAfter, bestSan: playedBest ? undefined : a.bestSan, best, after };

  const scoreBefore = usable(before) ? before.score : undefined;
  const scoreAfter = after?.score ?? a.evalAfter;
  const mateBefore = mateFor(scoreBefore, mover);
  const mateAfter = mateFor(scoreAfter, mover);
  const played = walk(m.fenBefore, [m.uci], variant);
  const endsInMate = (fen: string, uci: string[]) => {
    const c = newRules(fen, variant);
    for (const u of uci) {
      try {
        c.move(u);
      } catch {
        break;
      }
    }
    return c.isCheckmate();
  };
  // The material either way, from the position before the move: the move played and what follows it,
  // against the engine's own line.
  const tA = tally([...played, ...walk(m.fenAfter, afterA?.pv ?? [], variant)], mover, endsInMate(m.fenAfter, afterA?.pv ?? []));
  const tB = best && usable(before) ? tally(walk(m.fenBefore, before.pv, variant), mover, endsInMate(m.fenBefore, before.pv)) : null;
  const bestSan = a.bestSan ?? best?.san[0];
  const from = standing(a.winBefore);
  const to = standing(a.winAfter);
  const shift = from !== to ? `${who} goes from ${from} to ${to}` : "";

  if (kind === "bad") {
    const swing = tB ? tB.net - tA.net : -tA.net;
    let material = "";
    let compared = false;
    if (tB && swing >= 1) {
      if (tA.net <= -1) {
        const lessLost = trade(tB.lost, tB.won);
        compared = tB.net <= -1 && !!lessLost;
        material = losing(tA, them, opp) + (compared ? `, where ${bestSan} gave up only ${lessLost}` : "");
      } else material = `${bestSan} would have ${gaining(tB, mover, true)}`;
    } else if (!tB && tA.net <= -1) material = losing(tA, them, opp);
    if (mateAfter !== null && mateAfter < 0 && !(mateBefore !== null && mateBefore < 0)) why.reason = `Allows mate in ${-mateAfter}`;
    else if (mateBefore !== null && mateBefore > 0 && !(mateAfter !== null && mateAfter > 0)) why.reason = `Lets mate in ${mateBefore} slip`;
    // A pawn or two doesn't explain a big drop on its own: say what it does to the game as well.
    else if (material) why.reason = swing <= 2 && shift && !compared ? `${material}, and ${shift}` : material;
    else why.reason = shift || `No material changes hands, but ${bestSan ?? "the engine's move"} kept a better game`;
  } else if (kind === "miss") {
    const prev = g.moves[i - 1];
    const when = prev ? ` after ${prev.san}` : "";
    if (mateBefore !== null && mateBefore > 0) why.reason = `Misses mate in ${mateBefore}${when}`;
    else if (tB && tB.net >= 1 && tB.net - tA.net >= 1) why.reason = `Misses ${bestSan}, which ${gaining(tB, mover, false)}${when}`;
    else if (prev) why.reason = `${them}'s ${prev.san} was an error, and ${bestSan ?? "the engine's move"} would have punished it`;
    else why.reason = shift;
  } else if (kind === "great") {
    const holds = standing(a.winAfter);
    const second = usable(before) ? before.second : undefined;
    const winSecond = second && winPercentFor(second, mover);
    // When the next best still leaves the same standing, it isn't "the only move", just the clearly best one.
    if (second && winSecond !== undefined && standing(winSecond) === holds)
      why.reason = `The best move by a distance: the next best drops ${who}'s chances from ${Math.round(a.winAfter)}% to ${Math.round(winSecond)}%`;
    else
      why.reason =
        (holds === "about equal" ? "The only move that holds the balance" : `The only move that keeps ${who} ${holds}`) +
        (second && winSecond !== undefined ? `: anything else leaves ${who} ${standing(winSecond)} (${formatScore(second)})` : "");
  } else if (kind === "brilliant") {
    const given = trade(tA.lost, tA.won);
    why.reason = given ? `Sacrifices ${given}, and ${who} is still ${standing(a.winAfter)}` : `Leaves material hanging that ${them} can't afford to take`;
  } else if (kind === "book") why.reason = "Opening theory";
  else if (kind === "forced") why.reason = "The only legal move";
  else if (newRules(m.fenAfter, variant).isCheckmate()) why.reason = "Checkmate";
  else if (mateAfter !== null && mateAfter > 0) why.reason = `Forces mate in ${mateAfter}`;

  if (why.reason) why.reason = sentence(why.reason);
  return why;
}
