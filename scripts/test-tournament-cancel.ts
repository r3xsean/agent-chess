// Cancelling a tournament over HTTP, on an isolated spare server: never touches live games or calls a model.
import assert from "node:assert/strict";
import type { Tournament } from "../shared/types";
import { startSpare } from "./spare.mjs";

const spare = await startSpare();
const { url, token } = spare;
const request = async (p: string, body?: unknown) => {
  const res = await fetch(url + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-admin-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
};
const players = [
  { model: "claude-sonnet-5-5", effort: "high" },
  { model: "gpt-6-astra", effort: "high" },
  { model: "claude-opus-5-5", effort: "high" },
  { model: "gpt-6-luna", effort: "high" },
];

try {
  const t: Tournament = (await request("/api/tournaments", { name: "cancel", players, boards: 2 })).json();
  const started = (await request(`/api/tournaments/${t.id}/next`, {})).json().started.map((s: { game: { id: string } }) => s.game.id);
  assert.equal(started.length, 2);

  // Only an admin can cancel.
  assert.equal((await fetch(`${url}/api/tournaments/${t.id}/cancel`, { method: "POST" })).status, 400);
  const res = (await request(`/api/tournaments/${t.id}/cancel`, {})).json();
  assert.deepEqual(res.aborted.sort(), [...started].sort());
  for (const id of started) {
    const g = (await request(`/api/games/${id}`)).json();
    assert.equal(g.phase, "finished");
    assert.equal(g.termination, "aborted");
  }
  const after = (await request(`/api/tournaments/${t.id}`)).json();
  assert.equal(after.tournament.status, "finished");
  assert.ok(after.tournament.cancelledAt);
  assert.deepEqual(after.next, []);
  // Nothing more starts, by hand or by the orchestrator, and it can't be cancelled or started twice.
  assert.deepEqual((await request(`/api/tournaments/${t.id}/next`, {})).json(), { finished: true });
  assert.match((await request("/api/orchestrator/brief", { action: "tournament-next", tournamentId: t.id, source: "chat" })).text, /is over/);
  assert.equal((await request(`/api/tournaments/${t.id}/cancel`, {})).status, 400);
  assert.equal((await request(`/api/tournaments/${t.id}/start`, {})).status, 400);
  assert.equal((await request(`/api/tournaments/${t.id}`)).json().tournament.pairings.filter((p: { gameId?: string }) => p.gameId).length, 2);

  console.log("PASS: tournament cancel over HTTP");
} finally {
  await spare.stop();
}
