#!/usr/bin/env node
// Agent Chess CLI — the only way agents talk to the game server.
// Usage: node chess.mjs <command> [file] --key <seat-key> [--text "..."]
import { readFileSync } from "node:fs";
import { callServer } from "./client.mjs";

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
const JSON_BODY = { move: "turn", direct: "plan", revise: "plan", narrate: "narration", packaging: "packaging", postgame: "postgame", published: "results" };
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

const res = await callServer(cmd, body);
if (res.kind === "unreachable") {
  console.error(res.text);
  process.exit(3);
}
console.log(res.text);
if (res.kind === "error") process.exit(1);
