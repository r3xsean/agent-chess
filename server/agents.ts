import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CLI, DATA, PORT, ROOT } from "./paths";
import { saveSeatsNow } from "./store";

/*
 * Agents the server runs itself, through the provider's own CLI (`claude -p`, `codex exec`), in the
 * background: no T3 thread, so players stay out of the T3 sidebar. Each runs detached, so
 * it outlives a server restart, and writes its JSON events to a log under data/agent-logs. The server knows
 * when one stops; it carries on in the same session (`--resume`), after the usage limit resets if that's
 * what stopped it.
 */

export type CliProvider = "claudeAgent" | "codex";

/** One run of an agent's CLI: what the server needs to find it again, after a restart too. Local only. */
export interface AgentProc {
  provider: CliProvider;
  /** On Windows, its host's (agentHost.mjs), which runs as long as the CLI does. */
  pid: number;
  log: string;
  /** Where this run's output starts in the log: a session's runs all write to the same one. */
  offset: number;
  startedAt: number;
  /** When the OS says the process started, read just after: what tells it apart from a later process with its pid. */
  created?: string;
  /** The session this run carries on; a new session's id is read from its log. */
  session?: string;
  /** Runs in a row that carried the session on without the agent acting since. */
  resumes: number;
}

/** Why a stopped agent stopped, from what its run wrote. */
export interface AgentOutcome {
  session?: string;
  usageLimit?: { id: string; at: number; resetAt?: number };
}

const HOST = path.join(ROOT, "server", "agentHost.mjs");

const isCli = (p: string): p is CliProvider => p === "claudeAgent" || p === "codex";

const isFile = (f: string) => existsSync(f) && statSync(f).isFile();

/** An executable on the PATH (only real executables: a .cmd shim can't be started without a shell). */
function onPath(names: string[]) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const n of names) {
      const f = path.join(dir, n);
      if (dir && isFile(f)) return f;
    }
  }
}

/**
 * The provider's CLI: `CLAUDE_BIN` / `CODEX_BIN` if set ("none" turns it off, so the seat goes to T3 as
 * before), else found where it's installed. A .js/.mjs path runs under this Node.
 */
function binFor(provider: CliProvider): string | undefined {
  const set = provider === "claudeAgent" ? process.env.CLAUDE_BIN : process.env.CODEX_BIN;
  if (set !== undefined) return set && set !== "none" && isFile(set) ? set : undefined;
  if (provider === "claudeAgent") return onPath(process.platform === "win32" ? ["claude.exe"] : ["claude"]);
  const npmJs = process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (npmJs && isFile(npmJs)) return npmJs;
  return onPath(process.platform === "win32" ? ["codex.exe"] : ["codex"]);
}

function command(provider: CliProvider): { cmd: string; pre: string[] } | undefined {
  const bin = binFor(provider);
  if (!bin) return;
  return /\.[cm]?js$/i.test(bin) ? { cmd: process.execPath, pre: [bin] } : { cmd: bin, pre: [] };
}

/** Whether the server can run this provider's agents itself. */
export const canRunAgent = (provider: string) => isCli(provider) && !!command(provider);

/** Whether it can run any agent itself. */
export const anyAgentCli = () => canRunAgent("claudeAgent") || canRunAgent("codex");

const cliCall = (cmd: string, key: string) => `node "${CLI}" ${cmd} --key ${key}`;

/** What a new agent is told: only its seat key and the command that gives it its task. */
export const agentPrompt = (key: string) => `You are an Agent Chess agent, started by the local Agent Chess server. Your seat key: ${key}

Run:  ${cliCall("start", key)}
Its first line is a title (ignore it), then your task: who you are in this game and exactly what to do. Do the task: it is your only instruction, and it isn't finished until the CLI prints DONE. If the server can't be reached, wait a minute and try again, up to five times, then stop. If it says your key is unknown, stop.`;

/** What an agent that stopped before its task was done is told when its session carries on. */
export const resumePrompt = (key: string) =>
  `Your run stopped before your task was finished (the CLI hasn't printed DONE for you). Carry on with your task from where you left off. If you're not sure where that is, run:  ${cliCall("help", key)}`;

/** The CLI's arguments. The prompt goes in on stdin, so nothing in it passes through a shell. */
function args(provider: CliProvider, model: string, effort: string, session?: string): string[] {
  if (provider === "claudeAgent") {
    // "ultrathink" is a word in the prompt (see startAgent), not an effort level.
    const level = effort === "ultrathink" ? [] : ["--effort", effort === "ultracode" ? "xhigh" : effort];
    return ["-p", ...(session ? ["--resume", session] : []), "--model", model, ...level, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--strict-mcp-config"];
  }
  const flags = ["--json", "-m", model, "-c", `model_reasoning_effort="${effort}"`, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
  return session ? ["exec", "resume", session, ...flags, "-"] : ["exec", ...flags, "-C", ROOT, "-"];
}

/** How to ask the OS when a process started, to the finest it says. */
function createdQuery(pid: number): [string, string[]] {
  if (process.platform === "win32") return ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]];
  return ["ps", ["-o", "lstart=", "-p", String(pid)]];
}

/** When the OS says a process started, or undefined if it isn't running. */
export function processCreated(pid: number): string | undefined {
  // Linux counts it in clock ticks since boot: exact, and no process to start.
  try {
    return `ticks:${readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19]}`;
  } catch {}
  const [cmd, a] = createdQuery(pid);
  const r = spawnSync(cmd, a, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

function processCreatedLater(pid: number, then: (created: string) => void) {
  if (existsSync(`/proc/${pid}/stat`)) {
    const c = processCreated(pid);
    if (c) then(c);
    return;
  }
  const [cmd, a] = createdQuery(pid);
  execFile(cmd, a, { encoding: "utf8", windowsHide: true, timeout: 30_000 }, (err, stdout) => {
    if (!err && stdout.trim()) then(stdout.trim());
  });
}

/** What an agent's host says on fd 3 about starting its CLI ("" if it says nothing within 30 s). */
function hostSays(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let said = "";
    const pipe = child.stdio[3];
    const done = () => {
      clearTimeout(timer);
      pipe?.destroy();
      resolve(said.trim());
    };
    const timer = setTimeout(done, 30_000);
    if (!pipe) return done();
    pipe.on("data", (d) => (said += d));
    pipe.on("close", done);
  });
}

/** Runs started by this server, by pid, so their exit is logged; after a restart, `agentAlive` checks the pid. */
const children = new Map<number, { child: ChildProcess; startedAt: number }>();
/** Pids of runs from before a restart found to be still theirs (a running process keeps its pid). */
const confirmed = new Map<number, string>();

/**
 * Start an agent's CLI in the background, carrying `session` on if given. Rejects if it can't be started.
 * Its OS start time is filled in on the returned record (and saved) a moment later.
 */
export async function startAgent(o: { provider: string; model: string; effort: string; prompt: string; logName: string; session?: string; resumes?: number }): Promise<AgentProc> {
  if (!isCli(o.provider)) throw new Error(`No CLI for provider ${o.provider}`);
  const c = command(o.provider);
  if (!c) throw new Error(`The ${o.provider === "codex" ? "Codex" : "Claude"} CLI isn't installed (or is turned off)`);
  // On Windows it runs under a small host that gives it a console with no window (see agentHost.mjs).
  const hosted = process.platform === "win32";
  const argv = [...c.pre, ...args(o.provider, o.model, o.effort, o.session)];
  const dir = path.join(DATA, "agent-logs");
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, `${o.logName}.jsonl`);
  const fd = openSync(log, "a");
  const offset = fstatSync(fd).size;
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_CHESS_URL: `http://127.0.0.1:${PORT}` };
  // Started from inside a Claude Code session, the server would otherwise pass on that session's markers.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const prompt = o.provider === "claudeAgent" && o.effort === "ultrathink" ? `ultrathink\n\n${o.prompt}` : o.prompt;
  let child: ChildProcess;
  try {
    // Detached: it isn't killed with the server (a restart leaves it running).
    child = spawn(hosted ? process.execPath : c.cmd, hosted ? [HOST, c.cmd, ...argv] : argv, { cwd: ROOT, env, detached: true, windowsHide: true, stdio: hosted ? ["pipe", fd, fd, "pipe"] : ["pipe", fd, fd] });
  } finally {
    closeSync(fd);
  }
  // Listened for before anything can throw: an unheard spawn error would take the server down.
  child.on("error", (e) => console.error(`[agents] ${o.logName}: ${e.message}`));
  child.stdin?.on("error", () => {});
  child.stdio[3]?.on("error", () => {});
  const name = o.provider === "codex" ? "Codex" : "Claude";
  if (!child.pid) throw new Error(`The ${name} CLI didn't start`);
  child.stdin!.end(prompt);
  const pid = child.pid;
  const startedAt = Date.now();
  children.set(pid, { child, startedAt });
  child.on("exit", (code) => {
    if (children.get(pid)?.child === child) children.delete(pid);
    console.log(`[agents] ${o.logName} (pid ${pid}) exited${code === null ? "" : ` with ${code}`}`);
  });
  child.unref();
  // The host says whether the CLI itself started: one that didn't fails here, as a direct start does at once.
  if (hosted) {
    const said = await hostSays(child);
    if (said !== "started") {
      if (child.exitCode === null) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
      throw new Error(`The ${name} CLI didn't start${said ? `: ${said.replace(/^error: /, "")}` : ""}`);
    }
  }
  const agent: AgentProc = { provider: o.provider, pid, log, offset, startedAt, ...(o.session && { session: o.session }), resumes: o.resumes ?? 0 };
  processCreatedLater(pid, (created) => {
    agent.created = created;
    saveSeatsNow();
  });
  return agent;
}

/**
 * Whether an agent's run is still going. Its pid may be another process's by now (one of this server's
 * later runs, or anything else after a restart): that isn't it.
 */
export function agentAlive(p: AgentProc) {
  const own = children.get(p.pid);
  if (own) return own.startedAt === p.startedAt && own.child.exitCode === null && own.child.signalCode === null;
  try {
    process.kill(p.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") {
      confirmed.delete(p.pid);
      return false;
    }
  }
  if (!p.created || confirmed.get(p.pid) === p.created) return true;
  if (processCreated(p.pid) !== p.created) return false;
  confirmed.set(p.pid, p.created);
  return true;
}

/**
 * Stop an agent and everything it started, only if its pid is still its own: one of this server's runs, or
 * from before a restart, a process the OS gives the start time recorded for it.
 */
export function stopAgent(p: AgentProc) {
  const own = children.get(p.pid);
  if (own ? own.startedAt !== p.startedAt : !p.created || processCreated(p.pid) !== p.created) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
  else {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {}
  }
}

/** Up to `bytes` of a file between `start` and its end, from the front or the back of that. */
function readPart(file: string, start: number, bytes: number, from: "head" | "tail") {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const n = Math.max(0, Math.min(size - start, bytes));
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, from === "head" ? start : size - n);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const events = (text: string) =>
  text.split("\n").flatMap((l) => {
    try {
      const e = JSON.parse(l);
      return e && typeof e === "object" ? [e] : [];
    } catch {
      return [];
    }
  });

/**
 * When Codex says to try again, as a time: "try again at Oct 22nd, 2026 2:21 PM" or "at 2:21 PM" (a usage
 * limit), "try again in 20s" or "in 2 hours 5 minutes" (a rate limit).
 */
function codexResetAt(msg: string, at: number): number | undefined {
  const rel = /try again in\s+(?:(\d+)\s*d(?:ays?)?\b)?[\s,]*(?:(\d+)\s*h(?:ours?|rs?)?\b)?[\s,]*(?:(\d+)\s*m(?:in(?:ute)?s?)?\b)?[\s,]*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b)?(?:(\d+)\s*ms\b)?/i.exec(msg);
  if (rel && rel.slice(1).some(Boolean)) {
    const [d, h, m, s, ms] = rel.slice(1).map((x) => Number(x ?? 0));
    return at + (((d * 24 + h) * 60 + m) * 60 + s) * 1000 + ms;
  }
  const abs = /try again at\s+([^.]+?)(?:\.|$)/i.exec(msg);
  if (!abs) return;
  const text = abs[1].replace(/(\d)(st|nd|rd|th)\b/g, "$1").trim();
  const full = Date.parse(text);
  if (Number.isFinite(full) && full > at - 86_400_000) return full;
  const clock = /^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i.exec(text);
  if (!clock) return;
  const d = new Date(at);
  let h = Number(clock[1]) % (clock[3] ? 12 : 24);
  if (clock[3] && /^p/i.test(clock[3])) h += 12;
  d.setHours(h, Number(clock[2]), 0, 0);
  if (d.getTime() <= at) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** How far each running agent's log has been looked through for a limit. */
const scanned = new Map<string, number>();

/**
 * Whether a running agent's CLI has reported a usage limit that ended its turn: one that stays up after
 * it instead of stopping. Reads only what's new since the last look.
 */
export function limitWhileRunning(p: AgentProc) {
  const k = `${p.log}|${p.offset}`;
  let size: number;
  try {
    size = statSync(p.log).size;
  } catch {
    return false;
  }
  const from = Math.max(scanned.get(k) ?? p.offset, size - 1024 * 1024);
  if (size <= from) return false;
  const text = readPart(p.log, from, size - from, "head");
  const end = text.lastIndexOf("\n");
  if (end < 0) return false;
  scanned.set(k, from + Buffer.byteLength(text.slice(0, end + 1)));
  // Only a line that could end a turn on a limit is worth reading the run for (a failed result, maybe after a rejected window in an earlier look).
  if (!/rate_limit|429|usage limit|hit your limit|turn\.failed|"is_error":\s*true/i.test(text.slice(0, end))) return false;
  return !!agentOutcome(p, true).usageLimit;
}

/**
 * Read what a stopped agent's run wrote (nothing an earlier run of its session did): its session, and
 * whether a usage limit stopped it. `ended`: count a limit only once the CLI has ended the turn on it (for
 * a run still going, which may yet retry).
 */
export function agentOutcome(p: AgentProc, ended = false): AgentOutcome {
  const head = events(readPart(p.log, p.offset, 256 * 1024, "head"));
  const run = events(readPart(p.log, p.offset, 256 * 1024, "tail"));
  const session = p.session ?? [...head, ...run].map((e) => (p.provider === "codex" ? (e.type === "thread.started" ? e.thread_id : undefined) : e.session_id)).find((s) => typeof s === "string");
  let at = p.startedAt;
  try {
    at = statSync(p.log).mtimeMs;
  } catch {}
  const id = createHash("sha256").update(`${p.log}|${p.offset}|${p.startedAt}`).digest("hex");
  if (p.provider === "claudeAgent") {
    // As T3 reads them: a rejected window (with no overage to fall back on) or a 429 ends the run.
    const result = run.filter((e) => e.type === "result").at(-1);
    const rejected = run.filter((e) => e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected");
    const overage = rejected.some((e) => ["allowed", "allowed_warning"].includes(e.rate_limit_info?.overageStatus) || e.rate_limit_info?.isUsingOverage === true);
    const limited = (result?.is_error && result.api_error_status === 429) || (rejected.length > 0 && !overage && (result ? result.is_error : !ended));
    if (!limited) return { session };
    const resets = rejected.map((e) => Number(e.rate_limit_info?.resetsAt) * 1000).filter((t) => Number.isFinite(t) && t > 0);
    // A gateway limit says how long in its message.
    const gateway = typeof result?.result === "string" ? /\(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/.exec(result.result) : null;
    if (gateway) resets.push(at + (Number(gateway[1] ?? 0) * 3600 + Number(gateway[2] ?? 0) * 60 + Number(gateway[3] ?? 0)) * 1000);
    return { session, usageLimit: { id, at, ...(resets.length && { resetAt: Math.max(...resets) }) } };
  }
  // The last failure, unless a turn completed after it (a retried error isn't what ended the run).
  let last = run.length - 1;
  while (last >= 0 && !["turn.failed", "error", "turn.completed"].includes(run[last].type)) last--;
  const failed = last >= 0 && run[last].type !== "turn.completed" && (!ended || run[last].type === "turn.failed") ? run[last] : undefined;
  const msg = String(failed?.error?.message ?? failed?.message ?? "");
  if (!failed || !/usage limit|rate limit|hit your limit/i.test(msg)) return { session };
  const resetAt = codexResetAt(msg, at);
  return { session, usageLimit: { id, at, ...(resetAt && { resetAt }) } };
}
