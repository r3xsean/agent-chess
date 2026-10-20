import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PositionAnalysis, Score } from "../shared/types";
import { newRules, type Variant } from "../shared/rules";
import { ROOT } from "./paths";

// Agents think for minutes per move, so the engine can afford a deep search: depth 22,
// capped at 12 s for the rare position that would take longer.
const ANALYSIS_DEPTH = Number(process.env.ENGINE_DEPTH ?? 22);
const ANALYSIS_MAX_MS = Number(process.env.ENGINE_MAX_MS ?? 12_000);

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
}

export interface EngineOptions {
  label: string;
  depth: number;
  maxMs: number;
  threads: number;
  hashMb: number;
}

const GAME_ENGINE: EngineOptions = {
  label: "engine",
  depth: ANALYSIS_DEPTH,
  maxMs: ANALYSIS_MAX_MS,
  threads: Math.max(1, Math.min(12, Number(process.env.ENGINE_THREADS ?? 8))),
  hashMb: 512,
};

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

  constructor(private opts: EngineOptions = GAME_ENGINE) {}

  start() {
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
        this.lineHandler?.(line);
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
    this.chess960 = false;
    this.send("isready");
    console.log(`[${label}] ${exe} (threads=${threads}, depth=${depth}, max ${maxMs} ms)`);
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

  /** `multipv`: search that many lines and return them all (`multi`), best first. */
  analyze(fen: string, variant: Variant = "standard", multipv?: number): Promise<PositionAnalysis & { multi?: { score: Score; pv: string[] }[] }> {
    return new Promise((resolve, reject) => {
      this.queue.push({ fen, variant, resolve, reject, ...(multipv && { multipv }) });
      this.pump();
    });
  }

  private pump() {
    if (this.busy || !this.proc) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    this.current = job;
    const sideToMove = job.fen.split(" ")[1] === "b" ? "b" : "w";
    const lines: Record<number, { depth: number; score: Score; pv: string[] }> = {};
    const timer = setTimeout(() => this.send("stop"), this.opts.maxMs);
    // Watchdog: if 'stop' doesn't produce a bestmove, the process is hung.
    const watchdog = setTimeout(() => {
      console.error(`[${this.opts.label}] analysis hung; restarting stockfish`);
      this.handleExit();
    }, this.opts.maxMs + 10_000);
    this.timers = [timer, watchdog];
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
        clearTimeout(timer);
        clearTimeout(watchdog);
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
    this.send(`position fen ${job.fen}`);
    this.send(`go depth ${this.opts.depth}`);
  }

  stop() {
    this.proc?.removeAllListeners("exit");
    this.proc?.kill();
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
