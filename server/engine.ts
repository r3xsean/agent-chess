import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PositionAnalysis, Score } from "../shared/types";
import { newRules, type Variant } from "../shared/rules";
import { ROOT } from "./paths";

// Agents think for minutes per move, so each position is searched to its depth goal (20: against depth 22,
// a game's verdicts change no more often than rerunning 22 changes them), however long that takes.
// ENGINE_MAX_MS, when set, caps it instead.
const ANALYSIS_DEPTH = Number(process.env.ENGINE_DEPTH ?? 20);
const ANALYSIS_MAX_MS = process.env.ENGINE_MAX_MS ? Number(process.env.ENGINE_MAX_MS) : undefined;
/** Last resort for a runaway search: stopped (and logged) after this long, keeping the depth it reached. */
const RUNAWAY_MS = Number(process.env.ENGINE_RUNAWAY_MS ?? 30 * 60_000);
/** Stockfish answers `isready` even mid-search: one that hasn't for HANG_MS is hung, however long the search. */
const PING_MS = 15_000;
const HANG_MS = 120_000;

// While one of these programs runs (a game on this PC), every engine searches with GAMING_THREADS
// threads at idle priority, so it takes neither CPU time nor the CPU's shared power budget from the
// game: the same depth, later. Engines whose work nobody is waiting on (pauseWhileGaming) wait instead.
const GAMING_PROCESSES = (process.env.GAMING_PROCESSES ?? "deadlock.exe")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const GAMING_THREADS = Math.max(1, Number(process.env.GAMING_THREADS ?? 1));
let gaming = false;
let gamingWatch: NodeJS.Timeout | null = null;
const gamingListeners = new Set<() => void>();

function watchGaming() {
  if (gamingWatch || process.platform !== "win32" || !GAMING_PROCESSES.length) return;
  const check = () =>
    execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return;
      const running = new Set(out.split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, "").toLowerCase()));
      const now = GAMING_PROCESSES.some((p) => running.has(p));
      if (now === gaming) return;
      gaming = now;
      console.log(now ? `[engine] a game is running: engines drop to ${GAMING_THREADS} thread(s) at idle priority` : "[engine] no game running: engines back to full speed");
      for (const f of gamingListeners) f();
    });
  check();
  gamingWatch = setInterval(check, 10_000);
  gamingWatch.unref();
}

function findStockfish(): string {
  if (process.env.STOCKFISH_PATH) return process.env.STOCKFISH_PATH;
  const dir = path.join(ROOT, "vendor", "stockfish-dl", "stockfish");
  if (existsSync(dir)) {
    const exe = readdirSync(dir).find((f) => f.startsWith("stockfish") && f.endsWith(".exe"));
    if (exe) return path.join(dir, exe);
  }
  return "stockfish";
}

interface Job {
  fen: string;
  variant: Variant;
  /** Lines wanted (MultiPV), returned all together (multi); the usual two otherwise. */
  multipv?: number;
  resolve: (a: PositionAnalysis) => void;
  reject: (e: Error) => void;
  attempts?: number;
  cancelled?: boolean;
  urgent?: boolean;
}

export interface EngineOptions {
  label: string;
  /** The goal: a search is done when it reaches this depth. */
  depth: number;
  /** Cut each search short after this long instead (quick answers: the website's analysis board, a shallow guess). */
  maxMs?: number;
  threads: number;
  /** Threads for an urgent search (an agent waiting on it), if not `threads`. */
  urgentThreads?: number;
  hashMb: number;
  /** While a game runs, start only urgent searches; the rest (nobody waiting on them) wait for it to end. */
  pauseWhileGaming?: boolean;
}

const GAME_ENGINE: EngineOptions = {
  label: "engine",
  depth: ANALYSIS_DEPTH,
  ...(ANALYSIS_MAX_MS !== undefined && { maxMs: ANALYSIS_MAX_MS }),
  threads: Math.max(1, Math.min(os.availableParallelism(), Number(process.env.ENGINE_THREADS ?? 8))),
  hashMb: 512,
};
/** Game-review engines searching side by side: positions are independent, and two 8-thread searches get through more of them than one 16-thread search. */
const GAME_ENGINES = Math.max(1, Math.min(8, Number(process.env.ENGINE_COUNT ?? 2)));

export class SupersededError extends Error {}

/** Single Stockfish process, one analysis at a time, MultiPV 2. */
export class Engine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private queue: Job[] = [];
  private busy = false;
  private lineHandler: ((line: string) => void) | null = null;

  private restarts = 0;
  /** Whether Stockfish is in Chess960 mode (castling as king-takes-rook in and out). */
  private chess960 = false;
  /** Threads and idle priority the running process has now (see `gaming`). */
  private threadsNow = 0;
  private idleNow = false;

  /** `runnable`: whether it may start a search now (a pool parks its spare engines while a game runs). `steal`: where it takes work from when its own queue is empty. */
  constructor(
    private opts: EngineOptions = GAME_ENGINE,
    private runnable: () => boolean = () => true,
    private steal: (urgentOnly: boolean) => Job | undefined = () => undefined,
  ) {}

  /** Hand over the first queued search (an urgent one only, if asked). */
  take(urgentOnly: boolean): Job | undefined {
    if (urgentOnly && !this.queue[0]?.urgent) return undefined;
    return this.queue.shift();
  }

  get queued() {
    return this.queue.length;
  }

  /** Searches queued or running. */
  get load() {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  /** Hand over the queued (not yet running) searches. */
  drain(): Job[] {
    return this.queue.splice(0);
  }

  adopt(jobs: Job[]) {
    for (const job of jobs) {
      if (job.urgent) this.queue.splice(this.queue.filter((j) => j.urgent).length, 0, job);
      else this.queue.push(job);
    }
    this.pump();
  }

  kick() {
    this.pump();
  }

  /** When Stockfish last answered `isready`. */
  private lastReady = 0;

  start() {
    watchGaming();
    const exe = findStockfish();
    this.proc = spawn(exe, [], { stdio: "pipe", windowsHide: true });
    this.proc.on("error", (e) => {
      // Spawn failure (missing binary etc.): don't crash the server; 'exit' may never fire.
      console.error(`[${this.opts.label}] could not run ${exe}: ${e.message}`);
      this.handleExit();
    });
    this.proc.stdin.on("error", () => {});
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (line === "readyok") this.lastReady = Date.now();
        else this.lineHandler?.(line);
      }
    });
    this.proc.on("exit", (code) => {
      console.error(`[${this.opts.label}] stockfish exited (${code})`);
      this.handleExit();
    });
    const { threads, hashMb, depth, maxMs, label } = this.opts;
    this.send("uci");
    this.send(`setoption name Threads value ${threads}`);
    this.send(`setoption name Hash value ${hashMb}`);
    this.send("setoption name MultiPV value 2");
    this.threadsNow = threads;
    this.idleNow = false;
    this.chess960 = false;
    this.send("isready");
    console.log(`[${label}] ${exe} (threads=${threads}, depth=${depth}${maxMs !== undefined ? `, max ${maxMs} ms` : ", no time limit"})`);
  }

  /** Drop every queued request and cut the running search short — only the newest request matters. */
  supersede() {
    for (const job of this.queue.splice(0)) job.reject(new SupersededError("superseded"));
    if (this.current) {
      this.current.cancelled = true;
      this.current.reject(new SupersededError("superseded")); // its late bestmove resolves nothing
      this.send("stop");
    }
  }

  private current: Job | null = null;
  private timers: NodeJS.Timeout[] = [];

  /** Engine died or hung: retry the current job (at most twice), then give it a neutral result so nothing waits forever. */
  private handleExit() {
    if (!this.proc && !this.busy && !this.current) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.proc?.removeAllListeners();
    this.proc?.kill();
    this.proc = null;
    const job = this.current;
    this.current = null;
    this.busy = false;
    this.lineHandler = null;
    if (job && !job.cancelled) {
      job.attempts = (job.attempts ?? 0) + 1;
      if (job.attempts <= 2) this.queue.unshift(job);
      else {
        console.error(`[${this.opts.label}] giving up on ${job.fen}`);
        job.resolve({ depth: 1, score: { cp: 0 }, pv: [], failed: true });
      }
    }
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(this.restarts++, 4));
    setTimeout(() => {
      this.start();
      this.pump();
    }, delay);
  }

  private send(cmd: string) {
    this.proc?.stdin.write(cmd + "\n");
  }

  /** `multipv`: search that many lines and return them all (`multi`), best first. `urgent`: someone is waiting on it, so it goes ahead of queued background searches. */
  analyze(fen: string, variant: Variant = "standard", multipv?: number, urgent = false): Promise<PositionAnalysis & { multi?: { score: Score; pv: string[] }[] }> {
    return new Promise((resolve, reject) => {
      this.adopt([{ fen, variant, resolve, reject, ...(multipv && { multipv }), ...(urgent && { urgent }) }]);
    });
  }

  private pump() {
    if (this.busy || !this.proc || !this.runnable()) return;
    // Urgent searches are at the front: while a game runs, a pausing engine starts only those.
    const urgentOnly = gaming && !!this.opts.pauseWhileGaming;
    const job = this.queue.length ? (urgentOnly && !this.queue[0].urgent ? undefined : this.queue.shift()) : this.steal(urgentOnly);
    if (!job) return;
    this.busy = true;
    this.current = job;
    const { label } = this.opts;
    const sideToMove = job.fen.split(" ")[1] === "b" ? "b" : "w";
    const lines: Record<number, { depth: number; score: Score; pv: string[] }> = {};
    const threads = gaming ? Math.min(this.opts.threads, GAMING_THREADS) : job.urgent && this.opts.urgentThreads ? this.opts.urgentThreads : this.opts.threads;
    if (threads !== this.threadsNow) {
      this.send(`setoption name Threads value ${threads}`);
      this.threadsNow = threads;
    }
    if (gaming !== this.idleNow && this.proc.pid) {
      try {
        os.setPriority(this.proc.pid, gaming ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_NORMAL);
      } catch {}
      this.idleNow = gaming;
    }
    const timers: NodeJS.Timeout[] = [];
    if (this.opts.maxMs !== undefined) timers.push(setTimeout(() => this.send("stop"), this.opts.maxMs));
    timers.push(
      setTimeout(() => {
        console.error(`[${label}] runaway search stopped after ${Math.round(RUNAWAY_MS / 60_000)} min at depth ${lines[1]?.depth ?? 0} (goal ${this.opts.depth}): ${job.fen}`);
        this.send("stop");
      }, RUNAWAY_MS),
    );
    // Liveness, not a time limit: a search may take as long as it needs, but Stockfish has to keep answering.
    this.lastReady = Date.now();
    timers.push(
      setInterval(() => {
        if (Date.now() - this.lastReady <= HANG_MS) return this.send("isready");
        console.error(`[${label}] stockfish stopped responding; restarting it`);
        this.handleExit();
      }, PING_MS),
    );
    this.timers = timers;
    this.lineHandler = (line) => {
      if (line.startsWith("info") && line.includes(" pv ")) {
        const m = /multipv (\d+)/.exec(line);
        const d = /\bdepth (\d+)/.exec(line);
        const cp = /score cp (-?\d+)/.exec(line);
        const mate = /score mate (-?\d+)/.exec(line);
        if (line.includes("lowerbound") || line.includes("upperbound")) return;
        const pv = line.split(" pv ")[1]?.trim().split(/\s+/) ?? [];
        const idx = m ? Number(m[1]) : 1;
        const sign = sideToMove === "w" ? 1 : -1;
        const score: Score = mate
          ? { mate: Number(mate[1]) * sign }
          : { cp: Number(cp?.[1] ?? 0) * sign };
        lines[idx] = { depth: Number(d?.[1] ?? 0), score, pv };
      } else if (line.startsWith("bestmove")) {
        for (const t of timers) clearTimeout(t);
        this.timers = [];
        this.restarts = 0;
        this.lineHandler = null;
        this.busy = false;
        this.current = null;
        if (job.multipv) this.send("setoption name MultiPV value 2");
        const best = lines[1];
        const result: PositionAnalysis & { multi?: { score: Score; pv: string[] }[] } = {
          depth: best?.depth ?? 0,
          score: best?.score ?? { cp: 0 },
          bestUci: best?.pv[0] ?? line.split(" ")[1],
          pv: best?.pv.slice(0, 12) ?? [],
          second: lines[2]?.score,
          ...(lines[2]?.pv[0] && { secondUci: lines[2].pv[0] }),
          ...(job.multipv && {
            multi: Object.keys(lines)
              .map(Number)
              .sort((a, b) => a - b)
              .map((k) => ({ score: lines[k].score, pv: lines[k].pv })),
          }),
        };
        result.bestSan = uciToSan(job.fen, result.bestUci, job.variant);
        job.resolve(result);
        this.pump();
      }
    };
    const want960 = job.variant === "chess960";
    if (want960 !== this.chess960) {
      this.send(`setoption name UCI_Chess960 value ${want960}`);
      this.chess960 = want960;
    }
    if (job.multipv) this.send(`setoption name MultiPV value ${job.multipv}`);
    // A fresh hash for every search: one left full of other positions' (often mate) scores can turn a
    // few-second search into a stall at depth 11 for many minutes, and costs time even when it doesn't.
    this.send("ucinewgame");
    this.send(`position fen ${job.fen}`);
    this.send(`go depth ${this.opts.depth}`);
  }

  stop() {
    this.proc?.removeAllListeners("exit");
    this.proc?.kill();
  }
}

/**
 * Game-review engines working side by side, each search going to the least busy one, and an engine
 * that runs out of work taking the others' queued searches. While a game runs on this PC only the
 * first engine searches, slowed as above; the others' waiting searches move to it.
 */
export class EnginePool {
  private engines: Engine[];
  private onGaming = () => this.rebalance();

  constructor(count = GAME_ENGINES, opts: EngineOptions = GAME_ENGINE) {
    this.engines = Array.from(
      { length: count },
      (_, i) =>
        new Engine(
          i ? { ...opts, label: `${opts.label}-${i + 1}` } : opts,
          i ? () => !gaming : () => true,
          (urgentOnly) => this.stealFor(i, urgentOnly),
        ),
    );
  }

  /** An idle engine takes the oldest queued search of the busiest one, so nothing waits behind a long search while an engine sits free. */
  private stealFor(i: number, urgentOnly: boolean) {
    const from = this.engines.filter((e, j) => j !== i && e.queued).sort((a, b) => b.queued - a.queued);
    for (const e of from) {
      const job = e.take(urgentOnly);
      if (job) return job;
    }
    return undefined;
  }

  start() {
    for (const e of this.engines) e.start();
    gamingListeners.add(this.onGaming);
  }

  stop() {
    gamingListeners.delete(this.onGaming);
    for (const e of this.engines) e.stop();
  }

  /** `urgent`: see Engine.analyze. */
  analyze(fen: string, variant: Variant = "standard", multipv?: number, urgent = false) {
    const done = this.engines[this.pick()].analyze(fen, variant, multipv, urgent);
    for (const e of this.engines) e.kick(); // an idle one picks it up if it queued behind a search
    return done;
  }

  private pick() {
    if (gaming) return 0;
    const least = Math.min(...this.engines.map((e) => e.load));
    return this.engines.findIndex((e) => e.load === least);
  }

  private rebalance() {
    const [first, ...rest] = this.engines;
    if (gaming) {
      for (const e of rest) first.adopt(e.drain());
      return;
    }
    for (const job of first.drain()) this.engines[this.pick()].adopt([job]);
    for (const e of this.engines) e.kick();
  }
}

export function uciToSan(fen: string, uci: string | undefined, variant: Variant = "standard"): string | undefined {
  if (!uci || uci === "(none)") return undefined;
  try {
    return newRules(fen, variant).move(uci).san;
  } catch {
    return undefined;
  }
}
