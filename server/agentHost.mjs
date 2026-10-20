// Runs an agent's CLI for the server on Windows (server/agents.ts): node agentHost.mjs <cmd> [args...].
// The server starts this detached, so it outlives a restart, but a detached process has no console, and every
// console program it started (an agent's shell, git, node) would open a window of its own. So this starts the
// CLI in a console of its own that has no window, which everything the CLI starts shares. Its stdin goes to the
// CLI, the CLI's output comes back out on this one's (the agent's log), and it exits when the CLI does, with its code.
// It says on fd 3 whether the CLI started ("started", or "error: <why>"), then closes it.
import { spawn } from "node:child_process";
import { closeSync, writeSync } from "node:fs";

const tell = (s) => {
  try {
    writeSync(3, s);
    closeSync(3);
  } catch {}
};
const failed = (e) => {
  console.error(`[agent host] couldn't start ${cmd}: ${e.message}`);
  tell(`error: ${e.message}`);
  process.exit(1);
};
const [cmd, ...args] = process.argv.slice(2);
let child;
try {
  // All three piped and windowsHide: that's when Node gives it a console with no window.
  child = spawn(cmd, args, { stdio: "pipe", windowsHide: true });
} catch (e) {
  failed(e);
}
child.on("spawn", () => tell("started"));
child.on("error", failed);
child.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("close", (code) => process.exit(code ?? 1));
// Something the CLI started may hold its output open after it's gone: what's left of that is waited for only briefly.
child.on("exit", (code) => setTimeout(() => process.exit(code ?? 1), 5000));
