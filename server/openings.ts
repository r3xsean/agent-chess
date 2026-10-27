import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import { ROOT } from "./paths";

/** Position key without move counters, so transpositions match. */
export const posKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

const book = new Map<string, { eco: string; name: string }>();
const theory = new Set<string>();

/** Bump when what's compiled from the TSVs changes, so caches built the old way are rebuilt. */
const COMPILED_VERSION = 1;
/** The compiled book, so a start reads it instead of replaying every line (seconds) again. Rebuilt whenever the TSVs change. */
const CACHE_FILE = path.join(ROOT, "node_modules", ".cache", "agent-chess", "openings.json");

interface Compiled {
  key: string;
  book: [string, string, string][];
  theory: string[];
}

export function loadOpenings() {
  const dir = path.join(ROOT, "vendor", "openings");
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsv"));
  const texts = files.map((f) => readFileSync(path.join(dir, f), "utf8"));
  const hash = createHash("sha1").update(`${COMPILED_VERSION}|${chessJsVersion()}`);
  files.forEach((f, i) => hash.update(`\0${f}\0${texts[i]}`));
  const key = hash.digest("hex");
  let compiled: Compiled | null = null;
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Compiled;
    if (c.key === key) compiled = c;
  } catch {}
  if (!compiled) {
    compiled = { key, ...compile(texts) };
    try {
      mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE + ".tmp", JSON.stringify(compiled));
      renameSync(CACHE_FILE + ".tmp", CACHE_FILE);
    } catch {} // a read-only install just compiles every time
  }
  book.clear();
  theory.clear();
  for (const [k, eco, name] of compiled.book) book.set(k, { eco, name });
  for (const k of compiled.theory) theory.add(k);
  console.log(`[openings] ${book.size} book positions`);
}

function chessJsVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, "node_modules", "chess.js", "package.json"), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

interface Node {
  children: Map<string, Node>;
  /** The rows (by file order) whose line ends here. */
  rows: number[];
}

/**
 * Every named line, replayed once as a tree: lines sharing moves share their replay, on one board played forward
 * and taken back. A line with a move that won't play is left out whole, as loading its PGN would fail. Every
 * position along a named line counts as theory; a position named by several lines keeps the longest name (the
 * first of equals in file order).
 */
export function compile(texts: string[]): { book: [string, string, string][]; theory: string[] } {
  const rows: { eco: string; name: string }[] = [];
  const root: Node = { children: new Map(), rows: [] };
  for (const text of texts) {
    for (const row of text.split(/\r?\n/).slice(1)) {
      const [eco, name, pgn] = row.split("\t");
      if (!pgn) continue;
      const sans = pgn.split(/\s+/).filter((t) => t && !/^\d+\.+$/.test(t));
      if (!sans.length) continue;
      let node = root;
      for (const san of sans) {
        let next = node.children.get(san);
        if (!next) node.children.set(san, (next = { children: new Map(), rows: [] }));
        node = next;
      }
      node.rows.push(rows.length);
      rows.push({ eco, name });
    }
  }
  const named = new Map<string, number>();
  const seen = new Set<string>();
  const c = new Chess();
  /** Whether any line that plays through here is whole. */
  const walk = (node: Node): boolean => {
    let whole = node.rows.length > 0;
    for (const [san, child] of node.children) {
      try {
        c.move(san);
      } catch {
        continue;
      }
      const k = posKey(c.fen());
      if (walk(child)) {
        seen.add(k);
        whole = true;
      }
      for (const r of child.rows) {
        const prev = named.get(k);
        const better = prev === undefined || rows[r].name.length > rows[prev].name.length || (rows[r].name.length === rows[prev].name.length && r < prev);
        if (better) named.set(k, r);
      }
      c.undo();
    }
    return whole;
  };
  walk(root);
  return { book: [...named].map(([k, r]) => [k, rows[r].eco, rows[r].name]), theory: [...seen] };
}

export const lookupOpening = (fen: string) => book.get(posKey(fen));
export const isTheory = (fen: string) => theory.has(posKey(fen));
