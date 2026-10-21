// Rebuilds server/humanCurve.ts, the human reference the Chess.com estimate reads (server/chessCom.ts): how
// people play at each Lichess rapid rating, measured the way the app measures its agents (moveSample in
// server/analytics.ts). One pass over a Lichess month, streamed, so the 30 GB dump is never stored whole:
//
//   node scripts/human-curve.mjs https://database.lichess.org/standard/lichess_db_standard_rated_YYYY-MM.pgn.zst
//   node scripts/human-curve.mjs part.pgn.zst          (a local dump, or a prefix of one)
//   node scripts/human-curve.mjs --tables tables.json  (just write humanCurve.ts from a run's tables)
//
// A month takes about four hours (the parsing, not the download) and leaves its tables in human-curve-tables.json.
// Players whose name hashes into the held-out tenth are left out, as they were when the estimate was checked, so
// the next check still has people the tables never saw.
import { createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { availableParallelism, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { zstdDecompress, constants as zconst } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BANDS = 26; // 400..2999 in 100s, the ends clamped
const PHASES = ["opening", "middlegame", "endgame"];
const MIN_SIDES = 150;

if (isMainThread) {
  const args = process.argv.slice(2);
  if (args[0] === "--tables") {
    emit(JSON.parse(readFileSync(args[1], "utf8")));
    process.exit(0);
  }
  const src = args[0];
  const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
  const N = Math.max(1, availableParallelism() - 3);
  const workers = Array.from({ length: N }, () => new Worker(new URL(import.meta.url)));
  let inflight = 0, sent = 0, seen = 0, rr = 0, fed = 0;
  for (const w of workers) w.on("message", (m) => { if (m === "done1") inflight--; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  setInterval(() => log(`${(fed / 2 ** 30).toFixed(2)} GiB read, ${seen} games, ${sent} analysed rapid`), 60000).unref();

  // Split games; keep analysed rapid games between people (a game with a bot says nothing about how people play).
  const dec = new StringDecoder("utf8");
  let buf = "";
  const take = (game) => {
    seen++;
    if (!game.includes("%eval") || /Title "BOT"/.test(game)) return;
    const tc = /\[TimeControl "(\d+)\+(\d+)"\]/.exec(game);
    const est = tc ? Number(tc[1]) + 40 * Number(tc[2]) : 0;
    if (est < 480 || est >= 1500 || /\[Variant "(?!Standard)/.test(game)) return;
    workers[rr++ % N].postMessage(game);
    sent++;
    inflight++;
  };
  function text(s) {
    buf += s;
    let i, from = 0;
    while ((i = buf.indexOf("\n\n[Event ", from + 1)) !== -1) { take(buf.slice(from, i)); from = i + 2; }
    buf = buf.slice(from);
  }

  // Lichess dumps are pzstd output: every zstd frame comes after a skippable frame (magic 0x184D2A50, 4-byte
  // payload) holding its compressed size. Node's decoder rejects skippable frames, so frames are split out here
  // and each decompressed on its own. No new frame is decoded while the workers are behind.
  const unzstd = (frame) => new Promise((res, rej) => zstdDecompress(frame, { params: { [zconst.ZSTD_d_windowLogMax]: 31 } }, (e, r) => (e ? rej(e) : res(r))));
  let pend = Buffer.alloc(0);
  async function feed(bytes) {
    pend = pend.length ? Buffer.concat([pend, bytes]) : bytes;
    while (pend.length >= 12) {
      if (pend.readUInt32LE(0) !== 0x184d2a50) throw new Error(`no skippable frame ${fed} bytes in`);
      const skip = pend.readUInt32LE(4), size = pend.readUInt32LE(8);
      if (pend.length < 8 + skip + size) break;
      const frame = pend.subarray(8 + skip, 8 + skip + size);
      pend = pend.subarray(8 + skip + size);
      text(dec.write(await unzstd(frame)));
      while (inflight > 3000) await sleep(50);
    }
  }
  const feedFile = async (file) => { for await (const d of createReadStream(file, { highWaterMark: 4 << 20 })) await feed(d); fed += statSync(file).size; };

  if (/^https?:/.test(src)) {
    // Byte ranges in parallel, fed in order. Lichess answers 429 past ~6 connections, so 4, with backoff, and a
    // stalled request (no bytes for a minute) is dropped and asked again.
    const dir = path.join(tmpdir(), `human-curve-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    let total = 0;
    for (let attempt = 0; ; attempt++) {
      const head = await fetch(src, { method: "HEAD", signal: AbortSignal.timeout(30000) }).catch((e) => ({ status: e.message }));
      if (head.status === 200) { total = Number(head.headers.get("content-length")); break; }
      log(`HEAD: ${head.status}`);
      await sleep(Math.min(300000, 15000 * 2 ** attempt));
    }
    const CHUNK = 48 << 20, WINDOW = 8, CONC = 4;
    const n = Math.ceil(total / CHUNK);
    const ready = Array(n).fill(false);
    const file = (i) => path.join(dir, `chunk-${i}`);
    let next = 0, active = 0, feeding = 0;
    async function get(i) {
      const a = i * CHUNK, b = Math.min(total, a + CHUNK) - 1;
      for (let attempt = 0; ; attempt++) {
        const ac = new AbortController();
        let timer;
        const alive = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new Error("stalled")), 60000); };
        alive();
        try {
          const r = await fetch(src, { headers: { Range: `bytes=${a}-${b}` }, signal: ac.signal });
          if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
          const body = Readable.fromWeb(r.body);
          body.on("data", alive);
          await pipeline(body, createWriteStream(file(i)));
          if (statSync(file(i)).size !== b - a + 1) throw new Error("short chunk");
          return;
        } catch (e) {
          log(`chunk ${i}: ${e.message}`);
          await sleep(Math.min(300000, 15000 * 2 ** attempt));
        } finally {
          clearTimeout(timer);
        }
      }
    }
    const pump = () => {
      while (active < CONC && next < n && next < feeding + WINDOW) {
        const i = next++;
        active++;
        get(i).then(() => { ready[i] = true; active--; pump(); });
      }
    };
    pump();
    for (feeding = 0; feeding < n; feeding++) {
      while (!ready[feeding]) await sleep(200);
      await feedFile(file(feeding));
      unlinkSync(file(feeding));
      pump();
    }
  } else {
    await feedFile(src);
  }
  text(dec.end());
  if (buf.trim()) take(buf);
  log(`read ${seen} games, ${sent} analysed rapid`);
  while (inflight > 0) await sleep(500);
  const parts = await Promise.all(workers.map((w) => new Promise((res) => { w.once("message", res); w.postMessage("flush"); })));
  const tables = { games: seen, analysed: sent, curve: {} };
  for (const t of parts) {
    for (const [k, v] of Object.entries(t.curve)) { const m = (tables.curve[k] ??= [0, 0, 0, 0, 0]); v.forEach((x, j) => (m[j] += x)); }
  }
  writeFileSync("human-curve-tables.json", JSON.stringify(tables));
  emit(tables);
  process.exit(0);
} else {
  const { Chess } = await import("chess.js");
  const posKey = (fen) => fen.split(" ").slice(0, 4).join(" ");
  // Book moves are left out, as the review does (server/openings.ts): a move into a named line, while every move so far was too.
  const theory = new Set();
  const odir = path.join(ROOT, "vendor", "openings");
  for (const f of readdirSync(odir).filter((x) => x.endsWith(".tsv")))
    for (const row of readFileSync(path.join(odir, f), "utf8").split(/\r?\n/).slice(1)) {
      const pgn = row.split("\t")[2];
      if (!pgn) continue;
      const c = new Chess();
      for (const tok of pgn.split(/\s+/)) {
        if (!tok || /^\d+\.+$/.test(tok)) continue;
        try { c.move(tok.replace(/^\d+\.+/, "")); theory.add(posKey(c.fen())); } catch { break; }
      }
    }
  const curve = {};
  const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return h >>> 0; };
  const heldOut = (name) => fnv(name.toLowerCase()) % 10 === 0;
  const band = (elo) => Math.max(0, Math.min(BANDS - 1, Math.floor((elo - 400) / 100)));
  const cpW = (s) => Math.max(-1000, Math.min(1000, s.mate !== undefined ? (s.mate > 0 ? 10000 - s.mate : -10000 - s.mate) : s.cp));
  const winW = (s) => (s.mate !== undefined ? (s.mate > 0 ? 1 : 0) : 1 / (1 + Math.exp(-0.00368208 * cpW(s))));
  const tag = (g, k) => new RegExp(`\\[${k} "([^"]*)"\\]`).exec(g)?.[1];
  const ev = (t) => { const m = /\[%eval (#?)(-?[\d.]+)/.exec(t); return !m ? null : m[1] ? { mate: Number(m[2]) } : { cp: Math.round(Number(m[2]) * 100) }; };
  const re = /(\d+\.(?:\.\.)?\s*)?([KQRBNOa-h][^\s{}]*)\s*(\{[^}]*\})?/g;

  function game(g) {
    const W = tag(g, "White"), B = tag(g, "Black");
    const elo = { w: Number(tag(g, "WhiteElo")), b: Number(tag(g, "BlackElo")) };
    if (!W || !B || !elo.w || !elo.b || heldOut(W) || heldOut(B)) return;
    const body = g.slice(g.indexOf("\n\n") + 2).replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/, "");
    const c = new Chess();
    const sums = { w: PHASES.map(() => [0, 0, 0, 0]), b: PHASES.map(() => [0, 0, 0, 0]) };
    // Pieces other than kings and pawns (the phase rule, phaseOf in analytics.ts), kept up from captures and promotions.
    let allBook = true, m, before = null, ply = 0, pieces = 14;
    re.lastIndex = 0;
    while ((m = re.exec(body))) {
      const san = m[2].replace(/[?!]+$/, "");
      const color = c.turn();
      ply++;
      // chess.js's internal generator counts legal moves without building their notation: about twice as fast.
      const legal = c._moves({ legal: true }).length;
      const phase = pieces <= 6 ? 2 : ply <= 24 ? 0 : 1;
      let mv;
      try { mv = c.move(san); } catch { return; }
      if (mv.captured && mv.captured !== "p") pieces--;
      if (mv.promotion) pieces++;
      const after = m[3] ? ev(m[3]) : null;
      const book = allBook && theory.has(posKey(c.fen()));
      if (!book) allBook = false;
      if (!book && legal > 1 && before && after) {
        const pov = (x) => (color === "w" ? x : 1 - x);
        const p = pov(winW(before));
        const q = 4 * p * (1 - p);
        const drop = 100 * (p - pov(winW(after)));
        const s = sums[color][phase];
        s[0] += q;
        s[1] += q * Math.max(0, (color === "w" ? 1 : -1) * (cpW(before) - cpW(after)));
        if (drop > 20) s[2] += q;
        if (drop > 10) s[3] += q;
      }
      before = after;
    }
    for (const color of ["w", "b"]) {
      const bd = band(elo[color]);
      PHASES.forEach((ph, i) => {
        const x = sums[color][i];
        if (x[0] > 0) { const t = (curve[`${ph}|${bd}`] ??= [0, 0, 0, 0, 0]); t[0]++; x.forEach((y, j) => (t[j + 1] += y)); }
      });
      const whole = sums[color].reduce((a, x) => a.map((y, j) => y + x[j]), [0, 0, 0, 0]);
      if (whole[0] > 0) { const t = (curve[`whole|${bd}`] ??= [0, 0, 0, 0, 0]); t[0]++; whole.forEach((y, j) => (t[j + 1] += y)); }
    }
  }
  parentPort.on("message", (msg) => {
    if (msg === "flush") return parentPort.postMessage({ curve });
    try { game(msg); } catch {}
    parentPort.postMessage("done1");
  });
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

/** Writes server/humanCurve.ts from a run's tables (also reads the research runs' tables, keyed "all|<scope>|<band>"). */
function emit(t) {
  const key = (scope, b) => t.curve[`${scope}|${b}`] ?? t.curve[`all|${scope === "whole" ? "all" : scope}|${b}`];
  const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  const table = (scope, indent) => {
    const bands = [];
    for (let b = 0; b < BANDS; b++) {
      const x = key(scope, b);
      if (x && x[0] >= MIN_SIDES) bands.push({ elo: 450 + 100 * b, sides: x[0], acpl: x[2] / x[1], blunders: (100 * x[3]) / x[1], errors: (100 * x[4]) / x[1] });
    }
    const ws = bands.map((b) => b.sides);
    const fit = { acpl: monotone(bands.map((b) => b.acpl), ws, -1), blunders: monotone(bands.map((b) => b.blunders), ws, -1), errors: monotone(bands.map((b) => b.errors), ws, -1) };
    return bands.map((b, i) => `${indent}{ elo: ${b.elo}, sides: ${b.sides}, acpl: ${r(fit.acpl[i], 1)}, blunders: ${r(fit.blunders[i], 2)}, errors: ${r(fit.errors[i], 2)} },`);
  };
  const whole = table("whole", "  ");
  const phases = PHASES.map((ph) => `  ${ph}: [\n${table(ph, "    ").join("\n")}\n  ],`);
  const ts = `// Generated by scripts/human-curve.mjs from ${t.analysed} analysed Lichess rapid games (${t.games} read). Don't edit by hand.

/**
 * How people at one Lichess rapid rating (band centre) play, each move weighted by how open the position was
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
${whole.join("\n")}
];

/** The same, for each phase's moves alone (phaseOf in analytics.ts): how people of each rating play that phase. */
export const HUMAN_RAPID_BY_PHASE: Record<"opening" | "middlegame" | "endgame", HumanBand[]> = {
${phases.join("\n")}
};
`;
  writeFileSync(path.join(ROOT, "server", "humanCurve.ts"), ts);
  console.log(`server/humanCurve.ts: ${whole.length} whole-game bands, phases ${phases.map((x) => x.split("\n").length - 2).join("/")}`);
}
