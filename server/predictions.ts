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
  /** Next-move guesses by the ply they're for (1 = White's first move): viewer → UCI. */
  moves: Record<string, Record<string, string>>;
}

interface Store {
  viewers: Record<string, Viewer>;
  games: Record<string, GamePicks>;
}

const FILE = path.join(DATA, "predictions.json");
let store: Store = { viewers: {}, games: {} };
if (existsSync(FILE)) {
  try {
    store = JSON.parse(readFileSync(FILE, "utf8"));
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
export function createViewer(name: unknown) {
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

function viewerOf(id: unknown): Viewer {
  const v = store.viewers[String(id ?? "")];
  if (!v) throw new PredictionError("Unknown viewer — reload the page.");
  return v;
}

const picksOf = (gameId: string) => (store.games[gameId] ??= { result: {}, moves: {} });

/** Whether each kind of prediction is open right now. */
export function openFor(g: Game) {
  const live = (g.phase === "pregame" || g.phase === "playing") && !g.result;
  return {
    result: live && g.moves.length < RESULT_LOCK_PLY,
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
    if (!open.result) throw new PredictionError(g.moves.length >= RESULT_LOCK_PLY ? "Result calls closed at move 10." : "This game isn't taking predictions.");
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
    (p.moves[ply] ??= {})[v.id] = uci;
  } else throw new PredictionError('kind must be "result" or "move".');
  cached = null;
  save();
}

/** What the crowd thinks about one game, plus this viewer's own picks and points. */
export function crowd(g: Game, viewerId?: string) {
  const p = store.games[g.id] ?? { result: {}, moves: {} };
  const me = viewerId && store.viewers[viewerId] ? viewerId : undefined;
  const tally = { "1-0": 0, "1/2-1/2": 0, "0-1": 0 } as Record<Result, number>;
  for (const r of Object.values(p.result)) tally[r.pick]++;
  const ply = g.moves.length + 1;
  const guesses = p.moves[String(ply)] ?? {};
  const counts = new Map<string, number>();
  for (const u of Object.values(guesses)) counts.set(u, (counts.get(u) ?? 0) + 1);
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
  const lastGuesses = last ? p.moves[String(last.ply)] ?? {} : {};
  const lastTotal = Object.keys(lastGuesses).length;
  const lastRight = last ? Object.values(lastGuesses).filter((u) => u === last.uci).length : 0;
  return {
    open: openFor(g),
    lockPly: RESULT_LOCK_PLY,
    points: { result: RESULT_POINTS, move: MOVE_POINTS },
    result: { tally, total: Object.keys(p.result).length, mine: me ? p.result[me]?.pick ?? null : null, actual: g.result },
    move: {
      ply,
      total: Object.keys(guesses).length,
      top: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([uci, n]) => ({ uci, san: san(uci), n })),
      mine: me && guesses[me] ? { uci: guesses[me], san: san(guesses[me]) } : null,
    },
    lastMove: last && lastTotal ? { ply: last.ply, san: last.san, total: lastTotal, right: lastRight, mine: me ? lastGuesses[me] === last.uci : null } : null,
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
    if (g.result) for (const [id, r] of Object.entries(p.result)) add(id, RESULT_POINTS, r.pick === g.result);
    for (const m of g.moves) for (const [id, uci] of Object.entries(p.moves[String(m.ply)] ?? {})) add(id, MOVE_POINTS, uci === m.uci);
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
