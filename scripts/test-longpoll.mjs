// Verifies long-poll blocking, broadcaster delivery/ack, and the end-of-broadcast path.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const URL = "http://127.0.0.1:5170";
const CLI = path.resolve("cli/chess.mjs");
const token = readFileSync("data/admin-token.txt", "utf8").trim();
const post = async (p, body, admin) =>
  (await fetch(URL + p, { method: "POST", headers: { "content-type": "application/json", ...(admin ? { "x-admin-token": token } : {}) }, body: JSON.stringify(body ?? {}) })).json();
const cli = async (...args) => (await run("node", [CLI, ...args]).catch((e) => e)).stdout?.trim();
const t0 = () => Date.now();

const noAdmin = await post("/api/games", { white: { model: "claude-haiku-5-5", personality: "monk" }, black: { model: "gpt-6-luna", personality: "monk" } });
console.log("no-admin create hides launch:", !("launch" in noAdmin));
const same = await post("/api/games", { white: { model: "gpt-6-luna", effort: "low", personality: "monk" }, black: { model: "gpt-6-luna", effort: "low", personality: "monk" } });
console.log("identical seats rejected:", !!same.error);

const { game, launch } = await post(
  "/api/games",
  { white: { model: "claude-haiku-5-5", effort: "low", personality: "monk" }, black: { model: "gpt-6-luna", effort: "low", personality: "trickster" }, broadcaster: { enabled: true } },
  true,
);
const key = Object.fromEntries(launch.tasks.map((t) => [t.role, /--key (\S+)/.exec(t.prompt)[1]]));

let s = t0();
const bc1 = await cli("bc-wait", "--key", key.broadcaster);
console.log(`bc-wait (matchup event immediately): ${Date.now() - s}ms ->`, bc1.split("\n")[0]);
s = t0();
const bcBlock = cli("bc-wait", "--key", key.broadcaster);
await cli("interview", "--text", "Calm.", "--key", key.white);
await cli("interview", "--text", "Tricky.", "--key", key.black);
console.log(`bc-wait woke on interviews after ${Date.now() - s}ms ->`, (await bcBlock).split("\n")[0]);
await cli("say", "--text", "Welcome everyone, here we go.", "--key", key.broadcaster);
await new Promise((r) => setTimeout(r, 1500));
console.log("white wait (should be YOUR MOVE):", (await cli("wait", "--key", key.white)).split("\n")[0]);

// White moves; Black's wait should return promptly, and White's next wait must BLOCK until Black moves.
await cli("move", "--text", "x", "--key", key.white).catch(() => {});
const fs = await import("node:fs");
const tmp = path.resolve("data/agents", game.id, "w", "t.json");
fs.writeFileSync(tmp, JSON.stringify({ move: "e4", commentary: "test", eval: "+0.3" }));
console.log(await cli("move", tmp, "--key", key.white));
fs.writeFileSync(tmp, JSON.stringify({ move: "e5", commentary: "test", eval: "" }));
const blankEval = await cli("move", tmp, "--key", key.black);
console.log("blank eval rejected:", blankEval.includes("eval"));
s = t0();
const whiteWait = cli("wait", "--key", key.white);
await new Promise((r) => setTimeout(r, 3000));
fs.writeFileSync(tmp, JSON.stringify({ move: "e5", commentary: "test", eval: "0.2" }));
await cli("move", tmp, "--key", key.black);
const w = await whiteWait;
console.log(`white wait blocked ${Date.now() - s}ms (expect ~3000) ->`, w.split("\n")[0]);

// Resign, finish post-game, and make sure the broadcaster gets DONE without crashing the server.
await cli("resign", "--key", key.black);
await new Promise((r) => setTimeout(r, 6000));
for (const c of ["white", "black"]) {
  await cli("interview", "--text", "GG.", "--key", key[c]);
  await cli("journal", "--text", "Lesson.", "--key", key[c]);
}
const bcEvents = await cli("bc-wait", "--key", key.broadcaster);
console.log("bc got:", bcEvents.split("\n").filter((l) => l.startsWith("[")).map((l) => l.split("]")[0] + "]").join(" "));
s = t0();
const bcDone = cli("bc-wait", "--key", key.broadcaster);
await new Promise((r) => setTimeout(r, 1000));
await cli("say", "--text", "That's all, folks.", "--key", key.broadcaster);
console.log(`bc final: ${Date.now() - s}ms ->`, (await bcDone).split("\n")[0]);
console.log("bc after done:", (await cli("bc-wait", "--key", key.broadcaster)).split("\n")[0]);
const meta = await (await fetch(URL + "/api/meta")).json();
console.log("server alive:", !!meta.models);
await post(`/api/games/${game.id}/abort`, {}, true);
