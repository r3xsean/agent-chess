// Agents the server runs itself through the provider's CLI (server/agents.ts), with a fake CLI standing in for
// claude and codex (scripts/fixtures/fake-agent.mjs). First its log reading and process handling in-process, then
// a spare server of its own: players start in the background, not through T3; one that stops carries its session
// on with the same key, until a few runs in a row never act; a usage limit pauses the clock (only while the player
// still has something to do) and waits for the reset; agents outlive a server crash, and one that stops while the
// server is down carries on after it, or goes to T3 if its CLI was turned off meanwhile.
//   node node_modules/tsx/dist/cli.mjs scripts/test-agents.ts
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import type { Game } from "../shared/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE = path.resolve("scripts/fixtures/fake-agent.mjs");
const data = mkdtempSync(path.join(tmpdir(), "chess-agents-"));
const fakeDir = mkdtempSync(path.join(tmpdir(), "chess-agents-fake-"));
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const kill = (pid: number) => (process.platform === "win32" ? spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }) : pidAlive(pid) && process.kill(pid, "SIGKILL"));
const lines = (f: string) => (existsSync(path.join(fakeDir, f)) ? readFileSync(path.join(fakeDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const runs = () => lines("runs.jsonl");
const children = () => lines("children.jsonl");
const control = (c: Record<string, string[]>) => writeFileSync(path.join(fakeDir, "control.json"), JSON.stringify(c));
async function until(check: () => Promise<boolean> | boolean, label: string, seconds = 30) {
  for (let n = 0; n < seconds * 10; n++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}\n${output}`);
}
let output = "";

/* ------------------------------ in-process: reading logs, starting and stopping ------------------------------ */

process.env.AGENT_CHESS_DATA = data;
// Nothing listens here: the in-process agent's hello goes nowhere, never to the live server.
process.env.PORT = "9";
process.env.CLAUDE_BIN = FAKE;
process.env.CODEX_BIN = FAKE;
process.env.FAKE_AGENT_DIR = fakeDir;
const { agentOutcome, agentAlive, startAgent, stopAgent, canRunAgent, processCreated, limitWhileRunning } = await import("../server/agents");
const { seatClaimed } = await import("../server/game");
const { seatKeys, saveSeatsNow } = await import("../server/store");

const logOf = (name: string, events: object[]) => {
  const f = path.join(data, `${name}.jsonl`);
  writeFileSync(f, events.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
};
const proc = (provider: "claudeAgent" | "codex", log: string, offset = 0) => ({ provider, pid: 1, log, offset, startedAt: Date.now() - 1000, resumes: 0 });
const init = (s: string) => ({ type: "system", subtype: "init", session_id: s });
const reset = Math.floor(Date.now() / 1000) + 3600;
const claudeLimit = [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset, overageStatus: "rejected" } }, { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "limit" }];

let out = agentOutcome(proc("claudeAgent", logOf("c-ok", [init("s1"), { type: "result", subtype: "success", is_error: false, session_id: "s1" }])));
assert.deepEqual(out, { session: "s1" }, "a Claude run that ended normally");
out = agentOutcome(proc("claudeAgent", logOf("c-limit", [init("s2"), ...claudeLimit])));
assert.equal(out.session, "s2");
assert.equal(out.usageLimit?.resetAt, reset * 1000, "a Claude usage limit, with when it resets");
out = agentOutcome(proc("claudeAgent", logOf("c-overage", [init("s3"), { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset, overageStatus: "allowed" } }, { type: "result", subtype: "success", is_error: false }])));
assert.equal(out.usageLimit, undefined, "a rejected window with overage allowed isn't a stop");
out = agentOutcome(proc("claudeAgent", logOf("c-gateway", [init("s4"), { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: 'API Error: 503 [x] [429]: {"type":"error","error":{"type":"rate_limit_error"}} (reset after 1h 2m 3s)' }])));
assert.ok(out.usageLimit?.resetAt && Math.abs(out.usageLimit.resetAt - (Date.now() + 3723_000)) < 5000, "a gateway limit's reset comes from its message");
// A session's runs share one log: each run reads only from where it started, even one that wrote nothing.
const shared = logOf("c-shared", [init("s5"), ...claudeLimit]);
const end = statSync(shared).size;
assert.deepEqual(agentOutcome({ ...proc("claudeAgent", shared, end), session: "s5" }), { session: "s5" }, "a later run that wrote nothing doesn't inherit the earlier limit");
appendFileSync(shared, [init("s5"), { type: "result", subtype: "success", is_error: false }].map((e) => JSON.stringify(e)).join("\n") + "\n");
assert.deepEqual(agentOutcome({ ...proc("claudeAgent", shared, end), session: "s5" }), { session: "s5" }, "nor one that ended normally");
// A run still going: only a limit that ended its turn counts, read a complete line at a time, each line once.
const live = logOf("c-live", [init("s6"), claudeLimit[0]]);
const running = { ...proc("claudeAgent", live), session: "s6" };
assert.equal(limitWhileRunning(running), false, "a rejected window it may still retry isn't the end");
const ending = JSON.stringify(claudeLimit[1]);
appendFileSync(live, ending.slice(0, 20));
assert.equal(limitWhileRunning(running), false, "half a line isn't read");
appendFileSync(live, ending.slice(20) + "\n");
assert.equal(limitWhileRunning(running), true, "the turn ended on the limit");
assert.equal(limitWhileRunning(running), false, "and that's reported once");
const split = logOf("c-split", [init("s7"), claudeLimit[0]]);
const splitRun = { ...proc("claudeAgent", split), session: "s7" };
assert.equal(limitWhileRunning(splitRun), false);
appendFileSync(split, JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "error" }) + "\n");
assert.equal(limitWhileRunning(splitRun), true, "a rejected window, then on a later look a failed result with no 429: the turn ended on the limit");
out = agentOutcome(proc("codex", logOf("x-ok", [{ type: "thread.started", thread_id: "t1" }, { type: "turn.completed" }])));
assert.deepEqual(out, { session: "t1" }, "a Codex run that ended normally");
out = agentOutcome(proc("codex", logOf("x-limit", [{ type: "thread.started", thread_id: "t2" }, { type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 5 minutes." } }])));
assert.ok(out.usageLimit?.resetAt && Math.abs(out.usageLimit.resetAt - (Date.now() + 7500_000)) < 5000, "a Codex limit, reset in 2 h 5 min");
out = agentOutcome(proc("codex", logOf("x-at", [{ type: "thread.started", thread_id: "t3" }, { type: "error", message: "You've hit your usage limit. Try again at 3:15 PM." }])));
const at = new Date(out.usageLimit!.resetAt!);
assert.ok(at.getHours() === 15 && at.getMinutes() === 15 && out.usageLimit!.resetAt! > Date.now() - 5000, "a Codex limit, reset at a clock time");
// Word for word what Codex printed when it last hit the limit here.
out = agentOutcome(proc("codex", logOf("x-real", [{ type: "thread.started", thread_id: "t6" }, { type: "turn.failed", error: { message: "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 22nd, 2026 2:21 PM." } }])));
assert.equal(out.usageLimit?.resetAt, new Date(2026, 9, 22, 14, 21).getTime(), "Codex's real limit message, with its date");
out = agentOutcome(proc("codex", logOf("x-secs", [{ type: "thread.started", thread_id: "t7" }, { type: "turn.failed", error: { message: "Rate limit reached for gpt-6-luna. Please try again in 20s." } }])));
assert.ok(out.usageLimit?.resetAt && Math.abs(out.usageLimit.resetAt - (Date.now() + 20_000)) < 5000, "a short rate limit, in seconds");
out = agentOutcome(proc("codex", logOf("x-other", [{ type: "thread.started", thread_id: "t4" }, { type: "turn.failed", error: { message: "stream disconnected" } }])));
assert.deepEqual(out, { session: "t4" }, "another Codex failure isn't a usage limit");
out = agentOutcome(proc("codex", logOf("x-retried", [{ type: "thread.started", thread_id: "t5" }, { type: "error", message: "Rate limit reached, retrying in 2s" }, { type: "turn.completed" }])));
assert.deepEqual(out, { session: "t5" }, "a retried error followed by a finished turn isn't a stop");
assert.deepEqual(agentOutcome(proc("codex", path.join(data, "missing.jsonl"))), { session: undefined }, "no log, no session");

assert.ok(canRunAgent("claudeAgent") && canRunAgent("codex") && !canRunAgent("human"));
process.env.CLAUDE_BIN = "none";
assert.ok(!canRunAgent("claudeAgent"), '"none" turns the CLI off');
process.env.CLAUDE_BIN = path.join(data, "no-such-claude.exe");
assert.ok(!canRunAgent("claudeAgent"), "a CLI path that isn't there is off too");
// One that's there but won't start throws, and its spawn error doesn't take the process down.
process.env.CLAUDE_BIN = path.resolve("README.md");
assert.throws(() => startAgent({ provider: "claudeAgent", model: "m", effort: "low", prompt: "x", logName: "unit-bad" }));
await sleep(500);
process.env.CLAUDE_BIN = FAKE;

// Its own agent: started detached with the prompt on stdin, its OS start time recorded, stopped with everything it started.
control({});
const mine = startAgent({ provider: "claudeAgent", model: "claude-haiku-5-5", effort: "low", prompt: "Your seat key: g1-w-00ff\nRun: start --key g1-w-00ff", logName: "unit-w" });
await until(() => children().length === 1, "the fake starts a process of its own");
assert.equal(runs()[0]?.key, "g1-w-00ff", "the prompt arrives on stdin");
await until(() => !!mine.created, "its OS start time is recorded");
assert.equal(mine.created, processCreated(mine.pid));
assert.ok(agentAlive(mine));
// An earlier run's record whose pid Windows has given to this run isn't this run: not alive, and not stopped by it.
const stale = { ...mine, startedAt: mine.startedAt - 60_000, created: "2026-01-01T00:00:00.0000000Z" };
assert.equal(agentAlive(stale), false, "an earlier run with a reused pid isn't running");
stopAgent(stale);
await sleep(300);
assert.ok(agentAlive(mine), "and stopping it leaves the run that has the pid now alone");
stopAgent(mine);
await until(() => !agentAlive(mine) && !pidAlive(children()[0].pid), "its whole tree stopped");

// After a restart (not its child any more), a pid is stopped only if its OS start time is the one recorded.
const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
await sleep(500);
const created = processCreated(other.pid!);
assert.ok(created);
stopAgent({ provider: "claudeAgent", pid: other.pid!, log: "", offset: 0, startedAt: Date.now(), resumes: 0 });
await sleep(300);
assert.ok(pidAlive(other.pid!), "no recorded start time: left alone");
stopAgent({ provider: "claudeAgent", pid: other.pid!, log: "", offset: 0, startedAt: Date.now(), created: "2026-01-01T00:00:00.0000000Z", resumes: 0 });
await sleep(300);
assert.ok(pidAlive(other.pid!), "another start time (a reused pid): left alone");
stopAgent({ provider: "claudeAgent", pid: other.pid!, log: "", offset: 0, startedAt: Date.now(), created, resumes: 0 });
await until(() => !pidAlive(other.pid!), "the recorded process stopped");
// A seat the server runs an agent for stays taken, though the agent never called in (a limit before its first
// command) and was handed out long ago: no tournament retry or orchestrator brief hands it out again.
const claim = { id: "gclaim", launched: { w: Date.now() - 11 * 60_000 }, seen: {} } as unknown as Game;
seatKeys["gclaim-w-0a"] = { gameId: "gclaim", role: "w" };
assert.ok(!seatClaimed(claim, "w"), "an orchestrator's seat whose agent never came is free again");
seatKeys["gclaim-w-0a"].agent = { provider: "claudeAgent", pid: 1, log: "", offset: 0, startedAt: Date.now() - 11 * 60_000, resumes: 0 };
assert.ok(seatClaimed(claim, "w"), "one the server runs itself isn't");
delete seatKeys["gclaim-w-0a"];

// A game that's over: a stopped agent's record is forgotten at once, one still running is stopped after a while.
const { watch } = await import("../server/launcher");
const { games } = await import("../server/store");
const player = { provider: "claudeAgent", model: "claude-haiku-5-5", effort: "low" };
const over = { id: "gover", phase: "finished", white: player, black: player, broadcaster: null, seen: {}, directLaunch: { w: { at: Date.now(), relaunches: 0 }, b: { at: Date.now(), relaunches: 0 } } } as unknown as Game;
games.set(over.id, over);
const lingering = startAgent({ ...player, prompt: "Your seat key: gover-w-0b", logName: "unit-over-w" });
await until(() => children().some((c) => c.parent === lingering.pid), "the lingering agent's process of its own");
seatKeys["gover-w-0b"] = { gameId: "gover", role: "w", agent: lingering };
seatKeys["gover-b-0c"] = { gameId: "gover", role: "b", agent: { ...mine } };
// Even with nothing to start agents with any more (both CLIs off, no webhooks), the ones there are looked after.
process.env.CLAUDE_BIN = process.env.CODEX_BIN = "none";
watch();
assert.ok(!seatKeys["gover-b-0c"].agent, "a stopped agent of a finished game is forgotten");
assert.ok(seatKeys["gover-w-0b"].agent && agentAlive(lingering), "a running one gets time to finish up");
const realNow = Date.now;
Date.now = () => realNow() + 11 * 60_000;
try {
  watch();
} finally {
  Date.now = realNow;
}
await until(() => !agentAlive(lingering) && !pidAlive(children().find((c) => c.parent === lingering.pid).pid), "the lingering agent stopped, tree and all");
assert.ok(!seatKeys["gover-w-0b"].agent, "and forgotten");
process.env.CLAUDE_BIN = process.env.CODEX_BIN = FAKE;
games.delete(over.id);
delete seatKeys["gover-w-0b"];
delete seatKeys["gover-b-0c"];
saveSeatsNow();
console.log("PASS: logs read per run (sessions, Claude and Codex usage limits and resets, a limit reported by a CLI still running), bad CLIs refused, agents started on stdin and stopped, tree and all, only when it's surely theirs; their seats stay taken, and a finished game's are cleared away");

/* ------------------------------ a spare server ------------------------------ */

rmSync(path.join(fakeDir, "runs.jsonl"), { force: true });
rmSync(path.join(fakeDir, "children.jsonl"), { force: true });
async function freePort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
// The fake T3 records every call, and refuses the first hand-over of Black (as if T3 were down).
const hits: { path: string; body: any; status: number; at: number }[] = [];
const t3 = createServer((rq, rs) => {
  let body = "";
  rq.on("data", (d) => (body += d));
  rq.on("end", () => {
    const status = rq.url === "/black" && !hits.some((h) => h.path === "/black") ? 503 : 202;
    hits.push({ path: rq.url ?? "", body: JSON.parse(body || "{}"), status, at: Date.now() });
    rs.writeHead(status).end("{}");
  });
});
await new Promise<void>((r) => t3.listen(0, "127.0.0.1", r));
const hook = `http://127.0.0.1:${(t3.address() as net.AddressInfo).port}`;
// Webhooks cover both players too: the CLI is used instead, while it's there.
writeFileSync(path.join(data, "webhook.json"), JSON.stringify({ url: `${hook}/orchestrator`, agents: { "claude-haiku-5-5@low": `${hook}/white`, "gpt-6-luna@low": `${hook}/black` } }));

function start(extra: Record<string, string> = {}) {
  const s = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, PORT: String(port), AGENT_CHESS_DATA: data, PUBLIC_MODE: "0", ENGINE_DEPTH: "1", ENGINE_MAX_MS: "100", MIRROR_URL: "", MIRROR_SECRET: "", T3_USAGE_WATCH: "0", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  s.stdout!.on("data", (d) => (output += d));
  s.stderr!.on("data", (d) => (output += d));
  return s;
}
const up = () => until(async () => { try { return (await fetch(url + "/api/meta")).ok; } catch { return false; } }, "server start");
const exited = (s: ChildProcess) => new Promise<void>((r) => (s.exitCode !== null ? r() : s.once("exit", () => r())));

let server = start();
try {
  await up();
  const token = readFileSync(path.join(data, "admin-token.txt"), "utf8").trim();
  const request = async (p: string, body?: unknown) => {
    const res = await fetch(url + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-admin-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };
  const game = async (id: string): Promise<Game> => request(`/api/games/${id}`);
  const newGame = async () => (await request("/api/games", { white: { model: "claude-haiku-5-5", effort: "low" }, black: { model: "gpt-6-luna", effort: "low" }, broadcaster: { enabled: false } })).game.id as string;
  const seatRuns = (id: string, seat: string) => runs().filter((r) => r.seatId === `${id}-${seat}`);

  // Game 1: White hits a usage limit, then acts once carried on; Black just stops, then keeps running.
  // Game 2: White interviews, then hits its limit and its CLI stays up (with nothing left to do until Black's
  // interview, which never comes); Black only ever says hello and stops.
  const g1 = await newGame();
  const g2 = await newGame();
  control({ [`${g1}-w`]: ["limit", "act"], [`${g1}-b`]: ["exit", "hang"], [`${g2}-w`]: ["act-limit-stay", "hang"], [`${g2}-b`]: ["exit", "exit", "exit", "exit", "hang"] });
  for (const id of [g1, g2]) assert.ok((await request(`/api/games/${id}/summon`, {})).ok);
  await until(() => [g1, g2].every((id) => seatRuns(id, "w").length === 1 && seatRuns(id, "b").length === 1), "all four agents start");
  const [w1] = seatRuns(g1, "w");
  const [b1] = seatRuns(g1, "b");
  assert.equal(w1.argv[0], "-p");
  for (const a of ["--model", "claude-haiku-5-5", "--effort", "low", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--strict-mcp-config"]) assert.ok(w1.argv.includes(a), `claude gets ${a}: ${w1.argv}`);
  assert.equal(b1.argv[0], "exec");
  for (const a of ["--json", "-m", "gpt-6-luna", 'model_reasoning_effort="low"', "--dangerously-bypass-approvals-and-sandbox", "-"]) assert.ok(b1.argv.includes(a), `codex gets ${a}: ${b1.argv}`);
  assert.ok(w1.stdin.includes(`start --key ${w1.key}`) && !/t3_thread|settle/.test(w1.stdin), "the prompt has the key and no T3 steps");
  assert.equal(w1.url, url, "the agent's CLI talks to this server");
  assert.equal(path.resolve(w1.cwd), path.resolve("."), "it runs in the project");
  assert.deepEqual(hits, [], "nothing went through T3");
  const seats = JSON.parse(readFileSync(path.join(data, "seats.json"), "utf8"));
  assert.equal(seats[w1.key]?.agent?.pid, w1.pid, "the seat records its agent's process");
  assert.ok(!JSON.stringify(await game(g1)).includes(String(w1.pid)), "the process isn't in the game's (mirrored) data");
  console.log("PASS: players started in the background through their CLI, with only their key, nothing through T3");

  // Game 1's usage limit pauses White's clock.
  await until(async () => (await game(g1)).clockPause?.code === "usage_limit", "the usage-limit pause", 45);
  const pause = (await game(g1)).clockPause!;
  assert.deepEqual(pause.seats, ["w"]);
  assert.ok(pause.resetAt && Math.abs(pause.resetAt - w1.at - 5000) < 3000, "with when it resets");
  console.log("PASS: a usage limit in the log pauses that player's clock, with its reset time");

  // Game 1's Black stopped without finishing: its session carries on, same key.
  await until(() => seatRuns(g1, "b").length === 2, "Black carried on", 45);
  const b2 = seatRuns(g1, "b")[1];
  assert.deepEqual(b2.argv.slice(0, 3), ["exec", "resume", b1.session], "codex resumes its session");
  assert.equal(b2.key, b1.key, "with the same key");
  assert.match(b2.stdin, /stopped before your task was finished/);
  assert.equal(seatRuns(g1, "w").length, 1, "White waits for its reset");
  console.log("PASS: an agent that stopped early carries its session on, with the same key");

  // Game 1's White carries on once the limit has reset (and a minute), acts, and its clock runs again.
  await until(() => seatRuns(g1, "w").length === 2, "White carried on after its reset", 100);
  const w2 = seatRuns(g1, "w")[1];
  assert.ok(w2.at - w1.at >= 60_000, "not before the reset");
  assert.ok(w2.argv.includes("--resume") && w2.argv[w2.argv.indexOf("--resume") + 1] === w1.session && w2.key === w1.key, "claude resumes its session with the same key");
  await until(async () => !(await game(g1)).clockPause, "the pause lifted once White acted");
  console.log("PASS: a usage-limited agent carries on after the reset, and its clock runs again once it acts");

  // Game 2's White reported its limit with its CLI still up: stopped, its limit waited out, its session carried on.
  // It had already interviewed, so the limit doesn't pause a game it couldn't unpause.
  await until(() => seatRuns(g2, "w").length === 2, "game 2's White carried on after its reset", 30);
  const [g2w1, g2w2] = seatRuns(g2, "w");
  assert.ok(!pidAlive(g2w1.pid), "the CLI that stayed up was stopped");
  assert.ok(g2w2.at - g2w1.at >= 60_000 && g2w2.argv.includes("--resume") && g2w2.key === g2w1.key, "and carried on after the reset, same session and key");
  const g2now = await game(g2);
  assert.equal(g2now.clockPause, undefined, "no pause");
  assert.ok(g2now.usageLimitSeen?.w === undefined, "the limit wasn't applied to the game");
  console.log("PASS: a limit reported by a CLI that stays up is waited out the same way; after the player's pregame part, without pausing the game");

  // Game 2's Black keeps saying hello and stopping: after three runs carried on without acting, a new agent with a new key.
  await until(() => seatRuns(g2, "b").length === 5, "game 2's Black replaced", 90);
  const g2b = seatRuns(g2, "b");
  assert.ok(g2b.slice(1, 4).every((r) => r.key === g2b[0].key && r.session === g2b[0].session), "three runs carry the session on");
  assert.notEqual(g2b[4].key, g2b[0].key, "then a new key");
  assert.ok(!g2b[4].argv.includes("resume") && g2b[4].session !== g2b[0].session, "and a new session");
  console.log("PASS: polling without acting doesn't keep a stopped agent's session going: after three runs a new agent takes the seat");

  // The server crashes: its agents keep running. Both of game 1's stop while it's down, and it comes back with
  // the Codex CLI turned off.
  server.kill("SIGKILL");
  await exited(server);
  await sleep(1000);
  assert.ok(pidAlive(w2.pid) && pidAlive(b2.pid), "agents outlive the server");
  kill(w2.pid);
  kill(b2.pid);
  await until(() => !pidAlive(w2.pid) && !pidAlive(b2.pid), "game 1's agents stopped");
  const before = runs().length;
  server = start({ CODEX_BIN: "none" });
  await up();
  await until(() => seatRuns(g1, "w").length === 3, "White carried on after the restart", 20);
  const w3 = seatRuns(g1, "w")[2];
  assert.ok(w3.argv.includes("--resume") && w3.key === w1.key, "White's session carries on");
  // Black's CLI is off now: its seat goes to T3, which refuses at first. The seat stays the server's until a try goes through.
  await until(() => hits.some((h) => h.path === "/black"), "Black handed to T3", 20);
  assert.equal(JSON.parse(readFileSync(path.join(data, "seats.json"), "utf8"))[b1.key]?.agent?.pid, b2.pid, "a refused hand-over keeps the seat");
  await until(() => hits.filter((h) => h.path === "/black").length === 2, "the hand-over tried again", 80);
  const handed = hits.filter((h) => h.path === "/black");
  assert.ok(handed.every((h) => h.body.key === b1.key), "with the seat's key (its agent has stopped)");
  await until(() => !JSON.parse(readFileSync(path.join(data, "seats.json"), "utf8"))[b1.key]?.agent, "the seat is T3's once it went through");
  const accepted = hits.filter((h) => h.path === "/black")[1];
  assert.ok(((await game(g1)).launched?.b ?? 0) >= accepted.at - 1000, "and claimed afresh, so nothing takes it before T3's agent turns up");
  assert.equal(runs().length, before + 1, "game 2's agents, still running, aren't started again");
  console.log("PASS: agents outlive a server crash; one that stopped meanwhile carries on after it, or goes to T3 (retried until T3 takes it) if its CLI is off now; the rest are left alone");

  for (const id of [g1, g2]) await request(`/api/games/${id}/abort`, {});
} finally {
  for (const r of [...runs(), ...children()]) kill(r.pid);
  if (server.exitCode === null) {
    server.kill();
    await exited(server);
  }
  t3.close();
  await sleep(500);
  rmSync(data, { recursive: true, force: true });
  rmSync(fakeDir, { recursive: true, force: true });
}
process.exit(0);
