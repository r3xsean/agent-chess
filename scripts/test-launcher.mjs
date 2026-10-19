// Checks direct launches: a seat whose model and effort have an agent webhook is started in its own thread
// (the webhook gets only its key, signed), `start` gives that agent its task, and the rest go to an orchestrator
// run whose brief has only them. It sets the spare server's webhooks to a fake T3 it runs itself.
// AGENT_CHESS_URL=http://127.0.0.1:5180 AGENT_CHESS_DATA=<its data dir> node scripts/test-launcher.mjs
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const URL = process.env.AGENT_CHESS_URL ?? "http://127.0.0.1:5180";
const DATA = process.env.AGENT_CHESS_DATA;
if (!DATA || URL.endsWith(":5170")) throw new Error("Point this at a spare server: it replaces data/webhook.json.");
const CLI = path.resolve("cli/chess.mjs");
const token = readFileSync(path.join(DATA, "admin-token.txt"), "utf8").trim();
const req = async (method, p, body) => {
  const r = await fetch(URL + p, { method, headers: { "content-type": "application/json", "x-admin-token": token }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try {
    return { status: r.status, ...JSON.parse(t) };
  } catch {
    return { status: r.status, text: t };
  }
};
const cli = (args) =>
  new Promise((resolve) => {
    const p = spawn("node", [CLI, ...args], { env: { ...process.env, AGENT_CHESS_URL: URL } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (label, cond, detail = "") => {
  if (!cond) ok = false;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
};

// The fake T3: records each request, and whether its signature is right.
const SECRET = "test-secret";
const hits = [];
const fake = createServer((rq, rs) => {
  let body = "";
  rq.on("data", (d) => (body += d));
  rq.on("end", () => {
    const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    hits.push({ path: rq.url, body: JSON.parse(body), signed: rq.headers["x-agent-chess-signature"] === sig });
    rs.writeHead(202).end("{}");
  });
}).listen(5191);
const HOOK = "http://127.0.0.1:5191";
const webhookFile = path.join(DATA, "webhook.json");
writeFileSync(webhookFile, JSON.stringify({ url: `${HOOK}/orchestrator`, secret: SECRET, agents: { "claude-haiku-5-5@low": `${HOOK}/haiku-low` } }));

try {
  // White has an agent webhook, Black doesn't.
  const { game, launch } = await req("POST", "/api/games", {
    white: { model: "claude-haiku-5-5", effort: "low", personality: "monk" },
    black: { model: "gpt-6-luna", effort: "low", personality: "trickster" },
    broadcaster: { enabled: false },
  });
  const wKey = /--key (\S+)/.exec(launch.tasks[0].prompt)[1];
  await req("POST", `/api/games/${game.id}/summon`, {});
  await sleep(300);
  const agentHit = hits.find((h) => h.path === "/haiku-low");
  const orchHit = hits.find((h) => h.path === "/orchestrator");
  check("White starts in its own thread with only its key, signed", agentHit && agentHit.signed && JSON.stringify(agentHit.body) === JSON.stringify({ key: wKey }), JSON.stringify(agentHit));
  check("Black goes to an orchestrator run", orchHit && orchHit.signed && orchHit.body.action === "start-game" && orchHit.body.gameId === game.id, JSON.stringify(orchHit));

  const brief = (await req("POST", "/api/orchestrator/brief", { action: "start-game", gameId: game.id })).text ?? "";
  check("the orchestrator's brief has only Black", (brief.match(/^<prompt>$/gm) ?? []).length === 1 && brief.includes(`${game.id}-b"`) && !brief.includes(`${game.id}-w"`));

  const start = await cli(["start", "--key", wKey]);
  check("`start` gives the agent its thread title, then its task", start.split("\n")[0].startsWith("♟ White:") && start.includes(`--key ${wKey}`) && start.includes("You play White"), start.split("\n")[0]);

  const before = hits.length;
  await req("POST", `/api/games/${game.id}/summon`, { force: true });
  await sleep(300);
  check("summoning again starts nothing already started", hits.length === before, `${hits.length - before} new`);

  const agents = await req("GET", `/api/games/${game.id}`);
  check("the game records White as launched directly", !!agents.directLaunch?.w && !agents.directLaunch?.b, JSON.stringify(agents.directLaunch));
  await req("POST", `/api/games/${game.id}/abort`, {});

  // An unknown key says the seat may have been handed on.
  check("an unknown key tells the agent to stop", (await cli(["start", "--key", "nope-w-0000"])).includes("stop now"));
} finally {
  rmSync(webhookFile, { force: true });
  fake.close();
}
process.exit(ok ? 0 : 1);
