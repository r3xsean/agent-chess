// Kills a spare server mid-turn and starts it again: the downtime isn't thinking, quiet-looking agents aren't
// replaced, a waiting CLI rides it out, and what was cut off (a render, a publish, a director's summon, a
// tournament's finish) carries on. Then the admin shutdown. Its own port, data and fake T3: never the live server.
//   npx tsx scripts/test-restart.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import type { Game } from "../shared/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const data = mkdtempSync(path.join(tmpdir(), "chess-restart-"));
const publicData = mkdtempSync(path.join(tmpdir(), "chess-restart-public-"));
const port = await freePort();
const url = `http://127.0.0.1:${port}`;

// The fake T3: every webhook call it gets.
const hits: { path: string; body: any; at: number }[] = [];
const t3 = createServer((rq, rs) => {
  let body = "";
  rq.on("data", (d) => (body += d));
  rq.on("end", () => {
    hits.push({ path: rq.url ?? "", body: JSON.parse(body || "{}"), at: Date.now() });
    rs.writeHead(202).end("{}");
  });
});
await new Promise<void>((r) => t3.listen(0, "127.0.0.1", r));
const hook = `http://127.0.0.1:${(t3.address() as net.AddressInfo).port}`;
writeFileSync(path.join(data, "webhook.json"), JSON.stringify({ url: `${hook}/orchestrator`, agents: { "claude-haiku-5-5@low": `${hook}/white`, "gpt-6-luna@low": `${hook}/black` } }));

let output = "";
// The agents start through the fake T3, never a real CLI (test-agents.ts covers those).
const env = (extra: Record<string, string>) => ({ ...process.env, PUBLIC_MODE: "0", ENGINE_DEPTH: "1", ENGINE_MAX_MS: "100", MIRROR_URL: "", MIRROR_SECRET: "", T3_USAGE_WATCH: "0", CLAUDE_BIN: "none", CODEX_BIN: "none", ...extra });
/** One process (no tsx wrapper), so killing it is a real crash: nothing gets flushed. */
function start(dir = data, p = port, extra: Record<string, string> = {}) {
  const s = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { env: env({ PORT: String(p), AGENT_CHESS_DATA: dir, ...extra }), stdio: ["ignore", "pipe", "pipe"] });
  s.stdout!.on("data", (d) => (output += d));
  s.stderr!.on("data", (d) => (output += d));
  return s;
}
async function until(check: () => Promise<boolean> | boolean, label: string, tries = 300) {
  for (let n = 0; n < tries; n++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}\n${output}`);
}
const up = (u = url) => until(async () => { try { return (await fetch(u + "/api/meta")).ok; } catch { return false; } }, "server start");
const exited = (s: ChildProcess) => new Promise<void>((r) => (s.exitCode !== null ? r() : s.once("exit", () => r())));

let server = start();
let token = "";
const request = async (p: string, body?: unknown, admin = true, base = url) => {
  const res = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(admin ? { "x-admin-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
};
const gameFile = (id: string) => path.join(data, "games", `${id}.json`);
const editGame = (id: string, fn: (g: Game) => void) => {
  const g = JSON.parse(readFileSync(gameFile(id), "utf8"));
  fn(g);
  writeFileSync(gameFile(id), JSON.stringify(g));
};
let waiter: ChildProcess | undefined;

try {
  await up();
  token = readFileSync(path.join(data, "admin-token.txt"), "utf8").trim();
  const newGame = async () => {
    const created = (await request("/api/games", { white: { model: "claude-haiku-5-5", effort: "low" }, black: { model: "gpt-6-luna", effort: "low" } })).json();
    const keys: Record<string, string> = Object.fromEntries(created.launch.tasks.map((t: any) => [t.seat, /--key (\S+)/.exec(t.prompt)![1]]));
    const act = (seat: string, cmd: string, body = {}) => request(`/api/agent/${cmd}`, { key: keys[seat], noWait: true, ...body }, false);
    const game = async (): Promise<Game> => (await request(`/api/games/${created.game.id}`)).json();
    assert.equal((await act("w", "interview", { text: "Ready." })).status, 200);
    assert.equal((await act("b", "interview", { text: "Ready." })).status, 200);
    await until(async () => (await game()).phase === "playing", "pregame gate");
    return { id: created.game.id as string, keys, act, game };
  };

  // A second game, over and reviewed: it gets a publish request, a director's summon and a tournament below.
  const done = await newGame();
  assert.equal((await done.act("w", "move", { turn: { move: "e4", commentary: "Centre.", eval: "0.3" } })).status, 200);
  assert.equal((await done.act("b", "resign")).status, 200);
  await until(async () => !!(await done.game()).review, "the engine review");

  // The game under test: both agents started by the server in their own threads, White to move.
  const live = await newGame();
  assert.equal((await request(`/api/games/${live.id}/summon`, {})).status, 200);
  await until(() => hits.filter((h) => h.path === "/white" || h.path === "/black").length === 2, "direct launches");
  const turnStart = (await live.game()).turnStartedAt!;

  // Black waits through the restart, the way a real agent would.
  let waited = "";
  waiter = spawn(process.execPath, ["cli/chess.mjs", "wait", "--key", live.keys.b], { env: { ...process.env, AGENT_CHESS_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
  waiter.stdout!.on("data", (d) => (waited += d));
  const waiterDone = exited(waiter);
  await sleep(1500);

  // Crash right after a heartbeat, so the server's last sign of life is the moment it went down.
  const beatFile = path.join(data, "heartbeat.json");
  const lastBeat = JSON.parse(readFileSync(beatFile, "utf8")).at;
  await until(() => JSON.parse(readFileSync(beatFile, "utf8")).at !== lastBeat, "a heartbeat", 100);
  server.kill("SIGKILL");
  await exited(server);
  const downAt = Date.now();
  const launchesBefore = hits.length;

  // While it's down: both agents look long silent on disk; a render, a publish and a director's summon were cut
  // off; a tournament's finish never reached disk.
  const hourAgo = Date.now() - 3_600_000;
  editGame(live.id, (g) => {
    g.seen = { w: hourAgo, b: hourAgo };
    g.directLaunch = { w: { at: hourAgo - 600_000, relaunches: 0 }, b: { at: hourAgo - 600_000, relaunches: 0 } };
  });
  editGame(done.id, (g) => {
    g.phase = "finished";
    g.finishedAt = Date.now() - 20 * 60_000;
    g.directorSummonedAt = Date.now() - 20 * 60_000;
    g.publish = { platforms: ["youtube"], visibility: "test", status: "requested", requestedAt: Date.now() - 60_000, attempt: 1, posts: {} };
  });
  writeFileSync(path.join(data, "render-jobs.json"), JSON.stringify([{ id: "job-1", gameId: live.id, formats: ["landscape"], music: null, voices: false, revision: "r", status: "rendering", stage: "Rendering the YouTube video", progress: 40, createdAt: Date.now() }]));
  writeFileSync(path.join(data, "tournaments", "tcut.json"), JSON.stringify({ id: "tcut", name: "Cut off", createdAt: Date.now(), players: [], pairings: [{ round: 1, white: "a", black: "b", gameId: done.id }], status: "running" }));
  await sleep(10_000);

  server = start();
  await up();
  const downMs = Date.now() - downAt;
  const job = (await request(`/api/games/${live.id}/render`)).json().jobs[0];
  assert.equal(job?.status, "queued", "a render cut off is queued again");
  assert.match(job.stage, /restarted/);
  assert.equal((await request("/api/tournaments/tcut")).json().tournament.status, "finished", "a tournament whose games all ended is finished at boot");

  // A watch tick or two: neither agent is replaced, though both look an hour quiet on disk.
  await sleep(7_000);
  const after = hits.slice(launchesBefore);
  assert.ok(!after.some((h) => h.path === "/white" || h.path === "/black"), `no agent relaunched: ${JSON.stringify(after)}`);
  assert.ok(after.some((h) => h.body.action === "publish" && h.body.gameId === done.id), "a publish never handed out is summoned again");
  assert.ok(after.some((h) => h.body.action === "direct-video" && h.body.gameId === done.id), "a director that never turned up is summoned again");
  const rerun = (await request(`/api/games/${live.id}/render`)).json().jobs[0];
  assert.equal(rerun.status, "failed", "the queued render ran again (and stopped: this game has no approved plan)");
  assert.equal(rerun.stage, "Plan changed");

  // White moves: its thinking leaves out the time the server was down.
  const moved = Date.now();
  assert.equal((await live.act("w", "move", { turn: { move: "d4", commentary: "Centre.", eval: "0.2" } })).status, 200);
  const think = (await live.game()).moves[0].thinkMs;
  const wall = moved - turnStart;
  // (What counts is the time from the boot to the server answering, a second or two.)
  assert.ok(think <= wall - downMs + 3000 && think > 0, `thinking ${think} ms of ${wall} ms, ${downMs} ms of it down\n${output}`);

  // Black's CLI wait rode out the restart and got its move.
  await waiterDone;
  assert.match(waited, /YOUR MOVE/, `the waiting CLI got its turn: ${waited}`);

  // The admin shutdown: the token is required, then everything is saved and the server goes.
  assert.equal((await request("/api/admin/shutdown", {}, false)).status, 400);
  const askedAt = Date.now();
  assert.equal((await request("/api/admin/shutdown", {})).status, 200);
  await exited(server);
  assert.ok(JSON.parse(readFileSync(beatFile, "utf8")).at >= askedAt, "the last heartbeat is written on the way out");

  // The public site never offers it.
  const publicPort = await freePort();
  const pub = start(publicData, publicPort, { PUBLIC_MODE: "1" });
  try {
    await up(`http://127.0.0.1:${publicPort}`);
    token = readFileSync(path.join(publicData, "admin-token.txt"), "utf8").trim();
    assert.equal((await request("/api/admin/shutdown", {}, true, `http://127.0.0.1:${publicPort}`)).status, 403, "no shutdown on the public site");
  } finally {
    pub.kill();
    await exited(pub);
  }

  console.log(`PASS: ${Math.round(downMs / 1000)} s of downtime left out of thinking; no live agent replaced; a waiting CLI rode it out`);
  console.log("PASS: a cut-off render queued again, a publish and a director summoned again, a tournament finished at boot; admin shutdown saves and is local only");
} finally {
  waiter?.kill();
  if (server.exitCode === null) {
    server.kill();
    await exited(server);
  }
  t3.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(publicData, { recursive: true, force: true });
}
