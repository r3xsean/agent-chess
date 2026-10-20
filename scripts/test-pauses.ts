// Isolated HTTP server and synthetic T3 database: never changes live games or calls a model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { checkUsageLimits } from "../server/usageLimits";
import { seatKeys } from "../server/store";
import { currentThinkMs } from "../shared/thinkingClock";
import type { Game } from "../shared/types";

const data = mkdtempSync(path.join(tmpdir(), "chess-pauses-"));
const database = path.join(data, "t3.sqlite");
const db = new DatabaseSync(database);
db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, provider_instance_id TEXT, created_at TEXT);
CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT, thread_id TEXT, type TEXT, status TEXT, parent_item_id TEXT, updated_at TEXT, ordinal INTEGER, payload_json TEXT);`);
const socket = net.createServer();
await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
const port = (socket.address() as net.AddressInfo).port;
await new Promise<void>((r) => socket.close(() => r()));
const url = `http://127.0.0.1:${port}`;
let output = "";
const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "server/index.ts"], {
  env: { ...process.env, PORT: String(port), AGENT_CHESS_DATA: data, T3_STATE_DB: database, T3_USAGE_WATCH: "1", PUBLIC_MODE: "0", ENGINE_DEPTH: "1", ENGINE_MAX_MS: "100", MIRROR_URL: "", MIRROR_SECRET: "" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
server.stdout.on("data", (s) => output += s);
server.stderr.on("data", (s) => output += s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, label: string) {
  for (let n = 0; n < 100; n++) { if (await check()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}\n${output}`);
}
let token = "";
const request = async (p: string, body?: unknown, admin = false) => {
  const res = await fetch(url + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(admin ? { "x-admin-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
};
try {
  await until(async () => { try { return (await fetch(url + "/api/meta")).ok; } catch { return false; } }, "server start");
  token = readFileSync(path.join(data, "admin-token.txt"), "utf8").trim();
  const created = (await request("/api/games", {
    white: { model: "claude-sonnet-5-5", effort: "high" },
    black: { model: "gpt-6-astra", effort: "high" },
  }, true)).json();
  const id = created.game.id;
  const keys = Object.fromEntries(created.launch.tasks.map((t: any) => [t.seat, /--key (\S+)/.exec(t.prompt)![1]]));
  const game = async (): Promise<Game> => (await request(`/api/games/${id}`)).json();
  const action = (seat: string, cmd: string, body = {}) => request(`/api/agent/${cmd}`, { key: keys[seat], noWait: true, ...body });
  const clock = (body: unknown, admin = true) => request(`/api/games/${id}/clock`, body, admin);
  assert.equal((await action("w", "interview", { text: "Ready." })).status, 200);
  assert.equal((await action("b", "interview", { text: "Ready." })).status, 200);
  await until(async () => (await game()).phase === "playing", "pregame gate");
  const thread = `thread:delegated-task:command%3Amcp%3Atest%3Adelegate-task%3A${id}-w`;
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)").run(thread, "claudeAgent", new Date(created.game.createdAt).toISOString());
  const fail = (eventId: string, at: number, classification = "usage_limit", threadId = thread) => {
    const time = new Date(at).toISOString();
    db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, 'error', 'failed', NULL, ?, ?, ?)").run(eventId, threadId, time, at,
      JSON.stringify({ completedAt: time, failure: { class: classification, code: "api_error_429", resetAt: new Date(at + 7_200_000).toISOString() } }));
  };
  await sleep(25);
  const stoppedAt = Date.now();
  fail("failure-1", stoppedAt);
  await until(async () => !!(await game()).clockPause, "automatic T3 detection");
  const paused = await game();
  assert.equal(paused.clockPause?.at, stoppedAt);
  assert.equal(paused.clockPause?.reason, "Claude usage limit reached");
  assert.deepEqual(paused.clockPause?.seats, ["w"]);
  const frozen = currentThinkMs(paused, stoppedAt + 7_200_000);
  assert.ok(frozen >= 0 && frozen < 1000);
  const lobby = (await request("/api/lobby")).json();
  assert.equal(lobby.games.find((g: Game) => g.id === id).clockPause.reason, "Claude usage limit reached");
  assert.equal((await request(`/api/games/${id}/agents`)).json().clockPause.code, "usage_limit");
  await action("w", "status");
  await request("/api/agent/wait", { key: keys.w }); // on-turn wait returns immediately
  assert.ok((await game()).clockPause, "status/wait do not resume");
  assert.equal((await action("b", "move", { turn: { move: "e5", commentary: "Move", eval: "0" } })).status, 400);
  assert.equal((await action("w", "move", { turn: { move: "e4" } })).status, 400);
  assert.ok((await game()).clockPause, "wrong seat and malformed moves do not resume");
  assert.equal((await action("w", "move", { turn: { move: "e4", commentary: "Take the center.", eval: "0" } })).status, 200);
  const resumed = await game();
  assert.equal(resumed.clockPause, undefined);
  assert.equal(resumed.moves[0].thinkMs, frozen, "saved move excludes outage until action arrives");
  let persisted = 0;
  const restored = JSON.parse(JSON.stringify(resumed));
  checkUsageLimits([restored], database, () => persisted++);
  assert.equal(restored.clockPause, undefined, "restart cannot reapply an acknowledged failure");
  // A late-arriving failure from before the action is consumed without pausing.
  fail("late-old-failure", stoppedAt + 1);
  checkUsageLimits([restored], database, () => persisted++);
  assert.equal(restored.clockPause, undefined);
  assert.equal(persisted, 1);
  assert.equal((await clock({ action: "pause", reason: "Maintenance" }, false)).status, 400);
  await clock({ action: "pause", code: "maintenance", reason: "Updating the board service" });
  assert.equal((await action("b", "move", { turn: { move: "e5", commentary: "Center.", eval: "0" } })).status, 400);
  assert.equal((await game()).clockPause?.reason, "Updating the board service");
  await clock({ action: "resume" });
  // Both seats need to recover; one player's action cannot clear the other's blocker.
  await clock({ action: "pause", code: "usage_limit", reason: "Model usage limits reached", seats: ["w", "b"] });
  assert.equal((await action("b", "move", { turn: { move: "e5", commentary: "Center.", eval: "0" } })).status, 200);
  assert.deepEqual((await game()).clockPause?.seats, ["w"]);
  assert.equal(currentThinkMs(await game()), 0, "the next turn remains frozen");
  assert.equal((await action("w", "move", { turn: { move: "Nf3", commentary: "Develop.", eval: "0" } })).status, 200);
  assert.equal((await game()).clockPause, undefined);
  const detached = await game();
  await sleep(25);
  fail("network-error", Date.now(), "network");
  checkUsageLimits([detached], database, () => {});
  assert.equal(detached.clockPause, undefined, "other provider failures are not usage exhaustion");
  const unrelated = `${thread}-other`;
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)").run(unrelated, "claudeAgent", new Date().toISOString());
  fail("unrelated-error", Date.now(), "usage_limit", unrelated);
  checkUsageLimits([detached], database, () => {});
  assert.equal(detached.clockPause, undefined, "matching substrings cannot associate another task");
  // A seat the server started in its own thread is found by the webhook delivery that started it.
  const direct = JSON.parse(JSON.stringify(detached));
  direct.directLaunch = { b: { at: Date.now(), relaunches: 0 } };
  seatKeys["direct-b-key"] = { gameId: id, role: "b", delivery: "delivery:relay:test-delivery-1" };
  const own = "thread:project:test:direct-run-1";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)").run(own, "codex", new Date().toISOString());
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, 'user_message', 'completed', NULL, ?, 0, '{}')")
    .run("turn-item:message:scheduled-task-message%3Awebhook%3Adelivery%3Arelay%3Atest-delivery-1", own, new Date().toISOString());
  await sleep(25);
  fail("direct-usage", Date.now(), "usage_limit", own);
  checkUsageLimits([direct], database, () => {});
  assert.deepEqual(direct.clockPause?.seats, ["b"], "a directly launched seat's usage limit pauses it");
  const illegal = { turn: { move: "a1a8", commentary: "A rejected attempt.", eval: "0" } };
  assert.equal((await action("b", "move", illegal)).status, 400);
  assert.equal((await action("b", "move", { turn: { move: "h1h8", commentary: "Another rejected attempt.", eval: "0" } })).status, 400);
  await clock({ action: "pause", code: "usage_limit", reason: "Codex usage limit reached", seats: ["b"] });
  const beforeRetry = await game();
  assert.equal((await action("b", "move", illegal)).status, 400);
  const afterRetry = await game();
  assert.ok(afterRetry.clockPause, "a replayed illegal attempt cannot resume");
  assert.equal(afterRetry.pendingTries?.b.length, beforeRetry.pendingTries?.b.length, "replay cannot duplicate attempts");
  assert.equal((await action("b", "move", { turn: { move: "Nc6", commentary: "Develop.", eval: "0" } })).status, 200);
  assert.equal((await game()).clockPause, undefined);
  await clock({ action: "pause", code: "usage_limit", reason: "Model usage limits reached", seats: ["w", "b"] });
  assert.equal((await action("b", "resign")).status, 200);
  const postgame = await game();
  assert.equal(postgame.phase, "postgame");
  assert.deepEqual(postgame.clockPause?.seats, ["w"], "game result preserves the other player's unresolved blocker");
  assert.equal((await action("w", "interview", { text: "Thanks for the game." })).status, 200);
  assert.equal((await game()).clockPause, undefined, "postgame action clears the remaining blocker");
  console.log("PASS: automatic T3 pause, Watch metadata, frozen move timing, action-only recovery, multiple seats, manual reasons, authorization, stale/restarted/unrelated errors");
  console.log("PASS: duplicate illegal attempts cannot resume; unrecovered blockers survive game results");
} finally {
  server.kill("SIGTERM");
  await new Promise<void>((r) => { if (server.exitCode !== null) r(); else server.once("close", () => r()); });
  db.close();
  rmSync(data, { recursive: true, force: true });
}
