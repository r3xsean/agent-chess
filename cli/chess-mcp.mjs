#!/usr/bin/env node
// Agent Chess as MCP tools: the player's commands, for a seat the server runs itself in an experiment game
// (shared/seatSetup.ts). Same server calls as the CLI (client.mjs); the difference is that a board picture the
// server names on a "BOARD PICTURE:" line comes attached to the reply, so the player sees it without opening it.
// The seat key comes in AGENT_CHESS_KEY. Speaks MCP over stdio: newline-delimited JSON-RPC.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { callServer } from "./client.mjs";

const key = process.env.AGENT_CHESS_KEY ?? "";

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description) => ({ type: "string", description });

/** Each tool: its server command, and what it sends. */
const TOOLS = [
  { name: "start", cmd: "start", description: "Your task: who you are in this game and exactly what to do. Call it first.", schema: obj({}) },
  { name: "help", cmd: "help", description: "List your tools.", schema: obj({}) },
  { name: "wait", cmd: "wait", description: "Blocks (up to 5 minutes) until something needs you, and returns it.", schema: obj({}) },
  { name: "status", cmd: "status", description: "The current position again.", schema: obj({}) },
  {
    name: "move",
    cmd: "move",
    description: "Submit your move, then wait for whatever needs you next and return it: one call is one whole turn.",
    schema: obj(
      {
        move: str('Your move in SAN ("Nf3", "exd5", "O-O", "e8=Q") or UCI ("g1f3").'),
        commentary: str("Your thinking for this move, shown live to the audience."),
        eval: str('What the position is worth after your move, in pawns from White\'s point of view ("+0.8", "-1.5", "0.0", "#3").'),
        lines: {
          type: "array",
          description: "Lines you calculated, each from the current position with your move first.",
          items: obj({ moves: str("The moves, in order."), note: str("What the line shows.") }, ["moves"]),
        },
        offerDraw: { type: "boolean", description: "Offer a draw with this move." },
        seen: str("The check code printed at the top of this turn's board picture (when you're shown one)."),
        position: {
          type: "object",
          description: "Every piece on the board, when your task asks you to write it out: piece letter (K Q R B N P) and square.",
          properties: { white: { type: "array", items: { type: "string" } }, black: { type: "array", items: { type: "string" } } },
          required: ["white", "black"],
        },
      },
      ["move", "commentary", "eval"],
    ),
    body: (a) => ({ turn: a }),
  },
  { name: "accept_draw", cmd: "accept-draw", description: "Accept your opponent's pending draw offer.", schema: obj({}) },
  { name: "resign", cmd: "resign", description: "Resign the game.", schema: obj({}) },
  { name: "interview", cmd: "interview", description: "Answer the pre-game interview.", schema: obj({ text: str("Your answer, under 800 characters.") }, ["text"]), body: (a) => ({ text: String(a.text ?? "").trim() }) },
  {
    name: "postgame",
    cmd: "postgame",
    description: "After the game: your post-game interview answer.",
    schema: obj({ interview: str("Your answer, under 800 characters.") }, ["interview"]),
    body: (a) => ({ postgame: a }),
  },
];

const PICTURE = /^BOARD PICTURE: (.+\.png)\s*$/m;

/** The server's reply as MCP content: its text, with the board picture it names attached. */
function content(text) {
  const m = PICTURE.exec(text);
  if (!m || !existsSync(m[1])) return [{ type: "text", text }];
  return [
    { type: "text", text: text.replace(PICTURE, "BOARD PICTURE: attached to this reply.") },
    { type: "image", data: readFileSync(m[1]).toString("base64"), mimeType: "image/png" },
  ];
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  const res = await callServer(tool.cmd, { key, via: "tools", ...(tool.body ? tool.body(args ?? {}) : {}) });
  return { content: content(res.text), ...(res.kind === "error" || res.kind === "unreachable" ? { isError: true } : {}) };
}

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  try {
    if (m.method === "initialize")
      return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chess", version: "1.0" } });
    if (m.method === "tools/list") return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
    if (m.method === "tools/call") return reply(await callTool(m.params?.name, m.params?.arguments));
    if (m.method === "ping") return reply({});
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
});
