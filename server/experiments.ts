import type { Color, Game, MoveRecord, SeatSetup } from "../shared/types";
import { ARM_METRICS, type ArmMetric, type ArmStats, type Difference, type Estimate, type ExperimentReport, type ExperimentScope, type HeadToHeadArms } from "../shared/experiments";
import { BOARD_VIEWS, isExperiment, seatSetup, setupKey, setupLabel } from "../shared/seatSetup";
import { MODELS } from "../shared/models";
import { isHuman } from "../shared/naming";
import { scoreToCp } from "../shared/evalmath";
import { games, tournaments } from "./store";

/*
 * The Experiments page (shared/experiments.ts): each reviewed seat under the toggles it played with. Every number
 * is a pooled ratio (all its moves, or all its games, together), and its range comes from how much it varies from
 * game to game: each game is one cluster, both its seats in it, so the two sides of one game never count as two
 * independent observations. A difference between arms is measured the same way, game by game, so in a split game
 * (one side under each) it moves with both sides at once.
 */

/** Positions this close to level (pawns, by the engine before the move) count as still open. */
const OPEN_CP = 200;
/** Fewer games than this, and a number gets no range and no difference is called clear. */
const MIN_GAMES = 5;
const Z = 1.96;

/** One seat's share of a number: x over n (x/n is its value), in game `game`. */
interface Part {
  game: string;
  x: number;
  n: number;
}

interface Seat {
  g: Game;
  model: string;
  setup: SeatSetup;
  parts: Record<ArmMetric, Part | null>;
  thinkMs: number[];
}

/** How a number is read: a mean of values, a count per 100 moves, or a share of points (bounded 0–1). */
const KIND: Record<ArmMetric, "mean" | "count" | "share"> = {
  accuracy: "mean",
  balancedAccuracy: "mean",
  blunders: "count",
  mistakes: "count",
  illegal: "count",
  codeRefusals: "count",
  positionRefusals: "count",
  score: "share",
};
const SCALE: Record<ArmMetric, number> = { accuracy: 1, balancedAccuracy: 1, blunders: 100, mistakes: 100, illegal: 100, codeRefusals: 100, positionRefusals: 100, score: 100 };

const graded = (m: MoveRecord) => !!m.analysis && !m.analysis.unavailable && !["book", "forced"].includes(m.analysis.classification);

function seatsOf(g: Game): Seat[] {
  if (!g.result || !g.review) return [];
  const out: Seat[] = [];
  for (const color of ["w", "b"] as Color[]) {
    const p = color === "w" ? g.white : g.black;
    if (isHuman(p)) continue;
    const setup = seatSetup(g, color);
    const own = g.moves.filter((m) => m.color === color && !m.supplied);
    const gr = own.filter(graded);
    let openAcc = 0;
    let open = 0;
    for (const m of gr) {
      const before = g.analysis[m.fenBefore];
      if (!before || before.failed || before.score.mate !== undefined || Math.abs(scoreToCp(before.score)) > OPEN_CP) continue;
      openAcc += m.analysis!.accuracy;
      open++;
    }
    const part = (x: number, n: number): Part => ({ game: g.id, x, n });
    const accuracy = g.review[color].accuracy;
    // Turns refused or tried illegally while the game ended (resigned instead) count too.
    const pendingChecks = g.pendingChecks?.[color];
    out.push({
      g,
      model: p.model,
      setup,
      parts: {
        accuracy: accuracy === null ? null : part(accuracy, 1),
        balancedAccuracy: part(openAcc, open),
        blunders: part(gr.filter((m) => m.analysis!.classification === "blunder").length, gr.length),
        mistakes: part(gr.filter((m) => m.analysis!.classification === "mistake" || m.analysis!.classification === "miss").length, gr.length),
        illegal: part(own.reduce((a, m) => a + m.illegalAttempts.length, 0) + (g.pendingIllegal?.[color]?.length ?? 0), own.length),
        // Only where they can happen: a seat without the picture is never asked for its code, nor one that doesn't re-read for the position.
        codeRefusals: setup.view === "text" ? null : part(own.reduce((a, m) => a + (m.checks?.code ?? 0), 0) + (pendingChecks?.code ?? 0), own.length),
        positionRefusals: setup.reread ? part(own.reduce((a, m) => a + (m.checks?.position ?? 0), 0) + (pendingChecks?.position ?? 0), own.length) : null,
        score: part(g.result === "1/2-1/2" ? 0.5 : (g.result === "1-0") === (color === "w") ? 1 : 0, 1),
      },
      thinkMs: own.slice(1).flatMap((m) => (m.thinkMs > 0 ? [m.thinkMs] : [])),
    });
  }
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Parts summed per game: what each game (cluster) adds to x and n. A game that adds nothing to this number (no
 * open positions, say) isn't one of its observations; one with refusals but no move played still is.
 */
function byGame(parts: Part[]) {
  const m = new Map<string, { x: number; n: number }>();
  for (const p of parts) {
    if (!p.x && !p.n) continue;
    const c = m.get(p.game) ?? { x: 0, n: 0 };
    c.x += p.x;
    c.n += p.n;
    m.set(p.game, c);
  }
  return m;
}

/**
 * The least a range can be, so a handful of games that happen to agree (no blunders, every game won) don't read as
 * certain: a count is at least as uncertain as one event in its moves; a share reaches as far from what was seen as
 * the farther end of its Wilson interval (which isn't centred on it: five wins in five is 57–100%, so ±43).
 */
function floorSe(kind: (typeof KIND)[ArmMetric], X: number, N: number) {
  if (kind === "count") return Math.sqrt(Math.max(X, 1)) / N;
  if (kind === "share") {
    const p = X / N;
    const centre = (p + (Z * Z) / (2 * N)) / (1 + (Z * Z) / N);
    const half = (Z * Math.sqrt((p * (1 - p)) / N + (Z * Z) / (4 * N * N))) / (1 + (Z * Z) / N);
    return Math.max(p - (centre - half), centre + half - p) / Z;
  }
  return 0;
}

interface Pooled {
  r: number;
  N: number;
  games: number;
  clusters: Map<string, { x: number; n: number }>;
  /** Squared standard error. */
  v: number;
}

/** A pooled ratio Σx/Σn and its variance, clustered by game. A game whose seat refused turns but never moved still adds its refusals. */
function pooled(parts: Part[], kind: (typeof KIND)[ArmMetric]): Pooled | null {
  const clusters = byGame(parts);
  let X = 0;
  let N = 0;
  for (const c of clusters.values()) (X += c.x), (N += c.n);
  if (!N) return null;
  const r = X / N;
  const k = clusters.size;
  let s = 0;
  for (const c of clusters.values()) s += (c.x - r * c.n) ** 2;
  const v = Math.max(k > 1 ? ((k / (k - 1)) * s) / (N * N) : Infinity, floorSe(kind, X, N) ** 2);
  return { r, N, games: k, clusters, v };
}

function estimate(p: Pooled | null, scale: number): Estimate {
  if (!p) return { value: null, ci: null };
  return { value: round1(p.r * scale), ci: p.games >= MIN_GAMES && Number.isFinite(p.v) ? round1(Z * Math.sqrt(p.v) * scale) : null };
}

/**
 * a − b, with its variance from the games: each game adds its share to both sides' sums at once (a split game
 * to both), so what the two sides have in common in a game cancels out instead of counting twice.
 */
function difference(a: Pooled | null, b: Pooled | null, kind: (typeof KIND)[ArmMetric], scale: number): Difference {
  if (!a || !b) return { value: null, ci: null, clear: false };
  const ids = new Set([...a.clusters.keys(), ...b.clusters.keys()]);
  let s = 0;
  for (const id of ids) {
    const ca = a.clusters.get(id);
    const cb = b.clusters.get(id);
    const u = (ca ? (ca.x - a.r * ca.n) / a.N : 0) - (cb ? (cb.x - b.r * cb.n) / b.N : 0);
    s += u * u;
  }
  const k = ids.size;
  const floor = floorSe(kind, a.r * a.N, a.N) ** 2 + floorSe(kind, b.r * b.N, b.N) ** 2;
  const v = Math.max(k > 1 ? (k / (k - 1)) * s : Infinity, floor);
  const d = a.r - b.r;
  const enough = a.games >= MIN_GAMES && b.games >= MIN_GAMES && Number.isFinite(v);
  const ci = enough ? Z * Math.sqrt(v) : null;
  return { value: round1(d * scale), ci: ci === null ? null : round1(ci * scale), clear: ci !== null && Math.abs(d) > ci };
}

function poolAll(seats: Seat[]) {
  return Object.fromEntries(ARM_METRICS.map((m) => [m, pooled(seats.flatMap((s) => (s.parts[m] ? [s.parts[m]!] : [])), KIND[m])])) as Record<ArmMetric, Pooled | null>;
}

function arm(setup: SeatSetup, seats: Seat[], pools: Record<ArmMetric, Pooled | null>, first?: Record<ArmMetric, Pooled | null>): ArmStats {
  const think = seats.flatMap((s) => s.thinkMs);
  const est = (m: ArmMetric) => estimate(pools[m], SCALE[m]);
  return {
    key: setupKey(setup),
    label: setupLabel(setup),
    setup,
    games: seats.length,
    graded: seats.reduce((a, s) => a + (s.parts.blunders?.n ?? 0), 0),
    accuracy: est("accuracy"),
    balancedAccuracy: est("balancedAccuracy"),
    blunders: est("blunders"),
    mistakes: est("mistakes"),
    illegal: est("illegal"),
    codeRefusals: est("codeRefusals"),
    positionRefusals: est("positionRefusals"),
    thinkSec: think.length ? round1(think.reduce((a, b) => a + b, 0) / think.length / 1000) : null,
    score: est("score"),
    ...(first && { vsFirst: Object.fromEntries(ARM_METRICS.map((m) => [m, difference(pools[m], first[m], KIND[m], SCALE[m])])) }),
  };
}

/** The plain briefing first, then by view (text, added, image), without re-reading before with. */
const order = (s: SeatSetup) => BOARD_VIEWS.indexOf(s.view) * 2 + (s.reread ? 1 : 0);

function arms(seats: Seat[]): ArmStats[] {
  const by = new Map<string, Seat[]>();
  for (const s of seats) by.set(setupKey(s.setup), [...(by.get(setupKey(s.setup)) ?? []), s]);
  const groups = [...by.values()].sort((a, b) => order(a[0].setup) - order(b[0].setup)).map((list) => ({ list, pools: poolAll(list) }));
  return groups.map(({ list, pools }, i) => arm(list[0].setup, list, pools, i > 0 ? groups[0].pools : undefined));
}

/** Games where the two seats played under different combinations: how each combination did against the other. */
function headToHead(list: Game[]): HeadToHeadArms[] {
  const by = new Map<string, { a: SeatSetup; b: SeatSetup; pts: Part[] }>();
  for (const g of list) {
    if (!g.result || isHuman(g.white) || isHuman(g.black)) continue;
    const sw = seatSetup(g, "w");
    const sb = seatSetup(g, "b");
    if (setupKey(sw) === setupKey(sb)) continue;
    // From the side of the combination that sorts first, so a vs b and b vs a land together.
    const [a, aColor] = order(sw) <= order(sb) ? [sw, "w" as Color] : [sb, "b" as Color];
    const b = aColor === "w" ? sb : sw;
    const key = `${setupKey(a)}|${setupKey(b)}`;
    const row = by.get(key) ?? { a, b, pts: [] };
    row.pts.push({ game: g.id, x: g.result === "1/2-1/2" ? 0.5 : (g.result === "1-0") === (aColor === "w") ? 1 : 0, n: 1 });
    by.set(key, row);
  }
  return [...by.values()].map(({ a, b, pts }) => ({
    a: setupKey(a),
    b: setupKey(b),
    aLabel: setupLabel(a),
    bLabel: setupLabel(b),
    games: pts.length,
    aWins: pts.filter((p) => p.x === 1).length,
    draws: pts.filter((p) => p.x === 0.5).length,
    bWins: pts.filter((p) => p.x === 0).length,
    aScore: estimate(pooled(pts, "share"), 100),
  }));
}

const labelOf = (model: string) => MODELS.find((m) => m.model === model)?.label ?? model;

/**
 * The games a scope covers: "experiments" (every game where a seat had toggles), "all", or "t:<id>" (one
 * tournament's).
 */
function inScope(scope: string): Game[] {
  const done = [...games.values()].filter((g) => g.result && g.review);
  if (scope === "all") return done;
  if (scope.startsWith("t:")) return done.filter((g) => g.tournamentId === scope.slice(2));
  return done.filter(isExperiment);
}

export function experimentReport(scope: string): ExperimentReport {
  const done = [...games.values()].filter((g) => g.result && g.review);
  // The tournaments that ran with toggles, newest first, as scopes of their own.
  const scopes: ExperimentScope[] = [
    { id: "experiments", label: "Every experiment game", games: done.filter(isExperiment).length },
    ...[...tournaments.values()]
      .filter((t) => t.setups)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => ({ id: `t:${t.id}`, label: t.name, games: done.filter((g) => g.tournamentId === t.id).length })),
    { id: "all", label: "All games", games: done.length },
  ];
  const id = scopes.some((s) => s.id === scope) ? scope : "experiments";
  const list = inScope(id);
  const seats = list.flatMap(seatsOf);
  const byModel = new Map<string, Seat[]>();
  for (const s of seats) byModel.set(s.model, [...(byModel.get(s.model) ?? []), s]);
  const models = [...byModel.entries()]
    .map(([model, list]) => ({ model, label: labelOf(model), arms: arms(list) }))
    .filter((m) => m.arms.length > 1)
    .sort((a, b) => a.label.localeCompare(b.label));
  return { scope: id, scopes, games: list.length, arms: arms(seats), models, headToHead: headToHead(list) };
}
