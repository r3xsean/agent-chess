// Run: npx tsx scripts/test-director-thread.ts. Uses isolated data and a fake launcher; no live agents or voices.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Game } from "../shared/types";

const dir = mkdtempSync(path.join(tmpdir(), "chess-director-test-"));
process.env.AGENT_CHESS_DATA = dir;
process.env.T3_STATE_DB = path.join(dir, "t3.sqlite");
const { games } = await import("../server/store");
const { openDirectorThread, autoDirectorSession, directorThreadState, directorThreadBusy, directorThreadCommand } = await import("../server/directorThread");
const { videoApproved, videoRevision } = await import("../server/videoApproval");
const { startRender, jobsFor } = await import("../server/render");
const { desktopThreadUrl, findDirectorThread } = await import("../server/directorThreadLink");
const g: Game = JSON.parse(readFileSync(new URL("./fixtures/director-game.json", import.meta.url), "utf8"));
games.set(g.id, g);
let calls = 0, key = "";
const fakeLaunch = async (s: { key: string }) => { calls++; key = s.key; };
await Promise.all([openDirectorThread(g, {}, fakeLaunch), openDirectorThread(g, {}, fakeLaunch)]);
assert.equal(calls, 1, "opening twice must not launch twice");
assert.ok(!JSON.stringify(directorThreadState(g)).includes(key), "credentials stay out of UI state");
await directorThreadCommand(key, "bind-thread", { text: "thread:director/test" });
await directorThreadCommand(key, "chat-brief", {});
assert.equal(directorThreadState(g).status, "ready");
await openDirectorThread(g, {}, fakeLaunch);
assert.equal(calls, 1, "reopening reuses the same T3 conversation");
await assert.rejects(startRender(g.id, ["landscape"], null), /Approve/);
assert.equal(jobsFor(g.id).length, 0, "unapproved plans never queue or record");
g.videoApproval = { revision: videoRevision(g), at: Date.now() };
assert.ok(videoApproved(g));
const before = structuredClone(g.video!);
await directorThreadCommand(key, "revise", { plan: { moments: [{ ply: 53, chapter: "Watch the knight" }] } });
assert.deepEqual(g.video, before, "revising checks a draft before saving");
assert.ok(directorThreadBusy(g));
await directorThreadCommand(key, "confirm", {});
assert.equal(g.video!.moments[0].chapter, "Watch the knight");
assert.deepEqual(g.video!.moments[0].line, before.moments[0].line, "unrelated narration/cues survive edits");
assert.deepEqual(g.video!.moments.slice(1), before.moments.slice(1));
assert.ok(!videoApproved(g), "saving edits invalidates the exact-plan approval");
await assert.rejects(directorThreadCommand(key, "narrate", { narration: { lines: [] } }), /separate narrator/);
await assert.rejects(directorThreadCommand(key, "revise", { plan: { moments: [{ ply: 53, line: { beats: [] } }] } }), /request-narration/);

const task = JSON.parse(await directorThreadCommand(key, "request-narration", { text: "Shorten only ply 53's explanation; preserve its rewind cue." }));
assert.ok(task.task.includes("narrator") && task.task.includes("REQUESTS:"), "the narrator works in rounds with its director");
const narratorKey = /--key (dt-[a-f0-9]+)/.exec(task.task)![1];
assert.notEqual(narratorKey, key);
assert.equal(directorThreadState(g).status, "narrating");
await assert.rejects(directorThreadCommand(key, "request-narration", { text: "again" }), /still at work/, "one narrator at a time");
await directorThreadCommand(narratorKey, "narrate", { narration: { lines: [{ ply: 53, end: 3, beats: [
  { at: "start", text: "Rewind. Knight takes f5.", enter: "Rewind", cues: [{ words: "Knight", moves: 1 }] },
] }] } });
assert.equal(g.video!.moments[0].line!.beats![0].text, "Rewind. Knight takes f5.");
// The narrator asks, the director agrees and changes the plan between its turns; the narrator then has to re-read it.
await directorThreadCommand(narratorKey, "log", { text: "REQUESTS: retitle ply 53's chapter" });
await directorThreadCommand(key, "chat-brief", {});
await directorThreadCommand(key, "revise", { plan: { moments: [{ ply: 53, chapter: "The knight's jump" }] } });
await directorThreadCommand(key, "confirm", {});
await directorThreadCommand(key, "log", { text: "Agreed: retitled." });
await assert.rejects(directorThreadCommand(narratorKey, "narrate", { narration: { lines: [] } }), /changed the plan/, "a narration against the old plan is refused");
assert.match(await directorThreadCommand(key, "chat-brief", {}), /\[narrator\] REQUESTS: retitle[\s\S]*\[director\] Agreed/, "the exchange is kept, round by round");
await assert.rejects(directorThreadCommand(key, "done", {}), /Wait for the narration agent/, "the director finishes after its narrator");
await directorThreadCommand(narratorKey, "done", {});
await directorThreadCommand(key, "done", {});
assert.equal(directorThreadState(g).status, "ready");
await assert.rejects(directorThreadCommand(narratorKey, "narrate", {}), /no longer active/);
await assert.rejects(directorThreadCommand(key, "revise", { plan: {} }, () => true), /rendering/);

await directorThreadCommand(key, "revise", { plan: { moments: [{ ply: 53, chapter: "Another draft" }] } });
g.video!.moments[0].chapter = "External change";
await assert.rejects(directorThreadCommand(key, "confirm", {}), /plan changed/);
assert.equal(g.video!.moments[0].chapter, "External change");
await directorThreadCommand(key, "discard-draft", {});
await directorThreadCommand(key, "chat-brief", {});
await directorThreadCommand(key, "done", {});

// T3's desktop URL and webhook-to-thread binding, using a temporary read-only database adapter.
writeFileSync(path.join(dir, "environment-id"), "environment:test");
const db = new DatabaseSync(process.env.T3_STATE_DB!);
db.exec(`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, created_at TEXT);
 CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT, type TEXT, ordinal INTEGER, turn_item_id TEXT, payload_json TEXT);`);
const at = Date.now();
db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)").run("thread:one/test", new Date(at).toISOString());
db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?)").run("thread:one/test", "user_message", 1, "message:delivery-123", JSON.stringify({ text: "Run start with a dedicated-key" }));
db.close();
assert.equal(findDirectorThread("dedicated-key", at), "thread:one/test");
assert.equal(findDirectorThread("different-key", at, "delivery:relay:delivery-123"), "thread:one/test");
assert.equal(findDirectorThread("different-key", at), undefined);
assert.equal(desktopThreadUrl("thread:one/test"), "t3code://threads/environment%3Atest/thread%3Aone%2Ftest");

// The auto director's own thread becomes the user's conversation once it's done: no new launch, same key.
const auto = structuredClone(g); auto.id = "director-auto"; games.set(auto.id, auto);
const as = autoDirectorSession(auto)!;
await directorThreadCommand(as.key, "bind-thread", { text: "thread:auto/test" });
await assert.rejects(openDirectorThread(auto, {}, fakeLaunch), /still at work/);
await directorThreadCommand(as.key, "done", {});
const opened = await openDirectorThread(auto, { context: { time: 12, format: "landscape" } }, fakeLaunch);
assert.equal(calls, 1, "talking reuses the auto director's thread");
assert.equal(opened.threadUrl, desktopThreadUrl("thread:auto/test"));
assert.match(await directorThreadCommand(as.key, "chat-brief", {}), /"time":12/, "the playback position reaches the same thread");
assert.match(await directorThreadCommand(as.key, "done", {}), /Reply in T3 Code/);

const failed = structuredClone(g); failed.id = "director-failure"; games.set(failed.id, failed);
await openDirectorThread(failed, {}, async () => { throw new Error("offline"); });
assert.equal(directorThreadState(failed).status, "failed");
await openDirectorThread(failed, { retry: true }, async () => {});
assert.equal(directorThreadState(failed).status, "opening");
console.log("Director workflow passed: thread reuse, private credentials, draft preservation, the director-narrator rounds, stale edits, approval/render gate, desktop links, the auto director's thread reused for talking, and launch retry.");
