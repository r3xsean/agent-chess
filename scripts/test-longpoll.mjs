// Verifies the one-call turn: every command that acts waits for the next thing and prints it, a retried
// move isn't played twice, the broadcaster's quiet moves come in batches, and `postgame` takes everything at once.
// Point it at a spare server: AGENT_CHESS_URL=http://127.0.0.1:5180 AGENT_CHESS_DATA=<its data dir> node scripts/test-longpoll.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const URL = process.env.AGENT_CHESS_URL ?? "http://127.0.0.1:5170";
const DATA = process.env.AGENT_CHESS_DATA ?? "data";
const CLI = path.resolve("cli/chess.mjs");
const token = readFileSync(path.join(DATA, "admin-token.txt"), "utf8").trim();
const post = async (p, body, admin) =>
  (await fetch(URL + p, { method: "POST", headers: { "content-type": "application/json", ...(admin ? { "x-admin-token": token } : {}) }, body: JSON.stringify(body ?? {}) })).json();
/** Run the CLI, with `input` on standard input when given. */
const cli = (args, input) =>
  new Promise((resolve) => {
    const p = spawn("node", [CLI, ...args], { env: { ...process.env, AGENT_CHESS_URL: URL } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
    p.stdin.end(input ?? "");
  });
const turn = (move, extra = {}) => JSON.stringify({ move, commentary: `I play ${move} — it's natural.`, eval: "+0.2", ...extra });
const first = (s) => s.split("\n").filter(Boolean)[0];
const after = (s) => s.split("\n\n")[1]?.split("\n")[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (label, cond, detail = "") => {
  if (!cond) ok = false;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
};

const { game, launch } = await post(
  "/api/games",
  { white: { model: "claude-haiku-5-5", effort: "low", personality: "monk" }, black: { model: "gpt-6-luna", effort: "low", personality: "trickster" }, broadcaster: { enabled: true } },
  true,
);
const key = Object.fromEntries(launch.tasks.map((t) => [t.role, /--key (\S+)/.exec(t.prompt)[1]]));
check("prompt has no board image", !launch.tasks.some((t) => t.prompt.includes("board.png")));
const k = (role) => ["--key", key[role]];

check("bc-wait: matchup at once", (await cli(["bc-wait", ...k("broadcaster")])).startsWith("[MATCHUP]"));
// Interviews now wait on: White's for its first move, Black's for White's reply.
const wInterview = cli(["interview", "-", ...k("white")], "Calm, it's a long game.");
const bInterview = cli(["interview", "--text", "Tricky.", ...k("black")]);
const bcIntro = await cli(["bc-wait", ...k("broadcaster")]);
check("bc-wait woke on interviews", bcIntro.includes("PRE-GAME INTERVIEW"));
const bcAfterIntro = cli(["say", "-", ...k("broadcaster")], "Welcome everyone — here we go.");
const w1 = await wInterview;
check("interview waits on to YOUR MOVE", first(w1) === "OK — interview recorded." && after(w1)?.startsWith("=== YOUR MOVE — move 1"), after(w1));
check("brief has FEN, recent moves, no board image", w1.includes("FEN:") && w1.includes("Recent moves:") && !w1.includes("board.png") && !w1.includes("Opponent:"));
check("say waits on to the next events", (await bcAfterIntro).includes("[GAME STARTED]"));

// White's move blocks until Black replies; an identical retry meanwhile isn't played again.
const wMove = cli(["move", "-", ...k("white")], turn("e4"));
await sleep(500);
const wRetry = cli(["move", "-", ...k("white")], turn("e4"));
const b1 = await bInterview;
check("Black's interview waits on to its move", after(b1)?.startsWith("=== YOUR MOVE — move 1, you are Black"), after(b1));
const bcBatch = cli(["say", "--text", "And we're underway.", ...k("broadcaster")]);
await sleep(2000);
const bMove = cli(["move", "-", ...k("black")], turn("e5", { eval: "0.0" }));
const [w2, w2retry] = await Promise.all([wMove, wRetry]);
check("move waits on to the next YOUR MOVE", first(w2).startsWith("OK — played e4") && after(w2)?.startsWith("=== YOUR MOVE — move 2"), first(w2));
check("identical retry not played again", first(w2retry).includes("already played e4") && after(w2retry)?.startsWith("=== YOUR MOVE — move 2"), first(w2retry));
const bcEarly = await Promise.race([bcBatch, sleep(4000).then(() => null)]);
check("two quiet moves are held for a third", bcEarly === null, bcEarly ? first(bcEarly) : "still waiting");

const wMove2 = cli(["move", "-", ...k("white")], turn("Nf3"));
const b2 = await bMove;
check("Black's move waits on too", after(b2)?.startsWith("=== YOUR MOVE — move 2, you are Black"));
const batch = await bcBatch;
check("third move releases the batch", ["[MOVE 1. e4]", "[MOVE 1... e5]", "[MOVE 2. Nf3]"].every((m) => batch.includes(m)), batch.split("\n").filter((l) => l.startsWith("[MOVE")).map((l) => l.split("]")[0] + "]").join(" "));

// Black resigns: resign waits on to the post-game brief once the engine review is in.
const bResign = await cli(["resign", ...k("black")]);
check("resign waits on to GAME OVER", after(bResign)?.startsWith("=== GAME OVER"), after(bResign));
check("post-game asks for one postgame JSON", bResign.includes('Submit them all at once with `postgame`'));
const w3 = await wMove2;
check("White's pending move call ends at GAME OVER", w3.includes("=== GAME OVER"));

const bad = await cli(["postgame", "-", ...k("black")], JSON.stringify({ interview: "GG.", journal: "They like the Italian.", lessons: "- Check every capture twice." }));
check("bad lessons reject the whole postgame", first(bad).includes('"lessons" was not saved'), first(bad));
const good = await cli(["postgame", "-", ...k("black")], JSON.stringify({ interview: "GG.", journal: "They like the Italian.", lessons: "- When I'm about to capture → check the recapture." }));
check("postgame saves all and reaches DONE", first(good).startsWith("OK — saved lessons, interview, journal") && after(good)?.startsWith("DONE"), first(good));
const part = await cli(["postgame", "-", ...k("white")], JSON.stringify({ interview: "A clean win." }));
check("partial postgame lists what's left, briefly", first(part).includes("Still missing: journal, lessons") && after(part)?.startsWith("=== GAME OVER — still to do"), first(part));
const rest = await cli(["postgame", "-", ...k("white")], JSON.stringify({ interview: "A clean win.", journal: "Resigned early.", lessons: "- When ahead → trade down." }));
check("resending with the rest finishes", after(rest)?.startsWith("DONE"), first(rest));

// Retries that arrive after the game has moved on just carry on.
const reInterview = await cli(["interview", "--text", "Tricky.", ...k("black")]);
check("pre-game interview resent after the game carries on", first(reInterview) === "OK — interview recorded." && after(reInterview)?.startsWith("DONE"), first(reInterview));
const rePost = await cli(["postgame", "-", ...k("black")], JSON.stringify({ interview: "GG.", journal: "They like the Italian." }));
check("finished postgame resent carries on to DONE", first(rePost).includes("already in") && after(rePost)?.startsWith("DONE"), first(rePost));

// The same JSON as the last turn is a retry until the player has seen the new position, and a real move after.
const g2 = await post(
  "/api/games",
  { white: { model: "claude-haiku-5-5", effort: "low", personality: "monk" }, black: { model: "gpt-6-luna", effort: "low", personality: "monk" }, broadcaster: { enabled: false } },
  true,
);
const k2 = Object.fromEntries(g2.launch.tasks.map((t) => [t.role, ["--key", /--key (\S+)/.exec(t.prompt)[1]]]));
await cli(["interview", "--text", "Hi.", ...k2.white, "--no-wait"]);
await cli(["interview", "--text", "Hi.", ...k2.black, "--no-wait"]);
await sleep(2000);
const play = async (side, json) => (await cli(["wait", ...k2[side]]), cli(["move", "-", ...k2[side], "--no-wait"], json));
const nf3 = turn("Nf3", { commentary: "Knight out." });
await play("white", nf3);
await play("black", turn("e5"));
const resent = await cli(["move", "-", ...k2.white, "--no-wait"], nf3);
check("resent before seeing the new position isn't played", first(resent).includes("already played Nf3"), first(resent));
// After seeing it, the same JSON is tried as a real move (and Nf3 is now illegal: the knight is already there).
const again = await play("white", nf3);
check("same JSON after seeing the new position is a real move", first(again) === "ERROR: Illegal move.", first(again));
await post(`/api/games/${g2.game.id}/abort`, {}, true);

const meta = await (await fetch(URL + "/api/meta")).json();
check("server alive", !!meta.models);
await post(`/api/games/${game.id}/abort`, {}, true);
process.exit(ok ? 0 : 1);
