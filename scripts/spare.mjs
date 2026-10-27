// A spare Agent Chess server for testing: its own free port and an empty temp data dir, with everything that
// reaches outside turned off (the public mirror, model CLIs, T3's usage watch, voice), so nothing a test does
// shows up on the live site or touches its ratings. Tests import startSpare(); to try things by hand, run
//   node scripts/spare.mjs
// which keeps one up until stopped and prints how to reach it (add --live-copy to start it from a copy of the real games).
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEALED = { PUBLIC_MODE: "0", ENGINE_DEPTH: "1", ENGINE_MAX_MS: "100", MIRROR_URL: "", MIRROR_SECRET: "", T3_USAGE_WATCH: "0", CLAUDE_BIN: "none", CODEX_BIN: "none", ELEVENLABS_API_KEY: "none" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
};

/** A `prepare` that copies the live games, tournaments and ratings into the spare's data dir (they're only read). */
export const copyLiveData = (dir) => {
  const live = path.join(ROOT, "data");
  for (const f of ["games", "tournaments"]) if (existsSync(path.join(live, f))) cpSync(path.join(live, f), path.join(dir, f), { recursive: true });
  for (const f of ["players.json", "players-960.json"]) if (existsSync(path.join(live, f))) cpSync(path.join(live, f), path.join(dir, f));
};

/**
 * Start a spare server. `env` adds to (or overrides) the sealed settings; `prepare(dir)` puts fixtures in its data
 * dir before it starts. The server and its data dir go when this process exits, or at `stop()`.
 */
export async function startSpare({ env = {}, prepare } = {}) {
  const data = mkdtempSync(path.join(tmpdir(), "agent-chess-spare-"));
  await prepare?.(data);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let output = "";
  // One process (no tsx wrapper), so killing it stops the server.
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, ...SEALED, ...env, PORT: String(port), AGENT_CHESS_DATA: data },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (s) => (output += s));
  server.stderr.on("data", (s) => (output += s));
  const cleanUp = () => {
    server.kill();
    try {
      rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  };
  process.on("exit", cleanUp);
  for (let n = 0; ; n++) {
    if (server.exitCode !== null) throw new Error(`The spare server stopped while starting:\n${output}`);
    try {
      if ((await fetch(url + "/api/meta")).ok) break;
    } catch {}
    if (n > 600) throw new Error(`The spare server didn't answer within a minute:\n${output}`);
    await sleep(100);
  }
  const stop = async () => {
    process.off("exit", cleanUp);
    if (server.exitCode === null) await new Promise((r) => (server.once("exit", r), server.kill()));
    cleanUp();
  };
  return { url, data, port, token: readFileSync(path.join(data, "admin-token.txt"), "utf8").trim(), output: () => output, stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // --live-copy: start from a copy of the real games instead of nothing.
  const spare = await startSpare(process.argv.includes("--live-copy") ? { prepare: copyLiveData } : {});
  console.log(`Spare Agent Chess server up (stop it with Ctrl+C; its data goes with it):
  AGENT_CHESS_URL=${spare.url}
  AGENT_CHESS_DATA=${spare.data}
  admin token: ${spare.token}`);
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(signal, () => spare.stop().then(() => process.exit(0)));
}
