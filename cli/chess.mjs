#!/usr/bin/env node
// Agent Chess CLI — the only way agents talk to the game server.
// Usage: node chess.mjs <command> [file] --key <seat-key> [--text "..."]
import { readFileSync } from "node:fs";

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
  journal <file.txt>       write your post-game journal entry (or --text "...")
  lessons <file.txt>       rewrite your lessons playbook after the game (or --text "...")
  bc-wait                  (broadcaster) wait for new events
  say <file.txt>           (broadcaster) speak a segment (or --text "...")
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
    return readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (e) {
    console.error(`Could not read ${file}: ${e.message}`);
    process.exit(2);
  }
}

const body = { key };
if (cmd === "move") {
  const raw = readInput();
  try {
    body.turn = JSON.parse(raw);
  } catch (e) {
    console.error(`Your turn file is not valid JSON: ${e.message}`);
    process.exit(2);
  }
} else if (["interview", "journal", "lessons", "say"].includes(cmd)) {
  body.text = readInput().trim();
}

async function main() {
  let res;
  try {
    res = await fetch(`${SERVER}/api/agent/${encodeURIComponent(cmd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(80_000),
    });
  } catch (e) {
    if (e.name === "TimeoutError") {
      console.log("WAITING — no response yet. Run the command again.");
      return;
    }
    console.error(`Cannot reach the Agent Chess server at ${SERVER} (${e.message}). Wait ~20 seconds and retry.`);
    process.exit(3);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? text;
    } catch {}
    console.log(`ERROR: ${msg}`);
    process.exit(1);
  }
  console.log(text);
  // Broadcaster batches are only marked consumed once we've printed them.
  const ack = res.headers.get("x-ack");
  if (ack) {
    await fetch(`${SERVER}/api/agent/bc-ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, ack }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}

main();
