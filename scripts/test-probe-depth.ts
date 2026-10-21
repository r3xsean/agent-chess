import assert from "node:assert/strict";

// The replay's engine questions search to their depth goal with no time limit; a question that outlasts the
// agent's window answers WAITING, and asking again joins the same work instead of starting over.
process.env.GAMING_PROCESSES = "";
process.env.LINES_DEPTH = "16";
process.env.PROBE_ANSWER_MS = "300";
delete process.env.ENGINE_MAX_MS;
const { newRules } = await import("../shared/rules");
const { probeCommand } = await import("../server/probe");
const { LINE_DEPTH_VERSION } = await import("../server/lineDepth");
import type { Game } from "../shared/types";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const moves = [];
let fen = START;
for (const [ply, uci] of ["e2e4", "e7e5", "g1f3", "b8c6"].entries()) {
  const r = newRules(fen);
  const mv = r.move(uci);
  moves.push({ ply: ply + 1, color: mv.color, san: mv.san, uci, from: uci.slice(0, 2), to: uci.slice(2, 4), fenBefore: fen, fenAfter: r.fen(), commentary: "", selfEval: null, selfEvalRaw: "", lines: [], illegalAttempts: [] });
  fen = r.fen();
}
const g = {
  id: `probe-test-${Date.now()}`,
  white: { provider: "claude", model: "test-white" },
  black: { provider: "codex", model: "test-black" },
  moves,
  analysis: {},
} as unknown as Game;

const first = await probeCommand(g, "probe", ["4", "Bb5"]);
assert.match(first!, /^WAITING — the engine is still following that line at full depth/, "a slow probe answers WAITING");
let out = first!;
for (let i = 0; i < 200 && out.startsWith("WAITING"); i++) out = (await probeCommand(g, "probe", ["4", "Bb5"]))!;
assert.doesNotMatch(out, /^WAITING/, "asking again picks it up until it's done");
assert.match(out, /Then the engine's best play/);
const searched = Object.values(g.analysis).filter((a) => a.depth > 0);
assert.ok(searched.length >= 3, "the probe's positions are kept in the game");
assert.ok(
  searched.every((a) => a.depth === 16 && a.lineVersion === LINE_DEPTH_VERSION),
  "every position reaches the lines' depth goal (no time limit cuts it short)",
);

const opts = await probeCommand(g, "options", ["4", "3"]);
let o = opts!;
for (let i = 0; i < 200 && o.startsWith("WAITING"); i++) o = (await probeCommand(g, "options", ["4", "3"]))!;
assert.match(o, /Its 3 best moves/, "options answers in full once its search is done");
console.log("PASS: engine questions search to the lines' depth goal, answer WAITING past the agent's window, and pick up where they were");
process.exit(0);
