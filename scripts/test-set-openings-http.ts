// Set openings through the HTTP API, on an isolated spare server: never touches live games or calls a model.
import assert from "node:assert/strict";
import type { Game, Tournament } from "../shared/types";
import { startSpare } from "./spare.mjs";

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

try {
  // "Next for this pair" is what a new game with `opening: true` gets.
  const next = (await request("/api/openings/stats", { white: A, black: B })).json();
  assert.equal(next.openings.length, 14);
  assert.equal((await request("/api/openings/stats", {})).json().next, null);
  const created = (await request("/api/games", { white: A, black: B, opening: true })).json();
  const g: Game = created.game;
  assert.equal(g.setOpening?.id, next.next);
  assert.ok(g.moves.length > 0 && g.moves.every((m) => m.supplied));
  const lobby = (await request("/api/lobby")).json();
  assert.equal(lobby.games.find((x: { id: string }) => x.id === g.id).setOpening, g.setOpening!.name);

  // The players' first turn: the side to move after the arena's moves gets YOUR MOVE.
  const keys = Object.fromEntries(created.launch.tasks.map((t: { seat: string; prompt: string }) => [t.seat, /--key (\S+)/.exec(t.prompt)![1]]));
  const pre = (await request("/api/agent/wait", { key: keys.w, noWait: true })).text;
  assert.ok(pre.includes("PRE-GAME") && pre.includes("The arena played") && !pre.includes(g.setOpening!.name), pre);
  for (const seat of ["w", "b"]) assert.equal((await request("/api/agent/interview", { key: keys[seat], text: "Ready.", noWait: true })).status, 200);
  const toMove = g.moves.length % 2 ? "b" : "w";
  await until(async () => (await request(`/api/games/${g.id}`)).json().phase === "playing", "pregame gate");
  const turn = (await request("/api/agent/wait", { key: keys[toMove], noWait: true })).text;
  assert.ok(turn.includes("=== YOUR MOVE ===") && turn.includes("set by the arena") && !turn.includes(g.setOpening!.name), turn);

  // Chess960 wins over a set opening; an unknown opening is refused.
  const c960: Game = (await request("/api/games", { white: A, black: B, chess960: 518, opening: true })).json().game;
  assert.ok(!c960.setOpening && c960.variant === "chess960" && c960.moves.length === 0);
  assert.equal((await request("/api/games", { white: A, black: B, opening: "najdorf" })).status, 400);

  // A rematch swaps the colours and keeps the opening; only a finished game has one.
  assert.equal((await request(`/api/games/${g.id}/rematch`, {})).status, 400);
  assert.equal((await request("/api/agent/resign", { key: keys[toMove], noWait: true })).status, 200);
  const re: Game = (await request(`/api/games/${g.id}/rematch`, {})).json().game;
  assert.equal(re.white.id, g.black.id);
  assert.equal(re.black.id, g.white.id);
  assert.equal(re.setOpening?.id, g.setOpening!.id);

  // A double round-robin: each pairing's opening, replayed by its return game with the colours swapped.
  const players = [A, B, { model: "claude-opus-5-5", effort: "high" }];
  const t: Tournament = (await request("/api/tournaments", { name: "openings", players, doubleRound: true, openings: "each" })).json();
  assert.equal(t.openings, "each");
  for (const p of t.pairings) {
    assert.ok(p.opening);
    const back = t.pairings.find((q) => q.white === p.black && q.black === p.white)!;
    assert.equal(back.opening, p.opening);
  }
  const themed: Tournament = (await request("/api/tournaments", { name: "french", players, openings: "french" })).json();
  assert.ok(themed.pairings.every((p) => p.opening === "french"));
  assert.equal((await request("/api/tournaments", { name: "bad", players, openings: "najdorf" })).status, 400);

  // The Agents tab filters by how games started.
  for (const start of ["all", "free", "set"]) assert.equal((await request(`/api/analytics?start=${start}`)).status, 200);
  assert.ok(Array.isArray((await request("/api/analytics/openings?start=set")).json().rows), "the openings grid isn't taken for a model");

  console.log("PASS: set openings over HTTP");
} finally {
  await spare.stop();
}
