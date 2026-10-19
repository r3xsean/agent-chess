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
const { openDirectorThread, directorThreadState, directorThreadBusy, directorThreadCommand } = await import("../server/directorThread");
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
assert.ok(task.task.includes("separate narration agent"));
const narratorKey = /--key (dt-[a-f0-9]+)/.exec(task.task)![1];
assert.notEqual(narratorKey, key);
assert.equal(directorThreadState(g).status, "narrating");
await assert.rejects(directorThreadCommand(key, "revise", { plan: {} }), /narration agent is working/);
await directorThreadCommand(narratorKey, "narrate", { narration: { lines: [{ ply: 53, end: 3, beats: [
  { at: "start", text: "Rewind. Knight takes f5.", enter: "Rewind", cues: [{ words: "Knight", moves: 1 }] },
] }] } });
assert.equal(g.video!.moments[0].line!.beats![0].text, "Rewind. Knight takes f5.");
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

const failed = structuredClone(g); failed.id = "director-failure"; games.set(failed.id, failed);
await openDirectorThread(failed, {}, async () => { throw new Error("offline"); });
assert.equal(directorThreadState(failed).status, "failed");
await openDirectorThread(failed, { retry: true }, async () => {});
assert.equal(directorThreadState(failed).status, "opening");
console.log("Director workflow passed: thread reuse, private credentials, draft preservation, delegated narration, stale edits, approval/render gate, desktop links and launch retry.");
