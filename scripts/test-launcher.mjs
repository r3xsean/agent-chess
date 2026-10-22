// Checks direct launches through T3 (for a seat the server can't run through a CLI: here both CLIs are turned
// off): a seat whose model and effort have an agent webhook is started in its own thread (the webhook gets only
// its key, signed), `start` gives that agent its task, and the rest go to an orchestrator run whose brief has only
// them. New titles and thumbnails on a planned game start a director the same way. It runs its own spare server, with its webhooks pointed at a fake T3 it runs itself.
//   node scripts/test-launcher.mjs
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startSpare } from "./spare.mjs";

const CLI = path.resolve("cli/chess.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const HOOK = `http://127.0.0.1:${fake.address().port}`;
const webhooks = { url: `${HOOK}/orchestrator`, secret: SECRET, agents: { "claude-haiku-5-5@low": `${HOOK}/haiku-low`, "claude-opus-5-5@high": `${HOOK}/director` } };

const spare = await startSpare({
  prepare: (data) => {
    writeFileSync(path.join(data, "webhook.json"), JSON.stringify(webhooks));
    // A finished game whose video plan is saved, for new titles and thumbnails.
    mkdirSync(path.join(data, "games"), { recursive: true });
    const planned = JSON.parse(readFileSync(path.resolve("scripts/fixtures/director-game.json"), "utf8"));
    writeFileSync(path.join(data, "games", "director-test.json"), JSON.stringify({ seen: {}, ...planned }));
  },
});
const { url: URL, token } = spare;
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
    const p = spawn("node", [CLI, ...args], { windowsHide: true, env: { ...process.env, AGENT_CHESS_URL: URL } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
  });
let ok = true;
const check = (label, cond, detail = "") => {
  if (!cond) ok = false;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
};

try {
  // White has an agent webhook, Black doesn't.
  const { game, launch } = await req("POST", "/api/games", {
    white: { model: "claude-haiku-5-5", effort: "low" },
    black: { model: "gpt-6-luna", effort: "low" },
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
  const unplanned = await req("POST", `/api/games/${game.id}/repackage`, {});
  check("new titles need a saved plan", unplanned.started === false && /no video plan/.test(unplanned.note), JSON.stringify(unplanned));
  await req("POST", `/api/games/${game.id}/abort`, {});

  // New titles and thumbnails: the director starts in its own thread, and its task is only the packaging.
  const repack = await req("POST", "/api/games/director-test/repackage", {});
  await sleep(300);
  const dirHit = hits.find((h) => h.path === "/director");
  check("new titles start a director in its own thread with only its key, signed", repack.started === true && dirHit?.signed && Object.keys(dirHit.body).join() === "key", JSON.stringify({ repack, dirHit }));
  const dStart = dirHit ? await cli(["start", "--key", dirHit.body.key]) : "";
  check("`start` gives that director only the titles and thumbnails", dStart.startsWith("🎬 Titles & thumbnails") && dStart.includes("packaging-brief"), dStart.split("\n")[0]);
  const again = await req("POST", "/api/games/director-test/repackage", {});
  check("asking again before they're in starts nothing", again.started === false && /asked for/.test(again.note) && hits.filter((h) => h.path === "/director").length === 1, JSON.stringify(again));

  // An unknown key says the seat may have been handed on.
  check("an unknown key tells the agent to stop", (await cli(["start", "--key", "nope-w-0000"])).includes("stop now"));
} finally {
  fake.close();
  await spare.stop();
}
process.exit(ok ? 0 : 1);
