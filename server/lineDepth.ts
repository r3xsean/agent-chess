import type { Classification, Game, MoveRecord, PositionAnalysis } from "../shared/types";
import { LINE_KINDS, LINE_WALK, shownLine } from "../shared/engineLine";
import { newRules, variantOf } from "../shared/rules";
import { walk } from "../shared/why";
import { Engine } from "./engine";
import { classifyMove, terminalScore } from "./classify";
import { saveGameNow } from "./store";
import { touch } from "./game";

/*
 * The engine lines the replay plays out ("what if…", "what this allowed") are followed position by
 * position rather than read off one search's PV: each position along the line gets its own analysis, so
 * a long line stays the engine's real best play to the end, and each of its moves gets a verdict like a
 * game move (best; great, the only move; brilliant, a sound sacrifice; forced). Done once per game, before
 * its video is directed, on an engine of its own so live games' analysis never waits behind it.
 */

/** Bump when what's analysed changes: games deepened by an older version are done again. */
export const LINE_DEPTH_VERSION = 1;

/** The verdicts that make a line worth showing (see shared/engineLine.ts). */
const WRONG: Classification[] = ["inaccuracy", "mistake", "miss", "blunder"];
const STRONG: Classification[] = ["brilliant", "great"];
/** Past this many plies, a line that's gone quiet (no capture, check or promotion for QUIET plies) has said what it has to say. */
const MIN_WALK = 8;
const QUIET = 6;

let lineEngine: Engine | null = null;
const engineFor = () => {
  if (!lineEngine) {
    lineEngine = new Engine({ label: "lines", depth: 20, maxMs: 4000, threads: 4, hashMb: 256 });
    lineEngine.start();
  }
  return lineEngine;
};

/** Where a game's deepening stands, for the director's brief while it runs. */
const running = new Map<string, { promise: Promise<boolean>; done: number; total: number; failed: number }>();

export const linesReady = (g: Game) => (g.linesDepth ?? 0) >= LINE_DEPTH_VERSION;

export function linesProgress(g: Game): { done: number; total: number } | null {
  const r = running.get(g.id);
  return r ? { done: r.done, total: r.total } : null;
}

/**
 * Analyse every line a finished game's video could show, move by move. Resolves true once all of it is done
 * (at once if it already was), false when the engine failed somewhere: what was analysed is kept, and the
 * next call picks up the rest.
 */
export function deepenLines(g: Game): Promise<boolean> {
  if (linesReady(g)) return Promise.resolve(true);
  const have = running.get(g.id);
  if (have) return have.promise;
  const state = { promise: Promise.resolve(false), done: 0, total: 0, failed: 0 };
  state.promise = run(g, state)
    .then(() => {
      if (!state.failed) g.linesDepth = LINE_DEPTH_VERSION;
      else console.error(`[lines] ${g.id}: ${state.failed} engine search${state.failed === 1 ? "" : "es"} failed; the next brief retries them`);
      return !state.failed;
    })
    .catch((e) => {
      console.error(`[lines] ${g.id}: ${(e as Error).message}`);
      return false;
    })
    .finally(() => {
      saveGameNow(g);
      touch(g);
      running.delete(g.id);
    });
  running.set(g.id, state);
  return state.promise;
}

async function run(g: Game, state: { done: number; total: number; failed: number }) {
  // Where lines start: before a move that went wrong (what was better) and after it (its punishment),
  // and after a strong move (its point).
  const starts = new Set<string>();
  for (const m of g.moves) {
    const cls = m.analysis?.classification;
    if (!cls || m.analysis!.unavailable) continue;
    // An inaccuracy rarely has a line worth showing (a sacrifice the engine doesn't trust, mostly): only the
    // ones that already show one from their stored PV are followed.
    if (cls === "inaccuracy" && !LINE_KINDS.some((k) => shownLine(g, g.moves.indexOf(m), k, true))) continue;
    if (WRONG.includes(cls)) starts.add(m.fenBefore).add(m.fenAfter);
    if (STRONG.includes(cls)) starts.add(m.fenAfter);
  }
  state.total = starts.size;
  for (const fen of starts) {
    state.failed += await follow(g, fen);
    state.done++;
    // Kept as it goes, so a restart halfway loses little.
    if (state.done % 5 === 0) saveGameNow(g);
  }
}

/** A position's analysis, from the game when it has one, else from the line engine (kept in the game unless it failed). */
async function analysed(g: Game, fen: string): Promise<PositionAnalysis> {
  const have = g.analysis[fen];
  if (have && !have.failed) return have;
  const term = terminalScore(fen);
  const a = term ? { depth: 0, score: term, pv: [] } : await engineFor().analyze(fen, variantOf(g));
  if (!a.failed) g.analysis[fen] = a;
  return a;
}

/** Follow the engine's best play from a position, analysing each position it reaches, and badge each move. How many searches failed (0: all done). */
async function follow(g: Game, start: string): Promise<number> {
  const variant = variantOf(g);
  let pos = start;
  let quiet = 0;
  for (let ply = 0; ply < LINE_WALK; ply++) {
    const a = await analysed(g, pos);
    if (a.failed) return 1;
    const uci = a.bestUci ?? a.pv[0];
    if (!uci) return 0;
    const [mv] = walk(pos, [uci], variant);
    if (!mv) return 0;
    const next = await analysed(g, mv.after);
    if (next.failed) return 1;
    if (!a.bestVerdict) a.bestVerdict = verdictOf(g, a, mv.before, mv.after, mv.uci, mv.color, next);
    if (mv.san.endsWith("#") || !next.pv.length) return 0;
    quiet = mv.captured || mv.promotion || /[+#]/.test(mv.san) ? 0 : quiet + 1;
    if (ply + 1 >= MIN_WALK && quiet >= QUIET) return 0;
    pos = mv.after;
  }
  return 0;
}

/** The verdict on the engine's own best move, as the game's moves are judged (server/classify.ts). */
function verdictOf(g: Game, before: PositionAnalysis, fenBefore: string, fenAfter: string, uci: string, color: "w" | "b", after: PositionAnalysis): Classification {
  if (newRules(fenBefore, variantOf(g)).moves().length === 1) return "forced";
  const m = { color, uci, fenBefore, fenAfter } as MoveRecord;
  return classifyMove(m, before, after.score, undefined, false, variantOf(g)).classification;
}
