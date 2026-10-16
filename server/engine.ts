import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import type { PositionAnalysis, Score } from "../shared/types";
import { ROOT } from "./paths";

const ANALYSIS_DEPTH = Number(process.env.ENGINE_DEPTH ?? 18);
const ANALYSIS_MAX_MS = Number(process.env.ENGINE_MAX_MS ?? 4000);

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
  resolve: (a: PositionAnalysis) => void;
  reject: (e: Error) => void;
  attempts?: number;
}

/** Single Stockfish process, one analysis at a time, MultiPV 2. */
export class Engine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private queue: Job[] = [];
  private busy = false;
  private lineHandler: ((line: string) => void) | null = null;

  private restarts = 0;

  start() {
    const exe = findStockfish();
    this.proc = spawn(exe, [], { stdio: "pipe" });
    this.proc.on("error", (e) => {
      // Spawn failure (missing binary etc.): don't crash the server; 'exit' may never fire.
      console.error(`[engine] could not run ${exe}: ${e.message}`);
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
      console.error(`[engine] stockfish exited (${code})`);
      this.handleExit();
    });
    const threads = Math.max(1, Math.min(6, Number(process.env.ENGINE_THREADS ?? 4)));
    this.send("uci");
    this.send(`setoption name Threads value ${threads}`);
    this.send("setoption name Hash value 256");
    this.send("setoption name MultiPV value 2");
    this.send("isready");
    console.log(`[engine] ${exe} (threads=${threads}, depth=${ANALYSIS_DEPTH})`);
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
    if (job) {
      job.attempts = (job.attempts ?? 0) + 1;
      if (job.attempts <= 2) this.queue.unshift(job);
      else {
        console.error(`[engine] giving up on ${job.fen}`);
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

  analyze(fen: string): Promise<PositionAnalysis> {
    return new Promise((resolve, reject) => {
      this.queue.push({ fen, resolve, reject });
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
    const timer = setTimeout(() => this.send("stop"), ANALYSIS_MAX_MS);
    // Watchdog: if 'stop' doesn't produce a bestmove, the process is hung.
    const watchdog = setTimeout(() => {
      console.error("[engine] analysis hung; restarting stockfish");
      this.handleExit();
    }, ANALYSIS_MAX_MS + 10_000);
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
        const best = lines[1];
        const result: PositionAnalysis = {
          depth: best?.depth ?? 0,
          score: best?.score ?? { cp: 0 },
          bestUci: best?.pv[0] ?? line.split(" ")[1],
          pv: best?.pv.slice(0, 12) ?? [],
          second: lines[2]?.score,
        };
        result.bestSan = uciToSan(job.fen, result.bestUci);
        job.resolve(result);
        this.pump();
      }
    };
    this.send(`position fen ${job.fen}`);
    this.send(`go depth ${ANALYSIS_DEPTH}`);
  }

  stop() {
    this.proc?.removeAllListeners("exit");
    this.proc?.kill();
  }
}

export function uciToSan(fen: string, uci: string | undefined): string | undefined {
  if (!uci || uci === "(none)") return undefined;
  try {
    const c = new Chess(fen);
    return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return undefined;
  }
}
