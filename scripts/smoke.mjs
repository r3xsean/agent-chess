// End-to-end smoke test: create a game, drive both seats through the CLI, check the review.
// Usage: node scripts/smoke.mjs   (server must be running)
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL = process.env.AGENT_CHESS_URL ?? "http://127.0.0.1:5170";
const CLI = path.resolve("cli/chess.mjs");
const tmp = mkdtempSync(path.join(tmpdir(), "chess-smoke-"));
const TOKEN = (await import("node:fs")).readFileSync(path.join(process.env.AGENT_CHESS_DATA ?? "data", "admin-token.txt"), "utf8").trim();
const api = async (p, body) =>
  (await fetch(URL + p, body ? { method: "POST", headers: { "content-type": "application/json", "x-admin-token": TOKEN }, body: JSON.stringify(body) } : {})).json();
const cli = (args) => {
  try {
    // --no-wait: this script drives both seats in turn, so no command may block on the other one.
    return execFileSync("node", [CLI, ...args, ...(args[0] === "wait" ? [] : ["--no-wait"])], { encoding: "utf8", env: { ...process.env, AGENT_CHESS_URL: URL } });
  } catch (e) {
    return e.stdout + e.stderr;
  }
};
const file = (name, content) => {
  const f = path.join(tmp, name);
  writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content));
  return f;
};

const { game, launch } = await api("/api/games", {
  white: { model: "claude-opus-5-5", effort: "high", personality: "magician" },
  black: { model: "gpt-6-astra", effort: "high", personality: "python" },
  broadcaster: { enabled: false },
});
const keys = Object.fromEntries(launch.tasks.map((t) => [t.role, /--key (\S+)/.exec(t.prompt)[1]]));
console.log("game", game.id, keys);

console.log(cli(["wait", "--key", keys.white]).split("\n").slice(0, 6).join("\n"));
console.log(cli(["interview", "--text", "Ready to conjure something.", "--key", keys.white]));
console.log(cli(["interview", "--text", "I will squeeze.", "--key", keys.black]));
await new Promise((r) => setTimeout(r, 1500));

const moves = [
  ["w", "e4", "+0.3"],
  ["b", "e5", "0.3"],
  ["w", "Bc4", "+0.3"],
  ["b", "Nc6", "+0.3"],
  ["w", "Qh5", "+0.5"],
  ["b", "Nf6??", "+3"],
  ["w", "Qxf7#", "#0"],
];
console.log(cli(["move", file("bad.json", { move: "Ke2", commentary: "testing", eval: "0" }), "--key", keys.black]));
for (const [c, mv, ev] of moves) {
  const key = c === "w" ? keys.white : keys.black;
  const w = cli(["wait", "--key", key]);
  if (!w.startsWith("=== YOUR MOVE")) console.log("unexpected wait:", w.slice(0, 200));
  if (mv === "e5") console.log(cli(["move", file("ill.json", { move: "e4", commentary: "x", eval: "0" }), "--key", key]));
  const turn = {
    move: mv,
    commentary: `Playing ${mv}.`,
    eval: ev,
    lines: [{ moves: `${mv} Nf6 Qxf7#`, note: "test line" }, { moves: `1. ${mv} Zz9`, note: "breaks" }],
  };
  console.log(cli(["move", file(`m${mv.replace(/\W/g, "")}.json`, turn), "--key", key]).trim());
}
await new Promise((r) => setTimeout(r, 8000));
const g = await api(`/api/games/${game.id}`);
console.log("result", g.result, g.termination, "phase", g.phase, "opening", g.opening);
for (const m of g.moves) console.log(m.ply, m.san, m.analysis?.classification, m.analysis?.bestSan, m.illegalAttempts, m.lines.map((l) => `${l.san.join(" ")}|${l.brokenAt ?? ""}`));
console.log("review", JSON.stringify(g.review));
console.log(cli(["wait", "--key", keys.white]));
console.log(cli(["interview", "--text", "Magic.", "--key", keys.white]));
console.log(cli(["journal", "--text", "Scholar's mate works on pythons.", "--key", keys.white]));
console.log(cli(["wait", "--key", keys.white]));
console.log((await (await fetch(`${URL}/api/games/${game.id}/pgn`)).text()).slice(0, 1500));
