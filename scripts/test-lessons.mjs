// End-to-end check of the learning loop on throwaway players (cleans up after itself).
// Usage: node scripts/test-lessons.mjs   (server must be running)
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const URL = "http://127.0.0.1:5170";
const CLI = path.resolve("cli/chess.mjs");
const MODEL = "gpt-5.6-terra"; // both seats share a model → exercises the shared-lessons concurrency check
const token = readFileSync("data/admin-token.txt", "utf8").trim();
const post = async (p, body) =>
  (await fetch(URL + p, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": token }, body: JSON.stringify(body ?? {}) })).json();
const cli = async (...a) => {
  const r = await run("node", [CLI, ...a]).catch((e) => e);
  return (r.stdout ?? "").trim();
};
const check = (label, ok) => console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
const created = [];

async function newGame() {
  const { game, launch } = await post("/api/games", {
    white: { model: MODEL, effort: "low", personality: "magician" },
    black: { model: MODEL, effort: "low", personality: "python" },
    broadcaster: { enabled: false },
  });
  created.push(game.id);
  const key = Object.fromEntries(launch.tasks.map((t) => [t.role, /--key (\S+)/.exec(t.prompt)[1]]));
  return { game, key, prompt: launch.tasks[0].prompt };
}
const turn = (g, side, move) => {
  const f = path.resolve("data/agents", g.id, side === "white" ? "w" : "b", "t.json");
  writeFileSync(f, JSON.stringify({ move, commentary: "test", eval: "0" }));
  return f;
};

try {
  // Game 1: scholar's mate, so Black has a real blunder to study.
  const { game: g, key, prompt } = await newGame();
  check("player prompt documents the lessons command", prompt.includes("lessons <file.txt>"));
  await cli("interview", "--text", "Hi.", "--key", key.white);
  await cli("interview", "--text", "Hi.", "--key", key.black);
  await new Promise((r) => setTimeout(r, 1500));
  for (const [side, mv] of [["white", "e4"], ["black", "e5"], ["white", "Bc4"], ["black", "Nc6"], ["white", "Qh5"], ["black", "Nf6"], ["white", "Qxf7#"]]) {
    await cli("wait", "--key", key[side]);
    await cli("move", turn(g, side, mv), "--key", key[side]);
  }
  await new Promise((r) => setTimeout(r, 6000));
  const blackBrief = await cli("wait", "--key", key.black);
  check("post-game brief shows worst moves in detail", blackBrief.includes("Your worst moves, in detail") && blackBrief.includes("What punishes Nf6"));
  check("post-game brief asks for lessons", blackBrief.includes("Update your LESSONS"));
  const whiteBrief = await cli("wait", "--key", key.white); // both seats now saw v0

  for (const side of ["white", "black"]) {
    await cli("interview", "--text", "GG.", "--key", key[side]);
    await cli("journal", "--text", "Notes.", "--key", key[side]);
  }
  const vague = await cli("lessons", "--text", "- Calculate carefully", "--key", key.white);
  check("lesson without a trigger → action is rejected", vague.includes('missing the "→"'));
  const tooMany = await cli("lessons", "--text", Array.from({ length: 11 }, (_, i) => `- When ${i} → do ${i}`).join("\n"), "--key", key.white);
  check("more than 10 items is rejected", tooMany.includes("At most 10"));
  const wrapped = "- When the opponent's queen comes out early →\n  look for tempo moves that develop while attacking it.\n- When f7 is only defended by the king → count attackers before every move.";
  const okW = await cli("lessons", "--text", wrapped, "--key", key.white);
  check("wrapped bullets count as one item and are accepted", okW.includes("OK"));
  const stale = await cli("lessons", "--text", "- When x → y", "--key", key.black);
  check("teammate's stale rewrite is refused and shown the latest version", stale.includes("just updated") && stale.includes("tempo moves"));
  const okB = await cli("lessons", "--text", wrapped + "\n- When a knight blocks my f-pawn → watch the f7 square.", "--key", key.black);
  check("rewrite from the latest version is accepted", okB.includes("OK"));
  check("player is DONE after interview, journal and lessons", (await cli("wait", "--key", key.white)).startsWith("DONE"));

  const lessons = await (await fetch(`${URL}/api/lessons/${MODEL}`)).json();
  check("lessons stored per model with history", lessons.version === 2 && lessons.history.length === 2 && lessons.text.includes("f7 square"));

  // Game 2: lessons appear before and during the game.
  const { game: g2, key: k2 } = await newGame();
  const pre = await cli("wait", "--key", k2.white);
  check("pre-game brief shows the lessons", pre.includes("Your LESSONS") && pre.includes("f7 square"));
  await cli("interview", "--text", "Hi.", "--key", k2.white);
  await cli("interview", "--text", "Hi.", "--key", k2.black);
  await new Promise((r) => setTimeout(r, 1500));
  const t1 = await cli("wait", "--key", k2.white);
  check("every move's brief shows the lessons", t1.includes("Your lessons from past games") && t1.includes("f7 square"));
  check("every move's brief shows the piece list", t1.includes("Pieces — White: Ke1"));

  const reset = await post(`/api/lessons/${MODEL}/reset`);
  check("reset empties the active lessons but keeps history", reset.text === "" && reset.history.length === 3);
  await post(`/api/games/${g2.id}/abort`);
} finally {
  // Let the server's debounced saves land first, or it re-creates the files we delete.
  await new Promise((r) => setTimeout(r, 1500));
  // Cleanup: throwaway games, their files, the test model's lessons and the test players' journals.
  for (const id of created) {
    for (const p of [`data/games/${id}.json`, `data/agents/${id}`, `data/audio/${id}`]) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  for (const p of [`data/lessons/${MODEL}.json`, `data/journals/${MODEL}_low_magician.json`, `data/journals/${MODEL}_low_python.json`])
    if (existsSync(p)) rmSync(p, { force: true });
  console.log(`cleaned up ${created.length} test games (restart the server to drop them from memory)`);
}
