import type { Color, Game } from "../shared/types";
import { branchOptions, lineVerdicts, type ShownBranch, type ShownLine } from "../shared/engineLine";
import { formatScore } from "../shared/evalmath";
import { sideName } from "../shared/naming";
import { variantOf, type RulesMove } from "../shared/rules";
import { tally, trade, walk } from "../shared/why";
import { passed } from "./lineDepth";

/*
 * The questions an engine line raises, the ones a strong commentator would ask of it, found and answered from
 * the engine's own data (server/lineDepth.ts gathers it): what if the sacrifice is taken? why not the natural
 * move? from where is the piece lost whatever the other side does (every one of its best moves loses it)? what
 * does the quiet move threaten? what did the player's own calculation miss? Each comes with its exact moves and
 * the command to look further, so the director can see why the line is what it is, then tell it.
 */

export type QuestionKind = "sacrifice" | "tempting" | "decided" | "threat" | "idea" | "fails" | "takes back" | "other try";

export interface LineQuestion {
  kind: QuestionKind;
  /** How many of the line's moves are on the board where it's asked. */
  at: number;
  question: string;
  answer: string;
  /** The engine's evidence, a line each. */
  evidence: string[];
  /** The command that looks further from there. */
  explore: string;
  /** For a branch: how to ask for it in the narration. */
  branch?: { at: number; move: string };
  /** Words that show the narration says it (the piece lost, the threat's move), for the readback's nudge. */
  keys?: string[];
  rank: number;
}

const RANK: Record<QuestionKind, number> = { sacrifice: 0, tempting: 1, decided: 2, threat: 3, idea: 4, fails: 5, "takes back": 6, "other try": 7 };
const NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };

/** Moves with their badges, compactly: "hxg5 [good] Qxg5+ Kh8 Qh6+ [great]". */
function badged(g: Game, moves: RulesMove[]): string {
  const vs = lineVerdicts(g, moves);
  return moves.map((mv, k) => (vs[k] && vs[k] !== "best" ? `${mv.san} [${vs[k]}]` : mv.san)).join(" ");
}

/** The position code a probe takes for k moves into this line ("42a3"). */
const whereOf = (g: Game, sl: ShownLine, k: number) => `${g.moves[sl.i].ply}${sl.kind === "after" ? "a" : "i"}${k}`;

/** What a run of moves costs one side: pawns lost (negative: gained), and the pieces, settled. Mate is 100. */
function cost(moves: RulesMove[], side: Color): { loss: number; what: string } {
  const last = moves.at(-1);
  if (last?.san.endsWith("#")) return last.color === side ? { loss: -100, what: "mates" } : { loss: 100, what: "gets mated" };
  const t = tally(moves, side, false);
  const lost = trade(t.lost, t.won);
  const promoted = t.promoted.filter((c) => c !== side).length;
  return { loss: -t.net, what: [lost && `loses ${lost}`, promoted && "lets a pawn queen"].filter(Boolean).join(" and ") || (t.net > 0 ? `wins ${trade(t.won, t.lost) || "material"}` : "keeps the material level") };
}

const kindOf = (b: ShownBranch, g: Game, sl: ShownLine): QuestionKind => {
  if (b.role === "accepts") return b.takesBack ? "takes back" : "sacrifice";
  if (b.role === "tempting") return b.mover === sl.for ? "tempting" : "other try";
  if (b.role === "feared") return "idea";
  if (b.role === "fails") return "fails";
  return "other try";
};

/** The questions a line raises, ranked, each answered from the engine's data (see the top of this file). */
export function lineQuestions(g: Game, sl: ShownLine): LineQuestion[] {
  const variant = variantOf(g);
  const name = (c: Color) => sideName(g, c);
  const out: LineQuestion[] = [];
  const line = (k: number) => (k ? `after ${sl.moves.slice(0, k).map((mv) => mv.san).join(" ")}` : "where the line starts");

  // The branches: the sacrifice taken, the tempting move, a player's own idea, the natural move that fails, the other side's tries.
  for (const b of branchOptions(g, sl)) {
    const kind = kindOf(b, g, sl);
    out.push({
      kind,
      at: b.at,
      question: `${b.question} (${line(b.at)})`,
      answer: b.fact,
      evidence: [badged(g, b.moves)],
      explore: `probe ${whereOf(g, sl, b.at)} ${b.moves[0].san}`,
      branch: { at: b.at, move: b.moves[0].san },
      rank: RANK[kind] * 100 - b.score,
    });
  }

  // Where the losing side's fate is sealed: every one of its best moves loses at least this much.
  let sealed = 0;
  for (let k = 0; k < sl.moves.length; k++) {
    const mv = sl.moves[k];
    const a = g.analysis[mv.before];
    if (mv.color === sl.for || !a?.options || a.options.length < 2) continue;
    const opts = a.options.map((o) => {
      const moves = walk(mv.before, o.pv, variant);
      return { san: moves[0]?.san ?? o.uci, ...cost(moves, mv.color), score: o.score };
    });
    const least = Math.min(...opts.map((o) => o.loss));
    if (least < 2 || least < sealed + 2) continue;
    sealed = least;
    const same = opts.every((o) => o.what === opts[0].what);
    const lost = least >= 100 ? "gets mated" : same ? opts[0].what : `loses at least ${least} pawns' worth`;
    out.push({
      kind: "decided",
      at: k,
      question: `Can ${name(mv.color)} get out of it? (${line(k)}, ${name(mv.color)} to move)`,
      answer: `No: every one of ${name(mv.color)}'s ${opts.length} best moves ${lost}. Whatever it plays, it's lost from here; the line's ${mv.san} is just its best try.`,
      evidence: opts.map((o) => `${o.san}: ${o.what}, eval ${formatScore(o.score)}`),
      explore: `options ${whereOf(g, sl, k)}`,
      // The piece most of its options lose: what the narration should say can't be saved.
      keys: Object.values(NAME).filter((p) => opts.filter((o) => o.what.split(" for ")[0].includes(p)).length * 2 >= opts.length),
      rank: RANK.decided * 100 + k,
    });
  }

  // What the winning side's quiet moves threaten, while the line still has something to win (after it's won it,
  // a threat is mopping up).
  const total = tally(sl.moves, sl.for, true);
  sl.moves.forEach((mv, k) => {
    if (mv.color !== sl.for || mv.captured || /[+#]/.test(mv.san)) return;
    const sofar = tally(sl.moves.slice(0, k + 1), sl.for, true);
    if (k > 0 && (sofar.net >= total.net || sofar.promoted.includes(sl.for))) return;
    const th = g.analysis[mv.after]?.threat;
    const fen = th && passed(mv.after, variant);
    if (!th || !fen) return;
    const moves = walk(fen, th.pv, variant);
    if (!moves.length) return;
    const gain = cost(moves, mv.color === "w" ? "b" : "w");
    if (gain.loss < 2) return;
    const first = moves[0];
    out.push({
      kind: "threat",
      at: k + 1,
      question: `What does ${mv.san} threaten? (${line(k + 1)})`,
      answer: `${first.san}${first.captured ? `, taking the ${NAME[first.captured]} on ${first.to}` : ""}: if ${name(mv.color === "w" ? "b" : "w")} did nothing, it ${gain.what} (eval ${formatScore(th.score)}).`,
      evidence: [`the threat played out: ${moves.map((m) => m.san).join(" ")}`],
      explore: `threat ${whereOf(g, sl, k + 1)}`,
      keys: [first.san.replace(/[+#]/g, ""), first.to, ...(first.captured ? [NAME[first.captured]] : []), ...(moves.some((m) => m.promotion) ? ["queen"] : [])],
      // Within its kind, the bigger threat first; never ahead of a "can't get out".
      rank: RANK.threat * 100 + 99 - Math.min(gain.loss, 99),
    });
  });

  return out.sort((x, y) => x.rank - y.rank);
}

/** What the viewer must understand to follow a line: where the losing side can't get out, and what the winning side threatens. */
export function mustUnderstand(g: Game, sl: ShownLine): LineQuestion[] {
  return lineQuestions(g, sl).filter((q) => q.kind === "decided" || q.kind === "threat").slice(0, 4).sort((a, b) => a.at - b.at);
}

/** The must-understand findings for the narration brief. */
export function understandLines(g: Game, sl: ShownLine): string[] {
  const qs = mustUnderstand(g, sl);
  if (!qs.length) return [];
  return [
    "What the viewer must understand (the engine's findings; say each in your beats, in plain words, before or as the moves that carry it out land: a forced win is explained by what can't be saved or stopped, not by its moves):",
    ...qs.flatMap((q) => [`  - [${q.kind === "decided" ? "can't get out" : "threat"}] ${q.question} → ${q.answer}`, ...q.evidence.map((e) => `      ${e}`), `      look further: ${q.explore}`]),
  ];
}

/** The questions for a brief: each with its answer, evidence and where to look further (`branchesOnly`: just the ones a branch can answer). */
export function questionLines(g: Game, sl: ShownLine, max = 8, star?: { at: number; uci: string }, branchesOnly = false): string[] {
  const qs = lineQuestions(g, sl)
    .filter((q) => !branchesOnly || q.branch)
    .slice(0, max);
  if (!qs.length) return ["Questions this line raises: none worked out by the engine (probe it yourself)."];
  return [
    `${branchesOnly ? "Branches this line raises" : "Questions this line raises"}, worked out by the engine (the strongest first; tell the ones that make the story, and probe further as you like):`,
    ...qs.flatMap((q) => {
      const starred = star && q.branch && q.at === star.at && sl.moves[q.at] && q.branch.move === walk(q.at ? sl.moves[q.at - 1].after : sl.fen, [star.uci], variantOf(g))[0]?.san;
      return [
        `  ${starred ? "★ " : ""}[${q.kind}] ${q.question} → ${q.answer}`,
        ...q.evidence.map((e) => `      ${e}`),
        `      ${q.branch ? `as a branch: { "at": ${q.branch.at}, "move": "${q.branch.move}" } · ` : ""}look further: ${q.explore}`,
      ];
    }),
  ];
}

/** How much a line's best question is worth, for ranking lines (0 when it raises none). */
export function questionWeight(g: Game, sl: ShownLine): { weight: number; top?: LineQuestion } {
  const top = lineQuestions(g, sl)[0];
  if (!top) return { weight: 0 };
  return { weight: top.kind === "sacrifice" ? 25 : top.kind === "tempting" || top.kind === "decided" ? 15 : 8, top };
}

