// Live streams (server/stream.ts, web/src/stream.ts): a viewer that starts from the whole object and applies every
// patch always holds exactly what the whole object would be, through random changes to a real game; nothing is
// sent when nothing changed; and what a patch doesn't touch stays the same object on the page.
//   node node_modules/tsx/dist/cli.mjs scripts/test-stream.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { current, forget, messageFor, type Shape } from "../server/stream";
import { applyPatch } from "../web/src/stream";

const SHAPE: Shape = { arrays: ["moves"], records: ["analysis"] };
const fixture = (f: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", f), "utf8"));
// A whole game (director-game.json) with a long move list (marks-game.json's).
const game = { ...fixture("director-game.json"), moves: fixture("marks-game.json").moves };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** A viewer reading the stream's messages the way the page does. */
function viewer() {
  let value: any = null;
  let v = 0;
  return {
    read(msg: string | null) {
      if (msg === null) return false;
      const lines = msg.trimEnd().split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
      const id = Number(lines.find((l) => l.startsWith("id: "))?.slice(4));
      const data = JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6));
      if (event === "patch") {
        assert.equal(data.base, v, "a patch only goes to a viewer on its base version");
        value = applyPatch(value, data);
        v = data.v;
      } else {
        value = data;
        v = id;
      }
      return true;
    },
    get value() {
      return value;
    },
    get v() {
      return v;
    },
  };
}

let seed = 7;
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
const g = clone(game);
const fens = Object.keys(g.analysis);
const a = viewer();
const b = viewer();
a.read(messageFor(0, current("game:x", g, SHAPE)));
let patches = 0;
let patchBytes = 0;
let fullBytes = 0;
for (let step = 0; step < 400; step++) {
  switch (rand(9)) {
    case 0: // a new move
      g.moves.push({ ...clone(g.moves[rand(g.moves.length)]), ply: g.moves.length + 1 });
      break;
    case 1: // a move's verdict arrives or changes
      g.moves[rand(g.moves.length)].analysis = { classification: ["best", "good", "blunder"][rand(3)], winBefore: rand(100), winAfter: rand(100), accuracy: rand(100), cpLoss: rand(300) };
      break;
    case 2: // an engine result
      g.analysis[`fen-${step}`] = { depth: 20, score: { cp: rand(400) - 200 }, pv: ["e2e4"] };
      break;
    case 3: // analysis retried (dropped)
      if (fens.length) delete g.analysis[fens.pop()!];
      break;
    case 4:
      g.phase = ["playing", "postgame", "finished"][rand(3)];
      break;
    case 5: // a field appears and goes
      if (g.clockPause) delete g.clockPause;
      else g.clockPause = { at: step, code: "manual", reason: "test" };
      break;
    case 6: // moves taken away (a shorter history: the array shrinks)
      if (g.moves.length > 5) g.moves.length -= 1;
      break;
    case 7: // nothing changed
      break;
    case 8:
      g.seen = { w: step, b: step + 1 };
      break;
  }
  const ver = current("game:x", g, SHAPE);
  const before = a.value;
  const msg = messageFor(a.v, ver);
  if (msg?.startsWith("event: patch")) {
    patches++;
    patchBytes += msg.length;
    fullBytes += ver.full().length;
  }
  const changed = a.read(msg);
  assert.deepEqual(a.value, clone(g), `step ${step}: the viewer holds the whole object`);
  if (!changed) assert.equal(a.value, before, "nothing sent when nothing changed");
  else if (msg?.startsWith("event: patch") && before.moves.length === a.value.moves.length) {
    const same = a.value.moves.filter((m: unknown, i: number) => m === before.moves[i]).length;
    assert.ok(same >= a.value.moves.length - 1, "untouched moves keep their identity");
  }
  // A viewer that misses versions gets the whole object again.
  if (step % 37 === 0) {
    b.read(messageFor(b.v, ver));
    assert.deepEqual(b.value, clone(g), `step ${step}: a late viewer catches up`);
  }
}
forget("game:x");
console.log(`${patches} patches, ${(patchBytes / patches).toFixed(0)} B each on average against ${(fullBytes / patches / 1024).toFixed(0)} KB for the whole game`);
console.log("ok");
