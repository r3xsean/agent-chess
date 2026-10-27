// The compiled opening book (server/openings.ts) against the way it was always built: every row's PGN loaded and
// replayed on its own. Same names for the same positions, same theory, and a start that reads the cache.
//   node node_modules/tsx/dist/cli.mjs scripts/test-openings.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import { compile, isTheory, loadOpenings, lookupOpening, posKey } from "../server/openings";

const dir = path.join(import.meta.dirname, "..", "vendor", "openings");
const texts = readdirSync(dir)
  .filter((f) => f.endsWith(".tsv"))
  .map((f) => readFileSync(path.join(dir, f), "utf8"));

/** The original loader, kept here as the reference. */
function reference(texts: string[]) {
  const book = new Map<string, { eco: string; name: string }>();
  const theory = new Set<string>();
  for (const text of texts) {
    for (const row of text.split(/\r?\n/).slice(1)) {
      const [eco, name, pgn] = row.split("\t");
      if (!pgn) continue;
      const c = new Chess();
      try {
        c.loadPgn(pgn);
      } catch {
        continue;
      }
      const replay = new Chess();
      for (const san of c.history()) {
        replay.move(san);
        theory.add(posKey(replay.fen()));
      }
      const key = posKey(c.fen());
      const prev = book.get(key);
      if (!prev || name.length > prev.name.length) book.set(key, { eco, name });
    }
  }
  return { book, theory };
}

const check = (got: ReturnType<typeof compile>, want: ReturnType<typeof reference>, what: string) => {
  assert.equal(got.book.length, want.book.size, `${what}: book size`);
  for (const [k, eco, name] of got.book) assert.deepEqual({ eco, name }, want.book.get(k), `${what}: book entry ${k}`);
  assert.equal(got.theory.length, want.theory.size, `${what}: theory size`);
  for (const k of got.theory) assert.ok(want.theory.has(k), `${what}: theory ${k}`);
};

let t = performance.now();
const want = reference(texts);
const refMs = performance.now() - t;
t = performance.now();
check(compile(texts), want, "real book");
const newMs = performance.now() - t;
console.log(`real book: ${want.book.size} named, ${want.theory.size} theory — reference ${refMs.toFixed(0)} ms, compiled ${newMs.toFixed(0)} ms`);

// Lines that won't play are left out whole (their earlier positions aren't theory through them); ties keep the first.
const odd = [
  "eco\tname\tpgn\nA00\tGood\t1. e4 e5\nA00\tBroken\t1. d4 Ke7\nA00\tSame length\t1. e4 e5\nB00\tLonger name here\t1. e4\nB00\tNo pgn\t\nC00\tTransposed\t1. Nf3 Nf6 2. e4 e5\nC00\tThe other order\t1. e4 e5 2. Nf3 Nf6\n",
];
check(compile(odd), reference(odd), "odd rows");
assert.ok(!compile(odd).theory.includes(posKey(new Chess().move("d4").after)), "a broken line's first move isn't theory");

// Loading: the first start compiles (and caches), the next reads the cache; both give the same lookups.
loadOpenings();
t = performance.now();
loadOpenings();
const cachedMs = performance.now() - t;
const sample = [...want.book.keys()].slice(0, 200);
for (const k of sample) assert.deepEqual(lookupOpening(`${k} 0 1`), want.book.get(k));
for (const k of [...want.theory].slice(0, 200)) assert.ok(isTheory(`${k} 0 1`));
assert.equal(lookupOpening("8/8/8/8/8/8/8/K6k w - - 0 1"), undefined);
console.log(`cached load: ${cachedMs.toFixed(0)} ms`);
console.log("ok");
