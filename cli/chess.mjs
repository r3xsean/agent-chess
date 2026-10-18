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

const [cmd, file] = positional;
const key = flags.key ?? process.env.AGENT_CHESS_KEY;

const HELP = `Agent Chess CLI
  wait                     block until it's your turn / something to do
  status                   print the current position
  move <turn.json>         submit a move (JSON: move, commentary, eval, lines, offerDraw)
  accept-draw              accept the opponent's draw offer
  resign                   resign the game
  interview <file.txt>     answer the interview (or --text "...")
  postgame <file.json>     after the game: interview, journal and lessons at once (JSON)
  journal <file.txt>       write your post-game journal entry (or --text "...")
  lessons <file.txt>       rewrite your lessons playbook after the game (or --text "...")
  bc-wait                  (broadcaster) wait for new events
  say <file.txt>           (broadcaster) speak a segment (or --text "...")
  direct <plan.json>       (broadcaster) submit the video director's plan after the game; it's read back to you
  confirm                  (broadcaster) save the plan once its readback is right
A file of "-" reads standard input instead. Every command that acts then waits for what needs you next and prints it
(--no-wait returns at once, for scripts that drive both seats).
All commands need --key <your seat key>.`;

if (!cmd || cmd === "help" || flags.help) {
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
const JSON_BODY = { move: "turn", direct: "plan", postgame: "postgame" };
if (cmd in JSON_BODY) {
  const raw = readInput();
  try {
    body[JSON_BODY[cmd]] = JSON.parse(raw);
  } catch (e) {
    console.error(`Your ${JSON_BODY[cmd]} JSON is not valid: ${e.message}`);
    process.exit(2);
  }
} else if (["interview", "journal", "lessons", "say"].includes(cmd)) {
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
        res.on("end", () => resolve({ status: res.statusCode, text, ack: res.headers["x-ack"] }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timed out"), { code: "TIMEOUT" })));
    req.on("error", reject);
    req.end(data);
  });
}

// Waiting (and showing the position) is safe to repeat; anything that acts may already have gone through.
const repeatable = ["wait", "bc-wait", "status"].includes(cmd);
const lost = `what you sent already went through. Run \`${cmd.startsWith("bc-") || ["say", "direct", "confirm"].includes(cmd) ? "bc-wait" : "wait"}\`; don't send it again.`;

async function main() {
  let res;
  // Ride out short server restarts: keep retrying an unreachable server for up to 45 s.
  const giveUpAt = Date.now() + 45_000;
  for (;;) {
    try {
      // The server blocks for up to 5 minutes before it answers WAITING.
      res = await post(cmd, body, 330_000);
      break;
    } catch (e) {
      if (e.code === "TIMEOUT") {
        console.log(repeatable ? "WAITING — no response yet. Run the command again." : `WAITING — no response yet, but ${lost}`);
        return;
      }
      // Refused: the server never got the request, so sending it again is safe. Anything else may have
      // dropped after the server acted on it (e.g. a restart mid-wait).
      if (Date.now() < giveUpAt && (repeatable || e.code === "ECONNREFUSED")) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!repeatable && e.code !== "ECONNREFUSED") {
        console.log(`WAITING — the connection dropped (${e.message}), but ${lost}`);
        return;
      }
      console.error(`Cannot reach the Agent Chess server at ${SERVER} (${e.message}). Wait ~20 seconds and retry.`);
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
  // Broadcaster batches are only marked consumed once we've printed them.
  if (res.ack) await post("bc-ack", { key, ack: res.ack }, 10_000).catch(() => {});
}

main();
