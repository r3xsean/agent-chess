// The public mirror on spare servers: a local spare pushes to a public-mode spare; after a game is created,
// played and resigned, the mirror has exactly the local games, ratings and tournaments (its own prediction
// cut-offs aside).
//   node scripts/test-mirror.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startSpare } from "./spare.mjs";

const secret = randomBytes(24).toString("hex");
const mirror = await startSpare({ env: { PUBLIC_MODE: "1", MIRROR_SECRET: secret } });
const local = await startSpare({ env: { MIRROR_URL: mirror.url, MIRROR_SECRET: secret } });
const H = { "content-type": "application/json", "x-admin-token": local.token };
const post = async (p, body) => {
  const r = await fetch(local.url + p, { method: "POST", headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  assert.ok(r.ok, `${p}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const get = async (base, p) => (await fetch(base + p)).json();
const strip = (g) => {
  const { mirrorCutoffs: _, ...rest } = g;
  return rest;
};
/** Wait for the mirror to have what the local server has. */
async function synced(what) {
  for (let n = 0; ; n++) {
    await new Promise((r) => setTimeout(r, 500));
    const [a, b] = await Promise.all([get(local.url, "/api/lobby"), get(mirror.url, "/api/lobby")]);
    try {
      assert.deepEqual(b, a, `lobby after ${what}`);
      for (const s of a.games) assert.deepEqual(strip(await get(mirror.url, `/api/games/${s.id}`)), await get(local.url, `/api/games/${s.id}`), `game ${s.id} after ${what}`);
      return;
    } catch (e) {
      if (n >= 20) throw e;
    }
  }
}

try {
  const created = await post("/api/games", { white: { model: "claude-opus-5-5", effort: "high" }, black: { model: "gpt-6-astra", effort: "high" } });
  const key = Object.fromEntries(created.launch.tasks.map((t) => [t.role, /--key (\S+)/.exec(t.prompt)?.[1]]));
  await synced("creating a game");
  for (const c of ["white", "black"]) await post("/api/agent/interview", { key: key[c], text: "Ready.", noWait: true });
  await new Promise((r) => setTimeout(r, 1200));
  for (const [i, move] of ["d4", "d5", "c4", "e6", "Nc3", "Nf6"].entries()) await post("/api/agent/move", { key: key[i % 2 ? "black" : "white"], turn: { move, commentary: `${move}.`, eval: "0.1" }, noWait: true });
  await synced("six moves");
  assert.equal((await get(mirror.url, `/api/games/${created.game.id}`)).moves.length, 6, "the mirror has the six moves");
  await post("/api/agent/resign", { key: key.black, noWait: true });
  await new Promise((r) => setTimeout(r, 1500));
  await synced("the resignation");
  assert.equal((await get(mirror.url, `/api/games/${created.game.id}`)).result, "1-0", "the mirror has the result");
  const status = await get(local.url, "/api/meta");
  assert.equal(status.mirror?.synced, true, "the local server reports the mirror in sync");
  console.log("ok");
} finally {
  await local.stop();
  await mirror.stop();
}
