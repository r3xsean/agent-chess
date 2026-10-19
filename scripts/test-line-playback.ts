// Run: npx tsx scripts/test-line-playback.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkedLine } from "../server/director";
import { planLine } from "../shared/engineLine";
import type { Game } from "../shared/types";
import { lineSig, lineVoice, videoLines } from "../shared/videoLines";
import { VOICE_RATE, type VoiceManifest } from "../shared/voices";
import { buildTimeline, LINE_SLIDE, sfxCues, VOICE_AT } from "../web/src/video/timeline";
import { lineTransition, rewindFrame } from "../web/src/video/linePlayback";

const g: Game = JSON.parse(readFileSync(new URL("./fixtures/line-game.json", import.meta.url), "utf8"));
const m = g.moves[0];
const raw = { kind: "instead", end: 3, beats: [
  { at: "start", text: "Look at that bar. Rewind and look again. Knight takes f5.", enter: "Rewind", cues: [{ words: "Knight", moves: 1 }] },
] };
const parse = (r: unknown) => checkedLine(g, m.ply, r)!;
g.video!.moments[0].line = parse(raw);
assert.equal(g.video!.moments[0].line!.beats![0].enter, 4);
assert.throws(() => parse({ ...raw, beats: [{ ...raw.beats[0], enter: "Missing" }] }), /exactly/);
assert.throws(() => parse({ ...raw, beats: [{ ...raw.beats[0], at: 1 }] }), /first beat/);
assert.throws(() => parse({ ...raw, beats: [{ at: 0, text: "Wait." }, raw.beats[0]] }), /first beat/);
assert.throws(() => parse({ ...raw, beats: [{ ...raw.beats[0], cues: [{ words: "Look", moves: 1 }] }] }), /after the engine entry/);
assert.throws(() => parse({ ...raw, punish: { caption: "A punishment." } }), /punishment opening/);

// Synthetic recorded timings: test actual word alignment, independent of any paid service/cache.
const voiceLine = videoLines(g).find(l => l.narrator)!;
const voice: VoiceManifest = { clips: { [voiceLine.id]: {
  url: "/test.mp3", dur: 7, words: [0, .2, .4, .6, 2.3, 2.6, 2.8, 3, 3.3, 4, 4.2, 4.4],
  sig: lineSig(lineVoice(g, voiceLine)!, voiceLine),
} } };

for (const format of ["landscape", "portrait"] as const) {
  for (const first of [false, true]) {
    g.video!.moments[0].importance = 3;
    g.video!.moments[0].line!.first = first;
    const tl = buildTimeline(g, format, { voice });
    const s = tl.scenes.find(s => s.kind === "line")!;
    assert.equal(s.kind, "line");
    if (s.kind !== "line") throw new Error("Missing line");
    const line = planLine(g, 0, g.video!.moments[0].line!)!;
    assert.ok(Math.abs(s.enterAt - (s.beats![0].at + VOICE_AT + 2.3 / VOICE_RATE[format])) < 1e-8);
    assert.equal(lineTransition(s, m, line, s.enterAt - .001)!.fen, first ? m.fenBefore : m.fenAfter);
    if (!first) {
      const entry = lineTransition(s, m, line, (s.enterAt + s.readyAt) / 2)!;
      assert.equal(entry.phase, "enter");
      assert.ok(Math.abs(entry.progress! - .5) < 1e-8);
    }
    assert.ok(s.moveAt[0] >= s.readyAt);
    assert.ok(s.back[0] > s.moveAt.at(-1)! + LINE_SLIDE);
    assert.ok(s.back[1] - s.back[0] <= 1.2);
    const step = (s.back[1] - s.back[0]) / line.moves.length;
    for (let j = 0; j < line.moves.length; j++) {
      const f = lineTransition(s, m, line, s.back[0] + (j + .5) * step)!;
      assert.equal(f.phase, "rewind");
      assert.equal(f.fen, line.moves[line.moves.length - 1 - j].after);
      assert.ok(Math.abs(f.progress! - .5) < 1e-8);
    }
    if (!first) assert.equal(lineTransition(s, m, line, (s.back[1] + s.restoreEnd) / 2)!.phase, "restore");
    const done = lineTransition(s, m, line, s.dur - .001)!;
    assert.equal(done.fen, first ? m.fenBefore : m.fenAfter);
    assert.equal(done.phase, "done");
    // Seeking backwards must give the same frame; no timer/playback-history dependency.
    assert.deepEqual(lineTransition(s, m, line, s.enterAt - .001), lineTransition(s, m, line, s.enterAt - .001));
    const effects = sfxCues(tl, g);
    assert.ok(effects.some(c => c.ev === "transition" && c.t === s.start + s.enterAt));
    assert.ok(effects.every(c => Number.isFinite(c.t) && c.t <= tl.duration));
    // A continuation branches after the real move: unwind to that position without replaying it.
    const continuation = { ...s, line: "after" as const, first: false, restoreEnd: s.back[1] };
    assert.equal(lineTransition(continuation, m, { ...line, fen: m.fenAfter }, s.dur)!.fen, m.fenAfter);
  }
}
g.video!.moments[0].line = parse({ kind: "instead", end: 3 });
const legacy = buildTimeline(g, "landscape").scenes.find(s => s.kind === "line")!;
assert.equal(legacy.kind === "line" && legacy.enterAt, 0);
const line = planLine(g, 0, g.video!.moments[0].line!)!;
assert.equal(rewindFrame(line.moves, [0, 1], 1).count, 0);
console.log("Line playback: cue validation, recorded word timing, both formats, entry/return order, immediate-entry compatibility passed.");
