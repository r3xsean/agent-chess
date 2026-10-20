// Rebuilds server/humanCurve.ts, the human reference the Chess.com estimate reads (server/chessCom.ts), from a
// Lichess database dump: how people play at each Lichess rapid rating, measured the way the app measures its
// agents (moveSample in server/analytics.ts).
//
//   curl -r 0-449999999 -o part.pgn.zst https://database.lichess.org/standard/lichess_db_standard_rated_YYYY-MM.pgn.zst
//   zstd -dc part.pgn.zst | node scripts/human-curve.mjs
//
// A partial dump is fine (zstd decodes the prefix and complains at the cut). About 450 MB holds ~45k analysed
// rapid games. Lichess answers 429 past ~6 connections at once; with curl -Z, separate each URL's -r with --next.
import { createInterface } from "node:readline";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BANDS = { from: 400, to: 3000, width: 100, minSides: 150 };

if (isMainThread) {
  const N = Math.max(1, availableParallelism() - 2);
  const workers = Array.from({ length: N }, () => new Worker(new URL(import.meta.url)));
  const sides = [];
  let sent = 0, done = 0, seen = 0, ended = false, rr = 0;
  const finish = () => {
    if (!ended || done !== sent) return;
    workers.forEach((w) => w.terminate());
    write(sides, seen, sent);
  };
  for (const w of workers) w.on("message", (s) => { sides.push(...s); done++; finish(); });

  let headers = [], moves = "", inMoves = false;
  const flush = () => {
    seen++;
    const h = headers.join("\n");
    const tc = /\[TimeControl "(\d+)\+(\d+)"\]/.exec(h);
    const est = tc ? Number(tc[1]) + 40 * Number(tc[2]) : 0;
    // Rapid as Lichess counts it (8 to 25 minutes, estimated over 40 moves), standard chess, with engine evals,
    // and people on both sides: a game with a bot (maia1, maia5, ...) says nothing about how people play.
    if (moves.includes("%eval") && est >= 480 && est < 1500 && !/\[Variant "(?!Standard)/.test(h) && !/Title "BOT"/.test(h)) {
      workers[rr++ % N].postMessage({ h, moves });
      sent++;
    }
    headers = []; moves = ""; inMoves = false;
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (line.startsWith("[")) { if (inMoves) flush(); headers.push(line); }
    else if (line.trim()) { inMoves = true; moves += line + " "; }
    else if (inMoves) flush();
  });
  rl.on("close", () => { if (inMoves) flush(); ended = true; finish(); });
} else {
  const { Chess } = await import("chess.js");
  const posKey = (fen) => fen.split(" ").slice(0, 4).join(" ");
  // Book moves are left out, as the review does (server/openings.ts): a move into a named line, while every move so far was too.
  const theory = new Set();
  const odir = path.join(ROOT, "vendor", "openings");
  for (const file of readdirSync(odir).filter((f) => f.endsWith(".tsv")))
    for (const row of readFileSync(path.join(odir, file), "utf8").split(/\r?\n/).slice(1)) {
      const pgn = row.split("\t")[2];
      if (!pgn) continue;
      const c = new Chess();
      for (const tok of pgn.split(/\s+/)) {
        if (!tok || /^\d+\.+$/.test(tok)) continue;
        try { c.move(tok.replace(/^\d+\.+/, "")); theory.add(posKey(c.fen())); } catch { break; }
      }
    }
  const parseEval = (txt) => {
    const m = /\[%eval (#?)(-?[\d.]+)/.exec(txt);
    return !m ? null : m[1] ? { mate: Number(m[2]) } : { cp: Math.round(Number(m[2]) * 100) };
  };
  const tag = (h, k) => new RegExp(`\\[${k} "([^"]*)"\\]`).exec(h)?.[1];
  const re = /(\d+\.(?:\.\.)?\s*)?([KQRBNOa-h][^\s{}]*)\s*(\{[^}]*\})?/g;

  function handle({ h, moves }) {
    const we = Number(tag(h, "WhiteElo")), be = Number(tag(h, "BlackElo"));
    if (!we || !be) return [];
    const c = new Chess();
    const sums = { w: empty(), b: empty() };
    let allBook = true, m, before = null;
    re.lastIndex = 0;
    const body = moves.replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/, "");
    while ((m = re.exec(body))) {
      const san = m[2].replace(/[?!]+$/, "");
      const color = c.turn();
      const forced = c.moves().length === 1;
      try { c.move(san); } catch { return []; }
      const after = m[3] ? parseEval(m[3]) : null;
      const book = allBook && theory.has(posKey(c.fen()));
      if (!book) allBook = false;
      if (!book && !forced && before && after) add(sums[color], color, before, after);
      before = after;
    }
    const out = [];
    for (const color of ["w", "b"]) if (sums[color].weight > 0) out.push({ elo: color === "w" ? we : be, ...sums[color] });
    return out;
  }
  parentPort.on("message", (g) => { let s = []; try { s = handle(g); } catch {} parentPort.postMessage(s); });
}

/* The same per-move weighting and losses as moveSample in server/analytics.ts, from the PGN's evals. */

const empty = () => ({ weight: 0, cpl: 0, blunders: 0, errors: 0 });
const cpW = (s) => Math.max(-1000, Math.min(1000, s.mate !== undefined ? (s.mate === 0 ? 0 : s.mate > 0 ? 10000 - s.mate : -10000 - s.mate) : s.cp));
const winW = (s) => (s.mate !== undefined && s.mate !== 0 ? (s.mate > 0 ? 1 : 0) : 1 / (1 + Math.exp(-0.00368208 * cpW(s))));

function add(sum, color, before, after) {
  const pov = (x) => (color === "w" ? x : 1 - x);
  const pBefore = pov(winW(before));
  const q = 4 * pBefore * (1 - pBefore);
  const drop = 100 * (pBefore - pov(winW(after)));
  const sign = color === "w" ? 1 : -1;
  sum.weight += q;
  sum.cpl += q * Math.max(0, sign * (cpW(before) - cpW(after)));
  if (drop > 20) sum.blunders += q;
  if (drop > 10) sum.errors += q;
}

/** Pool adjacent violators, weighted: the closest curve that only ever gets better with rating, so it can be read backwards. */
function monotone(ys, ws, better) {
  const blocks = [];
  ys.forEach((y, i) => {
    blocks.push({ s: y * better * ws[i], w: ws[i], n: 1 });
    while (blocks.length > 1 && blocks.at(-2).s / blocks.at(-2).w > blocks.at(-1).s / blocks.at(-1).w) {
      const b = blocks.pop();
      blocks.at(-1).s += b.s;
      blocks.at(-1).w += b.w;
      blocks.at(-1).n += b.n;
    }
  });
  return blocks.flatMap((b) => Array(b.n).fill((b.s / b.w) * better));
}

function write(sides, seen, analysed) {
  const bands = [];
  for (let lo = BANDS.from; lo < BANDS.to; lo += BANDS.width) {
    const xs = sides.filter((s) => s.elo >= lo && s.elo < lo + BANDS.width);
    if (xs.length < BANDS.minSides) continue;
    const total = (k) => xs.reduce((a, s) => a + s[k], 0);
    const weight = total("weight");
    bands.push({ elo: lo + BANDS.width / 2, sides: xs.length, acpl: total("cpl") / weight, blunders: (100 * total("blunders")) / weight, errors: (100 * total("errors")) / weight });
  }
  const ws = bands.map((b) => b.sides);
  const fit = { acpl: monotone(bands.map((b) => b.acpl), ws, -1), blunders: monotone(bands.map((b) => b.blunders), ws, -1), errors: monotone(bands.map((b) => b.errors), ws, -1) };
  const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  const rows = bands.map((b, i) => `  { elo: ${b.elo}, sides: ${b.sides}, acpl: ${r(fit.acpl[i], 1)}, blunders: ${r(fit.blunders[i], 2)}, errors: ${r(fit.errors[i], 2)} },`);
  const ts = `// Generated by scripts/human-curve.mjs from ${sides.length} Lichess rapid player-games (${analysed} analysed games of ${seen} read). Don't edit by hand.

/**
 * How people play at each Lichess rapid rating (band centre), each move weighted by how open the position was
 * (4·p·(1−p) on the mover's winning chances), smoothed so each column only improves with rating.
 */
export interface HumanBand {
  elo: number;
  sides: number;
  /** Mean centipawn loss per move. */
  acpl: number;
  /** Blunders (a drop of over 20 win-% points), and blunders plus mistakes (over 10), per 100 moves. */
  blunders: number;
  errors: number;
}

export const HUMAN_RAPID: HumanBand[] = [
${rows.join("\n")}
];
`;
  writeFileSync(path.join(ROOT, "server", "humanCurve.ts"), ts);
  console.log(`server/humanCurve.ts: ${bands.length} bands from ${sides.length} player-games`);
}
