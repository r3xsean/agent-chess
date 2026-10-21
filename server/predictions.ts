import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Game, Result } from "../shared/types";
import { newRules, START_FEN, variantOf } from "../shared/rules";
import { DATA } from "./paths";

/*
 * Viewer predictions: call the result while the game is young, and guess each next move.
 * Picks are stored; points are always worked out from the games themselves, so nothing is ever
 * scored twice and a re-synced game re-scores itself.
 */

/** Result calls close once this many plies have been played (move 10). */
export const RESULT_LOCK_PLY = 20;
export const RESULT_POINTS = 10;
export const MOVE_POINTS = 3;

interface Viewer {
  id: string;
  name: string;
  createdAt: number;
}

interface GamePicks {
  result: Record<string, { pick: Result; ts: number }>;
  /** Next-move guesses by the ply they're for (1 = White's first move): viewer → UCI and when it was made. */
  moves: Record<string, Record<string, { uci: string; ts: number }>>;
}

interface Store {
  viewers: Record<string, Viewer>;
  games: Record<string, GamePicks>;
}

/** Keyed by ids that come from the outside, so no prototype: "__proto__" is just a missing key. */
const dict = <T>(from?: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), from ?? {});

const FILE = path.join(DATA, "predictions.json");
let store: Store = { viewers: dict(), games: dict() };
if (existsSync(FILE)) {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    store = { viewers: dict(raw.viewers), games: dict() };
    for (const [id, p] of Object.entries<any>(raw.games ?? {})) {
      const moves = dict<Record<string, { uci: string; ts: number }>>();
      for (const [ply, guesses] of Object.entries<any>(p.moves ?? {})) moves[ply] = dict(guesses);
      store.games[id] = { result: dict(p.result), moves };
    }
  } catch (e) {
    console.error("[predictions] could not read predictions.json; starting empty", e);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeFileSync(FILE + ".tmp", JSON.stringify(store));
    renameSync(FILE + ".tmp", FILE);
  }, 500);
}
export function flushPredictions() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeFileSync(FILE, JSON.stringify(store));
}

export class PredictionError extends Error {}

const cleanName = (name: unknown) =>
  String(name ?? "")
    .replace(/[^\p{L}\p{N} ._'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);

/** A new anonymous viewer. The id is the viewer's secret: whoever holds it can predict as them. */
export function createViewer(name: unknown): Viewer {
  const v: Viewer = { id: randomBytes(16).toString("hex"), name: cleanName(name) || `Viewer ${randomBytes(2).toString("hex")}`, createdAt: Date.now() };
  store.viewers[v.id] = v;
  save();
  return v;
}

export function renameViewer(id: string, name: unknown) {
  const v = viewerOf(id);
  const n = cleanName(name);
  if (!n) throw new PredictionError("Pick a name (letters and numbers, up to 20).");
  v.name = n;
  save();
  return v;
}

const VIEWER_ID = /^[0-9a-f]{32}$/;

function viewerOf(id: unknown): Viewer {
  const key = String(id ?? "");
  const v = VIEWER_ID.test(key) && Object.hasOwn(store.viewers, key) ? store.viewers[key] : undefined;
  if (!v) throw new PredictionError("Unknown viewer — reload the page.");
  return v;
}

const picksOf = (gameId: string) => (store.games[gameId] ??= { result: dict(), moves: dict() });

/** The ply result calls close at: ten moves into the players' own play (a set opening's moves don't count). */
const lockPly = (g: Game) => RESULT_LOCK_PLY + (g.setOpening?.plies ?? 0);

/** Whether each kind of prediction is open right now. */
export function openFor(g: Game) {
  const live = (g.phase === "pregame" || g.phase === "playing") && !g.result;
  return {
    result: live && g.moves.length < lockPly(g),
    move: g.phase === "playing" && !g.result,
  };
}

/** The current position of a game, rebuilt from its record (cheap: one FEN). */
const currentFen = (g: Game) => g.moves[g.moves.length - 1]?.fenAfter ?? g.startFen ?? START_FEN;

export function predict(g: Game, viewerId: unknown, kind: unknown, pick: unknown) {
  const v = viewerOf(viewerId);
  const open = openFor(g);
  const p = picksOf(g.id);
  if (kind === "result") {
    if (!open.result) throw new PredictionError(g.moves.length >= lockPly(g) ? `Result calls closed at move ${Math.ceil(lockPly(g) / 2)}.` : "This game isn't taking predictions.");
    if (pick !== "1-0" && pick !== "0-1" && pick !== "1/2-1/2") throw new PredictionError('Pick "1-0", "0-1" or "1/2-1/2".');
    p.result[v.id] = { pick, ts: Date.now() };
  } else if (kind === "move") {
    if (!open.move) throw new PredictionError("Move guesses are open while the game is being played.");
    let uci: string;
    try {
      uci = newRules(currentFen(g), variantOf(g)).move(String(pick ?? "")).uci;
    } catch {
      throw new PredictionError("That isn't a legal move in the current position.");
    }
    const ply = String(g.moves.length + 1);
    (p.moves[ply] ??= dict())[v.id] = { uci, ts: Date.now() };
  } else throw new PredictionError('kind must be "result" or "move".');
  cached = null;
  save();
}

/*
 * Cut-offs. The public mirror hears about a move a moment after it's played, so a pick only counts if it was
 * made before the move (or the end of the game) really happened, by the mirror's clock (game times are on the
 * local server's clock: mirrorSkewMs converts them).
 */
/** When a ply was played: the mirror's frozen cut-off, or (on the local server) the move's own time. */
const plyTime = (g: Game, ply: number) => g.mirrorCutoffs?.[ply] ?? g.moves[ply - 1]?.ts ?? Infinity;
/** When result calls really closed: the move that reached the lock, or the end of the game, whichever came first. */
function resultCutoff(g: Game): number {
  const end = g.result ? (g.mirrorCutoffs?.end ?? g.endedAt ?? g.moves[g.moves.length - 1]?.ts ?? Infinity) : Infinity;
  return Math.min(plyTime(g, lockPly(g)), end);
}
const guessCounts = (g: Game, ply: number, ts: number) => ts <= plyTime(g, ply);
/** Old saved guesses were bare UCI strings. */
const guessOf = (x: string | { uci: string; ts: number }) => (typeof x === "string" ? { uci: x, ts: 0 } : x);

/** Points move whenever a game does: forget the cached totals. */
export function scoresChanged() {
  cached = null;
}

/** What the crowd thinks about one game, plus this viewer's own picks and points. */
export function crowd(g: Game, viewerId?: string) {
  const p = store.games[g.id] ?? { result: dict(), moves: dict() };
  const me = viewerId && VIEWER_ID.test(viewerId) && Object.hasOwn(store.viewers, viewerId) ? viewerId : undefined;
  const tally = { "1-0": 0, "1/2-1/2": 0, "0-1": 0 } as Record<Result, number>;
  for (const r of Object.values(p.result)) tally[r.pick]++;
  const ply = g.moves.length + 1;
  const guesses = p.moves[String(ply)] ?? {};
  const counts = new Map<string, number>();
  for (const x of Object.values(guesses)) counts.set(guessOf(x).uci, (counts.get(guessOf(x).uci) ?? 0) + 1);
  const fen = currentFen(g);
  const san = (uci: string) => {
    try {
      return newRules(fen, variantOf(g)).move(uci).san;
    } catch {
      return uci;
    }
  };
  // How the crowd did on the move just played.
  const last = g.moves[g.moves.length - 1];
  const lastGuesses = last ? Object.entries(p.moves[String(last.ply)] ?? {}).filter(([, x]) => guessCounts(g, last.ply, guessOf(x).ts)) : [];
  const lastTotal = lastGuesses.length;
  const lastRight = last ? lastGuesses.filter(([, x]) => guessOf(x).uci === last.uci).length : 0;
  const myLast = me ? lastGuesses.find(([id]) => id === me) : undefined;
  return {
    open: openFor(g),
    lockPly: lockPly(g),
    points: { result: RESULT_POINTS, move: MOVE_POINTS },
    result: { tally, total: Object.keys(p.result).length, mine: me ? p.result[me]?.pick ?? null : null, actual: g.result },
    move: {
      ply,
      total: Object.keys(guesses).length,
      top: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([uci, n]) => ({ uci, san: san(uci), n })),
      mine: me && guesses[me] ? { uci: guessOf(guesses[me]).uci, san: san(guessOf(guesses[me]).uci) } : null,
    },
    lastMove: last && lastTotal ? { ply: last.ply, san: last.san, total: lastTotal, right: lastRight, mine: myLast ? guessOf(myLast[1]).uci === last.uci : null } : null,
    you: me ? standing(me) : null,
  };
}

/* ------------------------------ points ------------------------------ */

let games: () => Iterable<Game> = () => [];
/** The games to score against (the server's game map). */
export function setGameSource(src: () => Iterable<Game>) {
  games = src;
}

interface Score {
  points: number;
  right: number;
  calls: number;
}

let cached: { at: number; scores: Map<string, Score> } | null = null;

/** Every viewer's points, from the finished results and played moves (recounted at most every 2 s). */
function scores(): Map<string, Score> {
  if (cached && Date.now() - cached.at < 2000) return cached.scores;
  const out = new Map<string, Score>();
  cached = { at: Date.now(), scores: out };
  const add = (id: string, pts: number, right: boolean) => {
    const s = out.get(id) ?? { points: 0, right: 0, calls: 0 };
    s.points += right ? pts : 0;
    s.right += right ? 1 : 0;
    s.calls++;
    out.set(id, s);
  };
  for (const g of games()) {
    const p = store.games[g.id];
    if (!p) continue;
    // An aborted game has no result to call.
    if (g.result) {
      const cutoff = resultCutoff(g);
      for (const [id, r] of Object.entries(p.result)) if (r.ts <= cutoff) add(id, RESULT_POINTS, r.pick === g.result);
    }
    for (const m of g.moves)
      for (const [id, x] of Object.entries(p.moves[String(m.ply)] ?? {})) {
        const guess = guessOf(x);
        if (guessCounts(g, m.ply, guess.ts)) add(id, MOVE_POINTS, guess.uci === m.uci);
      }
  }
  return out;
}

function standing(id: string) {
  const all = scores();
  const mine = all.get(id) ?? { points: 0, right: 0, calls: 0 };
  const rank = [...all.values()].filter((s) => s.points > mine.points).length + 1;
  return { name: store.viewers[id]?.name ?? "", ...mine, rank };
}

/** The top predictors (names only — ids are secrets). */
export function leaderboard(limit = 25) {
  return [...scores().entries()]
    .filter(([, s]) => s.calls > 0)
    .sort((a, b) => b[1].points - a[1].points || b[1].right - a[1].right)
    .slice(0, limit)
    .map(([id, s], i) => ({ rank: i + 1, name: store.viewers[id]?.name ?? "?", ...s }));
}

export const viewerInfo = (id: string) => {
  const v = viewerOf(id);
  return { id: v.id, ...standing(v.id) };
};
