#!/usr/bin/env node
// Agent Chess CLI — the only way agents talk to the game server.
// Usage: node chess.mjs <command> [file] --key <seat-key> [--text "..."]
import { readFileSync } from "node:fs";
import { request } from "node:http";

const SERVER = process.env.AGENT_CHESS_URL ?? "http://127.0.0.1:5170";
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  } else positional.push(a);
}

const [cmd0, file] = positional;
const cmd = flags.help ? "help" : cmd0;
const key = flags.key ?? process.env.AGENT_CHESS_KEY;

// Each seat has its own commands: `help --key <your key>` asks the server for yours.
const HELP = `Agent Chess CLI: node chess.mjs <command> [file] --key <your seat key>
Run \`help --key <your seat key>\` to list your commands. A file of "-" reads standard input.`;

if (!cmd || (cmd === "help" && !key)) {
  console.log(HELP);
  process.exit(0);
}
if (!key) {
  console.error("Missing --key <your seat key>.");
  process.exit(2);
}

function readInput() {
  if (typeof flags.text === "string") return flags.text;
  if (!file) {
    console.error(`'${cmd}' needs a file path (or --text "...").`);
    process.exit(2);
  }
  try {
    // "-" is standard input: piped in from a here-string, so a turn needs no file and no separate step.
    return readFileSync(file === "-" ? 0 : file, "utf8").replace(/^﻿/, "");
  } catch (e) {
    console.error(`Could not read ${file === "-" ? "standard input" : file}: ${e.message}`);
    process.exit(2);
  }
}

const body = { key, ...(flags["no-wait"] ? { noWait: true } : {}) };
const JSON_BODY = { move: "turn", direct: "plan", revise: "plan", narrate: "narration", packaging: "packaging", postgame: "postgame" };
if (cmd in JSON_BODY) {
  const raw = readInput();
  try {
    body[JSON_BODY[cmd]] = JSON.parse(raw);
  } catch (e) {
    console.error(`Your ${JSON_BODY[cmd]} JSON is not valid: ${e.message}`);
    process.exit(2);
  }
} else if (["probe", "options", "threat", "board"].includes(cmd)) {
  // The engine questions: where, then moves (or how many options).
  body.args = positional.slice(1);
} else if (["interview", "bind-thread", "request-narration", "log"].includes(cmd)) {
  body.text = readInput().trim();
}

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
const repeatable = ["start", "wait", "status", "brief", "chat-brief", "narrate-brief", "packaging-brief", "help", "probe", "options", "threat", "board"].includes(cmd);
const resume = String(key).startsWith("dt-") ? "chat-brief" : ["direct", "confirm"].includes(cmd) ? "brief" : cmd === "packaging" ? "packaging-brief" : cmd === "narrate" ? "narrate-brief" : "wait";
const lost = `what you sent already went through. Run \`${resume}\`; don't send it again.`;

/** Agents give each command a 6-minute shell timeout: the CLI answers inside it, whatever happens. */
const BUDGET_MS = 350_000;
/** How long a restarting server (a UI build, then its boot) has to come back once it stops answering. */
const RESTART_MS = 120_000;

async function main() {
  let res;
  const startedAt = Date.now();
  // Ride out server restarts: the window opens at the first failure, so a long wait cut off late still gets it.
  let giveUpAt = 0;
  for (;;) {
    try {
      // The server blocks for up to 5 minutes before it answers WAITING.
      res = await post(cmd, body, Math.min(330_000, Math.max(5_000, startedAt + BUDGET_MS - Date.now())));
      break;
    } catch (e) {
      if (e.code === "TIMEOUT") {
        console.log(repeatable ? "WAITING — no response yet. Run the command again." : `WAITING — no response yet, but ${lost}`);
        return;
      }
      // Refused: the server never got the request, so sending it again is safe. Anything else may have
      // dropped after the server acted on it (e.g. a restart mid-wait).
      giveUpAt ||= Date.now() + RESTART_MS;
      if (Date.now() < giveUpAt && (repeatable || e.code === "ECONNREFUSED")) {
        if (Date.now() + 2000 + 5_000 > startedAt + BUDGET_MS) {
          // Out of time for this call, not for the restart: the agent just runs it again.
          console.log(`WAITING — the server is restarting${repeatable ? "" : " and didn't get this"}. Run the command again.`);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!repeatable && e.code !== "ECONNREFUSED") {
        console.log(`WAITING — the connection dropped (${e.message}), but ${lost}`);
        return;
      }
      console.error(`Cannot reach the Agent Chess server at ${SERVER} (${e.message}). Wait a minute and retry.`);
      process.exit(3);
    }
  }
  if (res.status < 200 || res.status >= 300) {
    let msg = res.text;
    try {
      msg = JSON.parse(res.text).error ?? res.text;
    } catch {}
    console.log(`ERROR: ${msg}`);
    process.exit(1);
  }
  console.log(res.text);
}

main();
