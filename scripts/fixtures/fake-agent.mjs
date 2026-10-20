// A stand-in for the claude and codex CLIs in tests (set as CLAUDE_BIN / CODEX_BIN). It records how it was
// started in $FAKE_AGENT_DIR/runs.jsonl, prints the session line the real CLI would, says hello to the server
// with its key (`help`, which acts on nothing), then does its next step from $FAKE_AGENT_DIR/control.json
// ({ "<game>-<seat>": [steps] }, one per run of that seat):
//   "exit"            stop at once
//   "limit"           hit a usage limit that resets in 5 s, and stop
//   "act-limit-stay"  give the pregame interview, hit the limit, and keep running (a CLI that doesn't stop at one)
//   "act"             give the pregame interview, then keep running
//   "hang"            (or no step left) keep running
// A run that keeps running starts a process of its own too (its pid in children.jsonl), as a real CLI's shell would.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const argv = process.argv.slice(2);
const codex = argv[0] === "exec";
const resumed = codex ? (argv[1] === "resume" ? argv[2] : undefined) : argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : undefined;
const stdin = readFileSync(0, "utf8");
const key = /--key (\S+)/.exec(stdin)?.[1] ?? "";
const seatId = key.replace(/-[0-9a-f]+$/, "");
const seat = seatId.split("-").at(-1);
const dir = process.env.FAKE_AGENT_DIR;
const url = process.env.AGENT_CHESS_URL;
const runsFile = path.join(dir, "runs.jsonl");
const earlier = existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.seatId === seatId).length : 0;
const session = resumed ?? randomUUID();
appendFileSync(runsFile, JSON.stringify({ pid: process.pid, argv, stdin, cwd: process.cwd(), url, seat, seatId, key, session, at: Date.now() }) + "\n");
const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
out(codex ? { type: "thread.started", thread_id: session } : { type: "system", subtype: "init", session_id: session });

const call = (cmd, body = {}) => fetch(`${url}/api/agent/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, noWait: true, ...body }) }).catch(() => {});
await call("help");

const control = existsSync(path.join(dir, "control.json")) ? JSON.parse(readFileSync(path.join(dir, "control.json"), "utf8")) : {};
const step = control[seatId]?.[earlier] ?? "hang";
if (step === "exit") {
  out(codex ? { type: "turn.completed" } : { type: "result", subtype: "success", is_error: false, result: "Waiting for my opponent." });
  process.exit(0);
}
if (step.startsWith("act")) await call("interview", { text: "Ready." });
if (step.includes("limit")) {
  const reset = Date.now() + 5000;
  if (codex) out({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 5 seconds." } });
  else {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.ceil(reset / 1000), rateLimitType: "five_hour", overageStatus: "rejected" } });
    out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your limit" });
  }
  if (!step.endsWith("stay")) process.exit(1);
}
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
appendFileSync(path.join(dir, "children.jsonl"), JSON.stringify({ parent: process.pid, pid: child.pid, seatId }) + "\n");
setInterval(() => {}, 60_000);
