// The board-view experiment (shared/seatSetup.ts) end to end, on an isolated spare server: never touches live games
// or calls a model. Each seat's briefing, the picture's check code and the written-out position checked before a
// move, the chess MCP tools bringing the picture, a split tournament's sides, and the Experiments report.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Game, Tournament } from "../shared/types";
import { pairingSetups } from "../shared/seatSetup";
import { codeMatches, positionMatches, positionShapeError } from "../server/turnChecks";
import { roundRobin, splitSides } from "../server/schedule";
import { experimentReport } from "../server/experiments";
import { games } from "../server/store";
import { startSpare } from "./spare.mjs";

// The checks on their own.
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const startPos = {
  white: ["Ke1", "Qd1", "Ra1", "Rh1", "Bc1", "Bf1", "Nb1", "Ng1", ..."abcdefgh".split("").map((f) => `${f}2`)],
  black: ["Ke8", "Qd8", "Ra8", "Rh8", "Bc8", "Bf8", "Nb8", "Ng8", ..."abcdefgh".split("").map((f) => `P${f}7`)],
};
assert.equal(positionShapeError(startPos), null);
assert.ok(positionMatches(START, startPos));
assert.ok(!positionMatches(START, { ...startPos, white: startPos.white.slice(1) }), "a missing piece");
assert.ok(!positionMatches(START, { ...startPos, white: [...startPos.white.slice(1), "Kf1"] }), "a piece on the wrong square");
assert.ok(!positionMatches(START, { ...startPos, white: [...startPos.white, "a2"] }), "a piece twice");
assert.ok(positionMatches(START, { ...startPos, white: startPos.white.map((p) => p.replace("Bc1", "bc1")) }), "a lowercase bishop letter");
assert.ok(positionShapeError(undefined) && positionShapeError({ white: [], black: ["the king"] }));
assert.ok(codeMatches(" k7q ", "K7Q") && !codeMatches("K7R", "K7Q") && !codeMatches(undefined, "K7Q"));

// A split's sides: in a double round-robin every model plays each opponent once under A, and A as White about as often as Black.
for (let n = 2; n <= 8; n++) {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const ps = roundRobin(ids, true);
  splitSides(ps);
  // Perfect balance (each model's A games half White) can be impossible: a model plays A as White in exactly its
  // pairs that put A on White, and with 3 or 7 players those can't come out even for everyone. Off by two at most, and rarely.
  let off = 0;
  for (const id of ids) {
    const aGames = ps.filter((p) => (p.aSide === "w" ? p.white : p.black) === id);
    assert.equal(aGames.length, n - 1, `${n} players: ${id} plays A once against each opponent`);
    const aWhite = aGames.filter((p) => p.white === id).length;
    const gap = Math.abs(2 * aWhite - aGames.length);
    assert.ok(gap <= 2, `${n} players: ${id} plays A as White ${aWhite} of ${aGames.length}`);
    if (gap === 2) off++;
  }
  assert.ok(off <= 2, `${n} players: ${off} models off by two`);
  if (n === 7) console.log(`7 players: ${off} model(s) play A as White 4 of 6 (the rest 3 of 6)`);
}
{
  // A big split is quick: tournaments are created on the server's request thread.
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const ps = roundRobin(ids, true);
  const t0 = Date.now();
  splitSides(ps);
  assert.ok(Date.now() - t0 < 1000, `20 players took ${Date.now() - t0} ms`);
}
{
  // A single round-robin balances how often each model plays under A.
  const ids = Array.from({ length: 7 }, (_, i) => `p${i}`);
  const ps = roundRobin(ids, false);
  splitSides(ps);
  for (const id of ids) {
    const a = ps.filter((p) => (p.aSide === "w" ? p.white : p.black) === id).length;
    assert.equal(a, 3, `single round-robin: ${id} plays A in half its games`);
  }
}

// The report's numbers, on games made up here (in this process's own empty data dir).
{
  const ref = (model: string) => ({ id: `${model}@high`, provider: "codex", model, modelLabel: model, effort: "high" });
  const made = (id: string, aWins: boolean): Game =>
    ({
      id,
      createdAt: 0,
      white: ref("m-a"),
      black: ref("m-b"),
      phase: "finished",
      moves: [],
      drawOffer: null,
      result: aWins ? "1-0" : "0-1",
      termination: "x",
      interviews: { pre: {}, post: {} },
      seen: {},
      pendingIllegal: { w: [], b: [] },
      turnStartedAt: null,
      analysis: {},
      opening: null,
      review: { w: { accuracy: 80, estElo: null, counts: {}, selfEvalError: null }, b: { accuracy: 70, estElo: null, counts: {}, selfEvalError: null } },
      playStartedAt: null,
      interviewsCompleteAt: null,
      options: { seats: { w: { view: "added", reread: false } } },
    }) as Game;
  // 24 split games, A (White, the picture) winning 16: the score gap is paired, so its range is the paired one, not two independent ones.
  for (let i = 0; i < 24; i++) games.set(`s${i}`, made(`s${i}`, i < 16));
  const r = experimentReport("experiments");
  const image = r.arms.find((a) => a.key === "added")!;
  assert.equal(r.arms[0].key, "text");
  assert.equal(image.score.value, 66.7);
  const gap = image.vsFirst!.score!;
  assert.equal(gap.value, 33.3);
  assert.ok(gap.ci! > 37 && gap.ci! < 40, `paired range ${gap.ci}`);
  assert.equal(gap.clear, false, "33 points from 24 games isn't clear of the noise once it's paired");
  // A seat that refused its first position three times and resigned still counts its refusals.
  const quitter = made("q", false);
  quitter.options = { seats: { w: { view: "image", reread: true } } };
  quitter.pendingChecks = { w: { code: 0, position: 3 } };
  games.clear();
  games.set("q", quitter);
  for (let i = 0; i < 2; i++) {
    const g = made(`m${i}`, true);
    g.options = quitter.options;
    g.moves = [{ ply: 1, color: "w", san: "e4", uci: "e2e4", from: "e2", to: "e4", fenBefore: "", fenAfter: "", commentary: "", selfEval: null, selfEvalRaw: "", lines: [], illegalAttempts: [], offeredDraw: false, thinkMs: 1, ts: 0 }] as Game["moves"];
    games.set(g.id, g);
  }
  const q = experimentReport("experiments").arms.find((a) => a.key === "image+reread")!;
  assert.equal(q.positionRefusals.value, 150, "3 refusals over 2 moves played");
  // Fewer than five games: no range, and nothing called clear.
  assert.equal(q.score.ci, null);
  games.clear();

  // Five games, only one with an open position: open accuracy rests on that one game, so it gets no range.
  const open = (g: Game, acc: number) => {
    g.analysis = { x: { depth: 1, score: { cp: 0 }, pv: [] } };
    g.moves = [{ ply: 1, color: "w", san: "e4", uci: "e2e4", from: "e2", to: "e4", fenBefore: "x", fenAfter: "y", commentary: "", selfEval: null, selfEvalRaw: "", lines: [], illegalAttempts: [], offeredDraw: false, thinkMs: 1, ts: 0, analysis: { classification: "good", winBefore: 50, winAfter: 50, accuracy: acc, cpLoss: 0, evalAfter: { cp: 0 } } }, { ply: 2, color: "b", san: "e5", uci: "e7e5", from: "e7", to: "e5", fenBefore: "x", fenAfter: "y", commentary: "", selfEval: null, selfEvalRaw: "", lines: [], illegalAttempts: [], offeredDraw: false, thinkMs: 1, ts: 0, analysis: { classification: "good", winBefore: 50, winAfter: 50, accuracy: acc - 20, cpLoss: 0, evalAfter: { cp: 0 } } }] as Game["moves"];
  };
  for (let i = 0; i < 5; i++) {
    const g = made(`o${i}`, true);
    if (i === 0) open(g, 80);
    games.set(g.id, g);
  }
  const o = experimentReport("experiments");
  const oImage = o.arms.find((a) => a.key === "added")!;
  assert.equal(oImage.balancedAccuracy.value, 80);
  assert.equal(oImage.balancedAccuracy.ci, null, "one game with open positions isn't five");
  assert.equal(oImage.vsFirst!.balancedAccuracy!.clear, false);
  // Five wins in five: the range reaches the far end of the Wilson interval (57–100%), not ±22.
  assert.ok(oImage.score.ci! > 42 && oImage.score.ci! < 45, `five wins: ±${oImage.score.ci}`);
  games.clear();
}

const spare = await startSpare();
const { url, token } = spare;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, label: string) {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}\n${spare.output()}`);
}
const request = async (p: string, body?: unknown) => {
  const res = await fetch(url + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-admin-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
};
const A = { model: "claude-sonnet-5-5", effort: "high" };
const B = { model: "gpt-6-astra", effort: "high" };
const code = (g: Game, c: string, ply: number) => {
  const secret = readFileSync(path.join(spare.data, "board-code-secret.txt"), "utf8").trim();
  const h = createHmac("sha256", secret).update(`${g.id}|${c}|${ply}`).digest();
  return Array.from(h.subarray(0, 3), (b) => "ACDEFHJKMNPRTVWXY3479"[b % 21]).join("");
};

/** A chess MCP server for a seat, spoken to over stdio. */
function mcp(key: string) {
  const child = spawn(process.execPath, ["cli/chess-mcp.mjs"], { env: { ...process.env, AGENT_CHESS_KEY: key, AGENT_CHESS_URL: url }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const waiting = new Map<number, (v: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let id = 0;
  const call = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { call, stop: () => child.kill() };
}

try {
  // White sees only the picture and writes the position out; Black sees the text and the picture.
  const created = (await request("/api/games", { white: A, black: B, rated: false, seats: { w: { view: "image", reread: true }, b: { view: "added", reread: false } } })).json();
  const g: Game = created.game;
  assert.deepEqual(g.options?.seats, { w: { view: "image", reread: true }, b: { view: "added", reread: false } });
  const summary = (await request("/api/lobby")).json().games.find((x: { id: string }) => x.id === g.id);
  assert.deepEqual(summary.seats, g.options!.seats);
  const keys = Object.fromEntries(created.launch.tasks.map((t: { seat: string; prompt: string }) => [t.seat, /--key (\S+)/.exec(t.prompt)![1]]));
  const wPrompt = created.launch.tasks.find((t: { seat: string }) => t.seat === "w").prompt as string;
  assert.ok(wPrompt.includes("## The board picture") && wPrompt.includes("## Write out the position") && wPrompt.includes('"seen"') && wPrompt.includes("BOARD PICTURE line"), wPrompt);

  for (const seat of ["w", "b"]) assert.equal((await request("/api/agent/interview", { key: keys[seat], text: "Ready.", noWait: true })).status, 200);
  await until(async () => (await request(`/api/games/${g.id}`)).json().phase === "playing", "pregame gate");

  // White's turn: no FEN or diagram, the picture's file, and the reminder to write the position out.
  const turn = (await request("/api/agent/wait", { key: keys.w, noWait: true })).text;
  assert.ok(turn.includes("=== YOUR MOVE ===") && !turn.includes("FEN:") && !turn.includes("+-----") && turn.includes('as "position"'), turn);
  const picture = /^BOARD PICTURE: (.+\.png)$/m.exec(turn)?.[1];
  assert.ok(picture && existsSync(picture), turn);

  // Refused before the move: no code, a wrong code, then no position (a format slip, not counted), then a wrong one.
  const move = (extra: object) => request("/api/agent/move", { key: keys.w, noWait: true, turn: { move: "e4", commentary: "Centre.", eval: "+0.3", ...extra } });
  let r = await move({});
  assert.ok(r.status === 400 && r.text.includes("check code"), r.text);
  r = await move({ seen: "AAA" });
  assert.equal(r.status, 400);
  r = await move({ seen: code(g, "w", 0) });
  assert.ok(r.status === 400 && r.text.includes("`position` is required"), r.text);
  r = await move({ seen: code(g, "w", 0), position: { ...startPos, white: startPos.white.slice(1) } });
  assert.ok(r.status === 400 && r.text.includes("doesn't match the board"), r.text);
  r = await move({ seen: code(g, "w", 0), position: startPos });
  assert.equal(r.status, 200, r.text);
  const after: Game = (await request(`/api/games/${g.id}`)).json();
  assert.deepEqual(after.moves[0].checks, { code: 2, position: 1 });
  assert.equal(after.moves[0].illegalAttempts.length, 0, "a refusal isn't an illegal move");
  assert.ok(!after.pendingChecks?.w);

  // Black, through the chess tools: the text board and the picture, attached to the reply.
  const tools = mcp(keys.b);
  try {
    assert.equal((await tools.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result.serverInfo.name, "chess");
    const names = (await tools.call("tools/list")).result.tools.map((t: { name: string }) => t.name);
    assert.ok(["start", "wait", "move", "status", "accept_draw", "resign", "interview", "postgame"].every((n) => names.includes(n)), names.join());
    const start = (await tools.call("tools/call", { name: "start", arguments: {} })).result.content[0].text as string;
    assert.ok(start.includes("## Chess tools") && !start.includes("--key"), start);
    const status = (await tools.call("tools/call", { name: "status", arguments: {} })).result;
    const text = status.content[0].text as string;
    assert.ok(text.includes("FEN:") && text.includes("BOARD PICTURE: attached to this reply.") && !text.includes(".png"), text);
    assert.ok(text.includes("same way round as the diagram (White at the bottom)"), "Black's picture has White at the bottom too");
    assert.equal(status.content[1].type, "image");
    assert.equal(Buffer.from(status.content[1].data, "base64").subarray(1, 4).toString(), "PNG");
    // One call is the whole turn: the move goes in, it waits for White's reply, and the next position comes back with its picture.
    const moving = tools.call("tools/call", { name: "move", arguments: { move: "e5", commentary: "Symmetry.", eval: "0.0", seen: code(g, "b", 1) } });
    await until(async () => (await request(`/api/games/${g.id}`)).json().moves.length === 2, "Black's move through the tools");
    const pos2 = { white: startPos.white.map((p) => (p === "e2" ? "e4" : p)), black: startPos.black.map((p) => (p === "Pe7" ? "Pe5" : p)) };
    assert.equal((await move({ move: "Nf3", seen: code(g, "w", 2), position: pos2 })).status, 200);
    const moved = (await moving).result;
    assert.ok(!moved.isError && moved.content[0].text.startsWith("OK — played e5") && moved.content[0].text.includes("=== YOUR MOVE ==="), JSON.stringify(moved).slice(0, 400));
    assert.equal(moved.content[1]?.type, "image");
    const refused = (await tools.call("tools/call", { name: "move", arguments: { move: "Nc6", commentary: "x", eval: "0.0", seen: code(g, "b", 1) } })).result;
    assert.ok(refused.isError && refused.content[0].text.includes("check code"), JSON.stringify(refused));
  } finally {
    tools.stop();
  }

  // A rematch keeps each player's toggles with the player; a human seat never gets any.
  assert.equal((await request("/api/agent/resign", { key: keys.w, noWait: true })).status, 200);
  const re: Game = (await request(`/api/games/${g.id}/rematch`, {})).json().game;
  assert.deepEqual(re.options?.seats, { b: { view: "image", reread: true }, w: { view: "added", reread: false } });
  const vsHuman: Game = (await request("/api/games", { white: { human: true, name: "Tester" }, black: A, seats: { w: { view: "image", reread: true }, b: { view: "added", reread: false } } })).json().game;
  assert.deepEqual(vsHuman.options?.seats, { b: { view: "added", reread: false } });
  const plain: Game = (await request("/api/games", { white: A, black: B, seats: { w: { view: "text" }, b: {} } })).json().game;
  assert.equal(plain.options?.seats, undefined, "plain text on both seats isn't an experiment");

  // A split double round-robin: every pair gets A once each way, A on the same colour in both its games, the pairs alternating.
  const players = [A, B, { model: "claude-opus-5-5", effort: "high" }, { model: "gpt-6.1-sol", effort: "high" }];
  const t: Tournament = (await request("/api/tournaments", { name: "split", players, doubleRound: true, rated: false, setups: { a: { view: "added", reread: false }, b: { view: "text", reread: false } } })).json();
  assert.deepEqual(t.setups, { a: { view: "added", reread: false }, b: { view: "text", reread: false } });
  const aCount = new Map<string, number>();
  for (const p of t.pairings) {
    const back = t.pairings.find((q) => q.white === p.black && q.black === p.white)!;
    assert.equal(back.aSide, p.aSide);
    const aPlayer = p.aSide === "w" ? p.white : p.black;
    aCount.set(aPlayer, (aCount.get(aPlayer) ?? 0) + 1);
  }
  for (const pl of t.players) assert.equal(aCount.get(pl.id), players.length - 1, "each player gets A once against every opponent");
  const aWhite = t.pairings.filter((p) => p.aSide === "w").length;
  assert.ok(Math.abs(aWhite * 2 - t.pairings.length) <= 2, `A is White in about half the games (${aWhite} of ${t.pairings.length})`);
  const started = (await request(`/api/tournaments/${t.id}/next`, {})).json();
  const first: Game = started.started?.[0]?.game ?? started.game;
  const pairing = t.pairings.find((p) => p.white === first.white.id && p.black === first.black.id)!;
  const want = pairingSetups(t, pairing)!;
  assert.deepEqual({ w: first.options?.seats?.w ?? { view: "text", reread: false }, b: first.options?.seats?.b ?? { view: "text", reread: false } }, want);
  // Plain text against itself isn't an experiment; the same setup twice is everyone the same.
  assert.equal((await request("/api/tournaments", { name: "none", players, setups: { a: { view: "text" }, b: { view: "text" } } })).json().setups, undefined);
  assert.deepEqual((await request("/api/tournaments", { name: "same", players, setups: { a: { view: "image" }, b: { view: "image" } } })).json().setups, { a: { view: "image", reread: false } });

  // The report: scopes for the experiment tournament, and the arms (the one finished game isn't reviewed yet at depth 1, so maybe none).
  const report = (await request(`/api/experiments?scope=t:${t.id}`)).json();
  assert.equal(report.scope, `t:${t.id}`);
  assert.ok(report.scopes.some((s: { id: string }) => s.id === `t:${t.id}`));
  assert.equal((await request("/api/experiments?scope=nonsense")).json().scope, "experiments");

  console.log("PASS: board-view experiments");
} finally {
  await spare.stop();
}
