import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import { ROOT } from "./paths";

/** Position key without move counters, so transpositions match. */
export const posKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

const book = new Map<string, { eco: string; name: string }>();
const theory = new Set<string>();

export function loadOpenings() {
  const dir = path.join(ROOT, "vendor", "openings");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsv"))) {
    const rows = readFileSync(path.join(dir, file), "utf8").split(/\r?\n/).slice(1);
    for (const row of rows) {
      const [eco, name, pgn] = row.split("\t");
      if (!pgn) continue;
      const c = new Chess();
      try {
        c.loadPgn(pgn);
      } catch {
        continue;
      }
      // Every position along a named line counts as theory.
      const replay = new Chess();
      for (const san of c.history()) {
        replay.move(san);
        theory.add(posKey(replay.fen()));
      }
      const key = posKey(c.fen());
      // Prefer the longest (most specific) name for a position.
      const prev = book.get(key);
      if (!prev || name.length > prev.name.length) book.set(key, { eco, name });
    }
  }
  console.log(`[openings] ${book.size} book positions`);
}

export const lookupOpening = (fen: string) => book.get(posKey(fen));
export const isTheory = (fen: string) => theory.has(posKey(fen));
