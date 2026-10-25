// How an agent's command reaches the game server: the CLI (chess.mjs) and the chess MCP server (chess-mcp.mjs) both
// call it, so they ride out restarts and timeouts the same way.
import { request } from "node:http";

export const SERVER = process.env.AGENT_CHESS_URL ?? "http://127.0.0.1:5170";

/**
 * POST to the server. Plain node:http, not fetch: fetch gives up on response headers after 300 s,
 * and the server can block for 5 minutes.
 */
function post(cmdName, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = request(
      `${SERVER}/api/agent/${encodeURIComponent(cmdName)}`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode, text }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timed out"), { code: "TIMEOUT" })));
    req.on("error", reject);
    req.end(data);
  });
}

// Waiting (and showing the position) is safe to repeat; anything that acts may already have gone through.
const REPEATABLE = ["start", "wait", "status", "brief", "chat-brief", "narrate-brief", "packaging-brief", "help", "probe", "options", "threat", "board"];

/** The command that picks up where a lost call left off, for each kind of seat. */
const resumeFor = (cmd, key) =>
  String(key).startsWith("dt-") ? "chat-brief" : String(key).startsWith("pb-") ? "start" : ["direct", "confirm"].includes(cmd) ? "brief" : cmd === "packaging" ? "packaging-brief" : cmd === "narrate" ? "narrate-brief" : "wait";

/** Agents give each command a 6-minute timeout: the call answers inside it, whatever happens. */
const BUDGET_MS = 350_000;
/** How long a restarting server (a UI build, then its boot) has to come back once it stops answering. */
const RESTART_MS = 120_000;

/**
 * Send one command. `kind`: "ok" (the server's answer), "error" (it refused, with why), "waiting" (no answer in
 * time: what to do next), or "unreachable".
 */
export async function callServer(cmd, body) {
  const repeatable = REPEATABLE.includes(cmd);
  const lost = `what you sent already went through. Run \`${resumeFor(cmd, body.key)}\`; don't send it again.`;
  const startedAt = Date.now();
  // Ride out server restarts: the window opens at the first failure, so a long wait cut off late still gets it.
  let giveUpAt = 0;
  let res;
  for (;;) {
    try {
      // The server blocks for up to 5 minutes before it answers WAITING.
      res = await post(cmd, body, Math.min(330_000, Math.max(5_000, startedAt + BUDGET_MS - Date.now())));
      break;
    } catch (e) {
      if (e.code === "TIMEOUT") return { kind: "waiting", text: repeatable ? "WAITING — no response yet. Run the command again." : `WAITING — no response yet, but ${lost}` };
      // Refused: the server never got the request, so sending it again is safe. Anything else may have
      // dropped after the server acted on it (e.g. a restart mid-wait).
      giveUpAt ||= Date.now() + RESTART_MS;
      if (Date.now() < giveUpAt && (repeatable || e.code === "ECONNREFUSED")) {
        if (Date.now() + 2000 + 5_000 > startedAt + BUDGET_MS) {
          // Out of time for this call, not for the restart: the agent just runs it again.
          return { kind: "waiting", text: `WAITING — the server is restarting${repeatable ? "" : " and didn't get this"}. Run the command again.` };
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!repeatable && e.code !== "ECONNREFUSED") return { kind: "waiting", text: `WAITING — the connection dropped (${e.message}), but ${lost}` };
      return { kind: "unreachable", text: `Cannot reach the Agent Chess server at ${SERVER} (${e.message}). Wait a minute and retry.` };
    }
  }
  if (res.status < 200 || res.status >= 300) {
    let msg = res.text;
    try {
      msg = JSON.parse(res.text).error ?? res.text;
    } catch {}
    return { kind: "error", text: `ERROR: ${msg}` };
  }
  return { kind: "ok", text: res.text };
}
