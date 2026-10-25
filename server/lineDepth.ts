import type { Classification, Game, MoveRecord, PositionAnalysis } from "../shared/types";
import { BRANCH_REACH, BRANCH_WALK, LINE_KINDS, LINE_WALK, branchCandidates, lineOptions, lineVerdicts, shownLine, type ShownLine } from "../shared/engineLine";
import { winPercentFor } from "../shared/evalmath";
import { newRules, variantOf } from "../shared/rules";
import { walk } from "../shared/why";
import os from "node:os";
import { Engine, EnginePool } from "./engine";
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
export const LINE_DEPTH_VERSION = 5;

/** The verdicts that make a line worth showing (see shared/engineLine.ts). */
const WRONG: Classification[] = ["inaccuracy", "mistake", "miss", "blunder"];
const STRONG: Classification[] = ["brilliant", "great"];
/** Past this many plies, a line that's gone quiet (no capture, check or promotion for QUIET plies) has said what it has to say. */
const MIN_WALK = 8;
const QUIET = 6;

/*
 * A video has no clock, so its lines (and the director's probes, options and threats, which use the same
 * engines) are searched to the review's depth on engines of their own: every position to depth 20, however
 * long it takes (24 took three times as long, and no eval moved by more than a few points of winning chances). While a
 * game runs on this PC, only searches an agent is waiting on go ahead (slowed, same depth); the rest wait.
 * An agent's command that outlasts its window answers WAITING and picks up where it was (see probe.ts).
 */
let lineEngine: EnginePool | null = null;
export const engineFor = () => {
  if (!lineEngine) {
    const threads = Math.max(1, Math.floor(os.availableParallelism() / 2));
    const depth = Number(process.env.LINES_DEPTH ?? 20);
    const maxMs = process.env.ENGINE_MAX_MS ? Number(process.env.ENGINE_MAX_MS) : undefined; // test servers cap every engine
    lineEngine = new EnginePool(2, { label: "lines", depth, ...(maxMs !== undefined && { maxMs }), threads, hashMb: 1024, pauseWhileGaming: true });
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
  // Then the branches of the lines most worth a video's time (see branchCandidates), once the lines themselves
  // are followed: their branch points get the engine's second choice, and each candidate its own walk.
  state.total = starts.size + BRANCH_LINES;
  for (const fen of starts) {
    state.failed += await follow(g, fen);
    state.done++;
    // Kept as it goes, so a restart halfway loses little.
    if (state.done % 5 === 0) saveGameNow(g);
  }
  const lines = g.moves
    .flatMap((m, i) => (m.analysis && !m.analysis.unavailable ? lineOptions(g, i).map((sl) => ({ sl, swing: lineSwing(g, sl) })) : []))
    .sort((a, b) => b.swing - a.swing)
    .slice(0, BRANCH_LINES);
  state.total = starts.size + lines.length;
  for (const { sl } of lines) {
    state.failed += await evidence(g, sl);
    state.failed += await branches(g, sl);
    state.done++;
    saveGameNow(g);
  }
}

let shallowEngine: Engine | null = null;
/** A quick, shallow search: the move a human reaches for first (the engine's deeper search may refute it). */
const shallowFor = () => {
  if (!shallowEngine) {
    shallowEngine = new Engine({ label: "shallow", depth: 6, maxMs: 1000, threads: 1, hashMb: 16 });
    shallowEngine.start();
  }
  return shallowEngine;
};

/** How many of the side to move's best moves an `options` search keeps, and how far each one's line. */
const OPTIONS = 5;
const OPTION_PLIES = 12;

/** The position with the side to move passing: null when that isn't a position (in check). */
export function passed(fen: string, variant: ReturnType<typeof variantOf>): string | null {
  if (newRules(fen, variant).inCheck()) return null;
  const p = fen.split(" ");
  return [p[0], p[1] === "w" ? "b" : "w", p[2], "-", p[4], p[5]].join(" ");
}

/**
 * What a line's questions are answered from (server/lineQuestions.ts), once per position: at each point the
 * losing side moves, its best few moves with their lines; after each quiet move of the winning side, what it
 * threatens (the other side passing); and everywhere, the move a shallow search picks, followed when it isn't
 * the engine's (the tempting move, a branch). How many searches failed. Safe to run again: done positions are skipped.
 */
export async function evidence(g: Game, sl: ShownLine): Promise<number> {
  const variant = variantOf(g);
  let failed = 0;
  for (let k = 0; k < Math.min(sl.moves.length, BRANCH_REACH); k++) {
    const mv = sl.moves[k];
    const a = await analysed(g, mv.before);
    if (a.failed) {
      failed++;
      continue;
    }
    const legal = newRules(mv.before, variant).moves().length;
    if (mv.color !== sl.for && !a.options && legal > 1) {
      const r = await engineFor().analyze(mv.before, variant, Math.min(OPTIONS, legal));
      if (r.failed || !r.multi) failed++;
      else a.options = r.multi.filter((l) => l.pv.length).map((l) => ({ uci: l.pv[0], score: l.score, pv: l.pv.slice(0, OPTION_PLIES) }));
    }
    if (mv.color === sl.for && !mv.captured && !/[+#]/.test(mv.san)) {
      const after = await analysed(g, mv.after);
      if (!after.failed && after.threat === undefined) {
        const fen = passed(mv.after, variant);
        if (!fen) after.threat = null;
        else {
          const r = await engineFor().analyze(fen, variant);
          if (r.failed) failed++;
          else after.threat = { score: r.score, pv: r.pv.slice(0, OPTION_PLIES) };
        }
      }
    }
    if (a.shallowUci === undefined && legal > 1) {
      const r = await shallowFor().analyze(mv.before, variant);
      if (!r.failed && r.bestUci) a.shallowUci = r.bestUci;
    }
  }
  return failed;
}

/** How many of a game's lines get their branches followed. */
const BRANCH_LINES = 16;

/** How much of the game a line swung, to pick the lines whose branches are followed (the director's ranking, roughly). */
function lineSwing(g: Game, sl: ShownLine): number {
  const a = g.moves[sl.i].analysis!;
  const hard = lineVerdicts(g, sl.moves).some((v) => v === "great" || v === "brilliant") ? 25 : 0;
  if (sl.kind === "instead") return a.winBefore - a.winAfter + hard;
  const reply = g.moves[sl.i + 1]?.analysis;
  return (sl.for !== g.moves[sl.i].color && reply ? 100 - a.winAfter - reply.winAfter : 15) + hard;
}

/**
 * A line's branches: each branch point it may split from gets the engine's second choice (searched again when
 * the stored analysis predates it, kept only while the best move agrees), then each candidate's first position
 * is searched, and the ones that could show something are followed. How many searches failed.
 */
export async function branches(g: Game, sl: ShownLine): Promise<number> {
  const variant = variantOf(g);
  let failed = 0;
  const verdicts = lineVerdicts(g, sl.moves);
  for (let k = 0; k < Math.min(sl.moves.length, BRANCH_REACH); k++) {
    const mv = sl.moves[k];
    if (mv.color === sl.for && verdicts[k] !== "great" && verdicts[k] !== "brilliant") continue;
    const a = g.analysis[mv.before];
    if (!a || a.failed || a.secondUci || a.second === undefined || newRules(mv.before, variant).moves().length < 2) continue;
    const fresh = await engineFor().analyze(mv.before, variant);
    if (fresh.failed) failed++;
    else if (fresh.secondUci && (fresh.bestUci ?? fresh.pv[0]) === (a.bestUci ?? a.pv[0])) a.secondUci = fresh.secondUci;
  }
  for (const c of branchCandidates(g, sl)) {
    const [alt] = walk(c.fen, [c.uci], variant);
    if (!alt) continue;
    const after = await analysed(g, alt.after);
    if (after.failed) {
      failed++;
      continue;
    }
    judge(g, alt);
    // Worth following only when it could come to something: the line's side throwing the win away, or still
    // winning against the other side's try (or a player's own idea, either way).
    const line = g.analysis[sl.moves[c.at].after];
    if (!line || line.failed) continue;
    const winLine = winPercentFor(line.score, sl.for);
    const winAlt = winPercentFor(after.score, sl.for);
    const promising = c.role === "feared" || (alt.color === sl.for ? winLine - winAlt >= 20 : winAlt >= 65);
    if (promising) failed += await follow(g, alt.after, BRANCH_WALK);
  }
  return failed;
}

const inGame = (g: Game, fen: string) => g.moves.some((m) => m.fenBefore === fen || m.fenAfter === fen);
const searching = new Map<string, Promise<PositionAnalysis>>();

/**
 * A position's analysis: from the game when it has one done under the current LINE_DEPTH_VERSION, else from the
 * line engine (kept in the game unless it failed). The game's own positions keep their review's search; only
 * what the lines added to them (options, threat, badges) is redone. Callers asking for a position already being
 * searched share that search. `urgent`: an agent is waiting on it.
 */
export async function analysed(g: Game, fen: string, urgent = false): Promise<PositionAnalysis> {
  const have = g.analysis[fen];
  if (have && !have.failed) {
    if (have.depth === 0 || (have.lineVersion ?? 0) >= LINE_DEPTH_VERSION) return have;
    if (inGame(g, fen)) {
      delete have.options;
      delete have.threat;
      delete have.verdicts;
      delete have.bestVerdict;
      have.lineVersion = LINE_DEPTH_VERSION;
      return have;
    }
  }
  const term = terminalScore(fen);
  if (term) return (g.analysis[fen] = { depth: 0, score: term, pv: [] });
  const key = `${g.id}|${fen}`;
  let search = searching.get(key);
  if (!search) {
    search = engineFor()
      .analyze(fen, variantOf(g), undefined, urgent)
      .then((a) => {
        if (!a.failed) g.analysis[fen] = { ...a, lineVersion: LINE_DEPTH_VERSION };
        return g.analysis[fen] ?? a;
      })
      .finally(() => searching.delete(key));
    searching.set(key, search);
  }
  return search;
}

/**
 * Follow the engine's best play from a position, analysing each position it reaches, and badge each move. How many
 * searches failed (0: all done). `urgent`: an agent is waiting on it; `onStep`: called as each position is done.
 */
export async function follow(g: Game, start: string, max = LINE_WALK, urgent = false, onStep?: () => void): Promise<number> {
  const variant = variantOf(g);
  let pos = start;
  let quiet = 0;
  for (let ply = 0; ply < max; ply++) {
    const a = await analysed(g, pos, urgent);
    if (ply === 0) onStep?.(); // later starting positions are the previous step's `next`
    if (a.failed) return 1;
    const uci = a.bestUci ?? a.pv[0];
    if (!uci) return 0;
    const [mv] = walk(pos, [uci], variant);
    if (!mv) return 0;
    const next = await analysed(g, mv.after, urgent);
    onStep?.();
    if (next.failed) return 1;
    if (!a.bestVerdict) a.bestVerdict = verdictOf(g, a, mv.before, mv.after, mv.uci, mv.color, next);
    if (mv.san.endsWith("#") || !next.pv.length) return 0;
    quiet = mv.captured || mv.promotion || /[+#]/.test(mv.san) ? 0 : quiet + 1;
    if (ply + 1 >= MIN_WALK && quiet >= QUIET) return 0;
    pos = mv.after;
  }
  return 0;
}

/**
 * The verdict on any move played in a line's position (a branch's, a probe's), kept with the position it's played
 * from (PositionAnalysis.verdicts), once both positions are analysed: its badge in the video. The engine's own
 * move keeps its bestVerdict.
 */
export function judge(g: Game, mv: { before: string; after: string; uci: string; color: "w" | "b" }) {
  const a = g.analysis[mv.before];
  const next = g.analysis[mv.after];
  if (!a || a.failed || !next || next.failed || (a.bestUci ?? a.pv[0]) === mv.uci || a.verdicts?.[mv.uci]) return;
  a.verdicts = { ...a.verdicts, [mv.uci]: verdictOf(g, a, mv.before, mv.after, mv.uci, mv.color, next) };
}

/** The verdict on the engine's own best move, as the game's moves are judged (server/classify.ts). */
function verdictOf(g: Game, before: PositionAnalysis, fenBefore: string, fenAfter: string, uci: string, color: "w" | "b", after: PositionAnalysis): Classification {
  if (newRules(fenBefore, variantOf(g)).moves().length === 1) return "forced";
  const m = { color, uci, fenBefore, fenAfter } as MoveRecord;
  return classifyMove(m, before, after.score, undefined, false, variantOf(g)).classification;
}

/** The lines being prepared for a narration brief, by game, so a repeated brief waits on the same work. */
const preparing = new Map<string, Promise<void>>();

/**
 * The plan's own lines made ready for the narration brief: their questions' evidence and their branches
 * (the engine pass covers the game's top lines only; a director can pick others). Done positions are skipped.
 */
export function prepareLines(g: Game, lines: ShownLine[]): Promise<void> {
  const key = `${g.id}|${lines.map((l) => `${l.i}${l.kind}`).join(",")}`;
  const have = preparing.get(key);
  if (have) return have;
  const p = (async () => {
    for (const sl of lines) {
      await evidence(g, sl);
      await branches(g, sl);
    }
    saveGameNow(g);
  })().finally(() => preparing.delete(key));
  preparing.set(key, p);
  return p;
}
/** Whether the plan's lines are ready for the narration brief, waiting for them up to a few minutes (false: not yet). */
export async function linesPrepared(g: Game): Promise<boolean> {
  const lines = (g.video?.moments ?? []).flatMap((x) => {
    if (!x.line) return [];
    const sl = shownLine(g, g.moves.findIndex((m) => m.ply === x.ply), x.line.kind, !x.line.deep, true);
    return sl ? [sl] : [];
  });
  if (!lines.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([prepareLines(g, lines).then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), 270_000)))]);
  clearTimeout(timer);
  return done;
}