// Live streams over HTTP on a spare server: a game played through the agent API, followed on its stream the way
// the page follows it (the whole game, then patches), always ends up equal to the game itself; the lobby's stream
// too. Prints how many bytes the stream took against sending the whole game each time.
//   node scripts/test-stream-http.mjs
import assert from "node:assert/strict";
import { startSpare } from "./spare.mjs";

const spare = await startSpare();
const H = { "content-type": "application/json", "x-admin-token": spare.token };
const post = async (p, body) => {
  const r = await fetch(spare.url + p, { method: "POST", headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** applyPatch from web/src/stream.ts (kept in step with it: test-stream.ts checks that one directly). */
function applyPatch(value, p) {
  const next = { ...value };
  for (const k of p.del) delete next[k];
  Object.assign(next, p.set);
  for (const [k, { len, at }] of Object.entries(p.arrays)) {
    const items = (next[k] ?? []).slice(0, len);
    for (const [i, item] of Object.entries(at)) items[Number(i)] = item;
    next[k] = items;
  }
  for (const [k, r] of Object.entries(p.records)) {
    const entries = { ...next[k], ...r.set };
    for (const ek of r.del) delete entries[ek];
    next[k] = entries;
  }
  return next;
}

/** Follow an SSE stream: the latest value, its version, and the bytes and messages received. */
function follow(url) {
  const s = { value: null, v: 0, bytes: 0, messages: 0, patches: 0, ac: new AbortController() };
  (async () => {
    const r = await fetch(url, { signal: s.ac.signal });
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      s.bytes += chunk.length;
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith(":")) continue;
        const lines = block.split("\n");
        const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
        const data = JSON.parse(lines.find((l) => l.startsWith("data: ")).slice(6));
        s.messages++;
        if (event === "patch") {
          assert.equal(data.base, s.v, "a patch comes for the version held");
          s.value = applyPatch(s.value, data);
          s.v = data.v;
          s.patches++;
        } else {
          s.value = data;
          s.v = Number(lines.find((l) => l.startsWith("id: "))?.slice(4)) || 0;
        }
      }
    }
  })().catch((e) => e.name !== "AbortError" && console.error(e));
  return s;
}
const settle = () => new Promise((r) => setTimeout(r, 400));

try {
  const created = await post("/api/games", { white: { model: "claude-opus-5-5", effort: "high" }, black: { model: "gpt-6-astra", effort: "high" } });
  const id = created.game.id;
  const key = Object.fromEntries(created.launch.tasks.map((t) => [t.role, /--key (\S+)/.exec(t.prompt)?.[1]]));
  const game = follow(`${spare.url}/api/games/${id}/stream`);
  const lobby = follow(`${spare.url}/api/lobby/stream`);
  // The engine's results land a little after each move: wait until the streams have caught up (or give up).
  const check = async (what) => {
    for (let n = 0; ; n++) {
      await settle();
      const want = await (await fetch(`${spare.url}/api/games/${id}`)).json();
      const lob = await (await fetch(`${spare.url}/api/lobby`)).json();
      // `seen` is stamped on every agent call without a change being announced (as ever): the stream carries it with the next change.
      const { seen: _a, ...got } = game.value ?? {};
      const { seen: _b, ...rest } = want;
      try {
        assert.deepEqual(got, rest, `game stream after ${what}`);
        assert.deepEqual(lobby.value, lob, `lobby stream after ${what}`);
        return;
      } catch (e) {
        if (n >= 7) throw e;
      }
    }
  };
  await check("connecting");
  for (const c of ["white", "black"]) await post("/api/agent/interview", { key: key[c], text: `Ready (${c}).`, noWait: true });
  await new Promise((r) => setTimeout(r, 1200)); // the clock tick starts play
  await check("the interviews");
  let fullBytes = 0;
  const line = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "Re1", "b5", "Bb3", "d6"];
  for (const [i, move] of line.entries()) {
    // White tries an illegal move first: the stream carries the pending attempt, then the move it ends up on.
    if (move === "Ba4") {
      await post("/api/agent/move", { key: key.white, turn: { move: "Qxf7", commentary: "Illegal try.", eval: "0" }, noWait: true });
      await check("an illegal try");
      assert.deepEqual(game.value.pendingIllegal.w, ["Qxf7"], "the pending attempt streamed");
    }
    await post("/api/agent/move", { key: key[i % 2 ? "black" : "white"], turn: { move, commentary: `Playing ${move}.`, eval: "+0.2" }, noWait: true });
    await check(`move ${move}`);
    fullBytes += JSON.stringify(game.value).length;
  }
  await post("/api/agent/resign", { key: key.white, noWait: true });
  await new Promise((r) => setTimeout(r, 1500)); // the engine's review (depth 1) and the result
  await check("the resignation");
  assert.ok(game.patches > 0, "changes came as patches");
  console.log(`game stream: ${game.messages} messages (${game.patches} patches), ${(game.bytes / 1024).toFixed(1)} KB; the whole game each time would have been ~${(fullBytes / 1024).toFixed(1)} KB for the moves alone`);
  console.log(`lobby stream: ${lobby.messages} messages (${lobby.patches} patches), ${(lobby.bytes / 1024).toFixed(1)} KB`);
  game.ac.abort();
  lobby.ac.abort();
  console.log("ok");
} finally {
  await spare.stop();
}
