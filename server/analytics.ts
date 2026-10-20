import type { Classification, Color, Game, MoveRecord, PlayerRef, Score } from "../shared/types";
import type {
  AgentRow,
  AnalyticsScope,
  BlownGame,
  FormGame,
  GamePhase,
  HeadToHead,
  IllegalKind,
  ModelAnalytics,
  OpeningRow,
  Outcome,
  PhaseStats,
  RatingSeries,
  TimeStats,
  WDL,
} from "../shared/analytics";
import { MODELS } from "../shared/models";
import { isHuman } from "../shared/naming";
import { scoreToCp, winPercentFor } from "../shared/evalmath";
import { beliefs, engineAfter } from "../shared/belief";
import { looseChess } from "../shared/rules";
import { games, players } from "./store";
import { GLICKO_START, glickoUpdate, type Glicko } from "./glicko";
import { isRated, lineTokens } from "./game";
import { chessComEstimates, moveReading, type MoveSample } from "./chessCom";

/*
 * Everything the Agents tab shows, from the finished games: one pass over them per scope, kept until a
 * game or a review changes. See shared/analytics.ts for what each number means.
 */

const other = (c: Color): Color => (c === "w" ? "b" : "w");
const labelOf = (ref: PlayerRef) => (isHuman(ref) ? "Human" : (MODELS.find((m) => m.model === ref.model)?.label ?? ref.modelLabel));

/* ------------------------------ small helpers ------------------------------ */

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
const per100 = (count: number, of: number) => (of ? round1((count / of) * 100) : null);
const pct = (num: number, of: number) => (of ? round1((num / of) * 100) : null);

function timeStats(ms: number[]): TimeStats {
  if (!ms.length) return { n: 0, avgMs: null, medianMs: null };
  const s = [...ms].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return { n: s.length, avgMs: Math.round(mean(s)!), medianMs: Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) };
}

/** A move's think time, when it means something: not each side's first move (it includes the agent starting up). */
const thinkOf = (m: MoveRecord) => (m.ply > 2 && m.thinkMs > 0 ? m.thinkMs : null);

/** Analysed moves that say something about quality: book and forced moves are free. */
const graded = (m: MoveRecord) => !!m.analysis && !m.analysis.unavailable && m.analysis.classification !== "book" && m.analysis.classification !== "forced";

/**
 * The phase a move was played in, from the position before it: the endgame once at most six pieces other
 * than kings and pawns are left (as Lichess divides games), the opening while still in book or up to move 12.
 */
export function phaseOf(m: MoveRecord): GamePhase {
  let pieces = 0;
  for (const ch of m.fenBefore.split(" ")[0]) if ("nbrqNBRQ".includes(ch)) pieces++;
  if (pieces <= 6) return "endgame";
  if (m.ply <= 24 || m.analysis?.classification === "book") return "opening";
  return "middlegame";
}

const BAD: Classification[] = ["mistake", "blunder", "miss"];
const GOOD: Classification[] = ["brilliant", "great", "best", "excellent", "good"];

/* ------------------------------ illegal moves ------------------------------ */

const ILLEGAL_LABEL: Record<IllegalKind["kind"], string> = {
  check: "Ignored a check",
  pin: "Pinned piece, or king into check",
  reach: "Piece can't get there",
  missing: "No such piece there",
  castle: "Castling not allowed",
  notation: "Notation problem",
};

const file = (sq: string) => sq.charCodeAt(0) - 97;
const rank = (sq: string) => Number(sq[1]) - 1;
const square = (f: number, r: number) => String.fromCharCode(97 + f) + (r + 1);

type Board = ReturnType<typeof looseChess>;

/** Whether a piece could make this move by how it moves, before any question of the king's safety. */
function reaches(c: Board, from: string, to: string, type: string, me: Color, ep: string): boolean {
  if (from === to) return false;
  const target = c.get(to as never);
  if (target && target.color === me) return false;
  const df = file(to) - file(from);
  const dr = rank(to) - rank(from);
  const clear = () => {
    const sf = Math.sign(df);
    const sr = Math.sign(dr);
    for (let f = file(from) + sf, r = rank(from) + sr; f !== file(to) || r !== rank(to); f += sf, r += sr) if (c.get(square(f, r) as never)) return false;
    return true;
  };
  switch (type) {
    case "p": {
      const dir = me === "w" ? 1 : -1;
      if (df === 0) {
        if (target) return false;
        if (dr === dir) return true;
        return dr === 2 * dir && rank(from) === (me === "w" ? 1 : 6) && !c.get(square(file(from), rank(from) + dir) as never);
      }
      return Math.abs(df) === 1 && dr === dir && (!!target || to === ep);
    }
    case "n":
      return (Math.abs(df) === 1 && Math.abs(dr) === 2) || (Math.abs(df) === 2 && Math.abs(dr) === 1);
    case "k":
      return Math.max(Math.abs(df), Math.abs(dr)) === 1;
    case "b":
      return Math.abs(df) === Math.abs(dr) && clear();
    case "r":
      return (df === 0 || dr === 0) && clear();
    case "q":
      return (Math.abs(df) === Math.abs(dr) || df === 0 || dr === 0) && clear();
  }
  return false;
}

const SAN = /^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])(=?[QRBNqrbn])?$/;

/** Why a tried move was illegal in this position, roughly: what the player got wrong about the board. */
export function illegalKind(fen: string, tried: string): IllegalKind["kind"] {
  const t = tried.trim().replace(/[+#!?]+$/, "");
  if (/^[O0o]-[O0o](-[O0o])?$/.test(t)) return "castle";
  let c: Board;
  try {
    c = looseChess(fen);
  } catch {
    return "notation";
  }
  const me = c.turn();
  const ep = fen.split(" ")[3] ?? "-";
  let type: string;
  let to: string;
  let from: string[] = [];
  const lastRank = me === "w" ? "8" : "1";
  const uci = /^([a-h][1-8])-?([a-h][1-8])([qrbn])?$/.exec(t);
  if (uci) {
    const p = c.get(uci[1] as never);
    if (!p || p.color !== me) return "missing";
    type = p.type;
    to = uci[2];
    from = [uci[1]];
    // A king stepping two squares along its rank, or onto its own rook (Chess960), is a castle.
    const onto = c.get(to as never);
    if (type === "k" && rank(to) === rank(uci[1]) && (Math.abs(file(to) - file(uci[1])) >= 2 || (onto && onto.color === me && onto.type === "r"))) return "castle";
    // A pawn reaching the last rank must say what it becomes.
    if (type === "p" && to[1] === lastRank && !uci[3]) return "notation";
  } else {
    const s = SAN.exec(t);
    if (!s) return "notation";
    type = (s[1] ?? "p").toLowerCase();
    to = s[4];
    // A pawn capture names its file ("exd5"), and a pawn reaching the last rank names its promotion.
    if (type === "p" && ((t.includes("x") && !s[2]) || (to[1] === lastRank && !s[5]))) return "notation";
    for (let f = 0; f < 8; f++)
      for (let r = 0; r < 8; r++) {
        const sq = square(f, r);
        const p = c.get(sq as never);
        if (!p || p.color !== me || p.type !== type) continue;
        if (s[2] && sq[0] !== s[2]) continue;
        if (s[3] && sq[1] !== s[3]) continue;
        from.push(sq);
      }
  }
  if (!from.length) return "missing";
  if (from.some((sq) => reaches(c, sq, to, type, me, ep))) return c.inCheck() ? "check" : "pin";
  return "reach";
}

/* ------------------------------ ratings ------------------------------ */

/** Every player's rating and RD after each rated game, replayed the way the ratings are built (game.ts). */
function ratingHistories() {
  const state = new Map<string, Glicko>();
  const out = new Map<string, { ts: number; gameId: string; rating: number; rd: number; color: Color; g: Game }[]>();
  const done = [...games.values()].filter((g) => g.result && isRated(g)).sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));
  for (const g of done) {
    const pw = state.get(g.white.id) ?? { ...GLICKO_START };
    const pb = state.get(g.black.id) ?? { ...GLICKO_START };
    const sw = g.result === "1-0" ? 1 : g.result === "0-1" ? 0 : 0.5;
    const nw = glickoUpdate(pw, pb, sw);
    const nb = glickoUpdate(pb, pw, 1 - sw);
    state.set(g.white.id, nw);
    state.set(g.black.id, nb);
    for (const [ref, n, color] of [
      [g.white, nw, "w"],
      [g.black, nb, "b"],
    ] as const) {
      const list = out.get(ref.id) ?? [];
      list.push({ ts: g.endedAt ?? g.createdAt, gameId: g.id, rating: Math.round(n.rating), rd: Math.round(n.rd), color, g });
      out.set(ref.id, list);
    }
  }
  return out;
}

/* ------------------------------ one side of one game ------------------------------ */

interface Side {
  g: Game;
  color: Color;
  me: PlayerRef;
  opp: PlayerRef;
  outcome: Outcome;
  points: number;
  own: MoveRecord[];
  accuracy: number | null;
  ts: number;
}

function sidesOf(g: Game): Side[] {
  if (!g.result) return [];
  const out: Side[] = [];
  for (const color of ["w", "b"] as const) {
    const me = color === "w" ? g.white : g.black;
    if (isHuman(me)) continue;
    const points = g.result === "1/2-1/2" ? 0.5 : (g.result === "1-0") === (color === "w") ? 1 : 0;
    out.push({
      g,
      color,
      me,
      opp: color === "w" ? g.black : g.white,
      outcome: points === 1 ? "W" : points === 0 ? "L" : "D",
      points,
      own: g.moves.filter((m) => m.color === color),
      accuracy: g.review?.[color].accuracy ?? null,
      ts: g.endedAt ?? g.createdAt,
    });
  }
  return out;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * Every turn it tried illegal moves on, with the move it then played; and the turn the game ended on, when
 * it tried some there and then resigned instead (those stay pending on the game, against the final position).
 */
function illegalTurns(s: Side): { fen: string; ply: number; tries: string[]; played: string | null }[] {
  const out: { fen: string; ply: number; tries: string[]; played: string | null }[] = s.own
    .filter((m) => m.illegalAttempts.length)
    .map((m) => ({ fen: m.fenBefore, ply: m.ply, tries: m.illegalAttempts, played: m.san }));
  const pending = s.g.pendingIllegal?.[s.color] ?? [];
  if (pending.length) {
    const last = s.g.moves[s.g.moves.length - 1];
    out.push({ fen: last?.fenAfter ?? s.g.startFen ?? START_FEN, ply: s.g.moves.length + 1, tries: pending, played: null });
  }
  return out;
}

/**
 * What a reviewed standard game says about how it moves, for the Chess.com estimate, measured exactly as
 * scripts/human-curve.mjs measures people: each move weighted by how open the position was (4·p·(1−p) on its
 * winning chances, so a move in a decided position barely counts), losses taken from the raw evals (no zero for
 * matching the engine's choice, which a Lichess PGN can't show). Chess960 has no book to leave out.
 */
function moveSample(s: Side): MoveSample | null {
  if (s.g.variant === "chess960" || s.accuracy === null) return null;
  const out: MoveSample = { weight: 0, cpl: 0, blunders: 0, errors: 0 };
  const cp = (sc: Score) => Math.max(-1000, Math.min(1000, scoreToCp(sc))) * (s.color === "w" ? 1 : -1);
  for (const m of s.own) {
    const before = s.g.analysis[m.fenBefore];
    if (!graded(m) || !before || before.failed) continue;
    const p = winPercentFor(before.score, s.color) / 100;
    const q = 4 * p * (1 - p);
    const drop = 100 * p - winPercentFor(m.analysis!.evalAfter, s.color);
    out.weight += q;
    out.cpl += q * Math.max(0, cp(before.score) - cp(m.analysis!.evalAfter));
    if (drop > 20) out.blunders += q;
    if (drop > 10) out.errors += q;
  }
  return out;
}

const scoreOf = (sides: Side[]) => (sides.length ? round1((sides.reduce((a, s) => a + s.points, 0) / sides.length) * 100) : null);
const accOf = (sides: Side[]) => round1(mean(sides.map((s) => s.accuracy).filter((x): x is number => x !== null)));
const wdlOf = (sides: Side[]): WDL => ({
  games: sides.length,
  wins: sides.filter((s) => s.outcome === "W").length,
  draws: sides.filter((s) => s.outcome === "D").length,
  losses: sides.filter((s) => s.outcome === "L").length,
});
const formOf = (s: Side): FormGame => ({ gameId: s.g.id, ts: s.ts, result: s.outcome, accuracy: s.accuracy, opponent: labelOf(s.opp) });

function endLabel(term: string, outcome: Outcome): string {
  if (term === "checkmate") return outcome === "W" ? "Checkmate" : "Got checkmated";
  if (/resigned/.test(term)) return outcome === "W" ? "Opponent resigned" : "Resigned";
  const draws: Record<string, string> = {
    "draw agreed": "Agreed",
    "threefold repetition": "Repetition",
    stalemate: "Stalemate",
    "insufficient material": "Insufficient material",
    "50-move rule": "50-move rule",
  };
  return draws[term] ?? term;
}

const bump = (rec: Record<string, number>, key: string, by = 1) => (rec[key] = (rec[key] ?? 0) + by);

/* ------------------------------ one model ------------------------------ */

function rowOf(model: string, sides: Side[]): AgentRow {
  const ps = Object.values(players).filter((p) => p.ref.model === model && !isHuman(p.ref));
  const rated = ps.filter((p) => p.games > 0);
  // The model's rating is its most settled player's (lowest RD, i.e. most games), not a lucky one-game effort.
  const best = (rated.length ? rated : ps).reduce<(typeof ps)[number] | null>((a, b) => (!a || b.rd < a.rd || (b.rd === a.rd && b.rating > a.rating) ? b : a), null);
  const own = sides.flatMap((s) => s.own);
  const g = own.filter(graded);
  const estElo = mean(sides.map((s) => s.g.review?.[s.color].estElo ?? null).filter((x): x is number => x !== null));
  const ref = sides[0]?.me ?? ps[0]?.ref;
  return {
    model,
    label: MODELS.find((m) => m.model === model)?.label ?? ref?.modelLabel ?? model,
    provider: ref?.provider ?? "",
    rating: best && best.games > 0 ? best.rating : null,
    rd: best && best.games > 0 ? best.rd : null,
    bestPlayerId: best?.id ?? null,
    record: ps.reduce((a, p) => ({ games: a.games + p.games, wins: a.wins + p.wins, draws: a.draws + p.draws, losses: a.losses + p.losses }), {
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
    }),
    games: sides.length,
    moves: own.length,
    accuracy: accOf(sides),
    estElo: estElo === null ? null : Math.round(estElo / 25) * 25,
    // Needs every model's readings at once (compute fills it in).
    chessCom: null,
    score: scoreOf(sides),
    blundersPer100: per100(g.filter((m) => m.analysis!.classification === "blunder").length, g.length),
    illegalPer100: per100(
      sides.flatMap(illegalTurns).reduce((a, t) => a + t.tries.length, 0),
      own.length,
    ),
    // Filled in from the move-by-move beliefs (analyse), so the table and the model's page agree.
    calibration: null,
    think: timeStats(own.map(thinkOf).filter((x): x is number => x !== null)),
  };
}

function analyse(model: string, sides: Side[], field: Partial<Record<Classification, number>>, history: ReturnType<typeof ratingHistories>): ModelAnalytics {
  const row = rowOf(model, sides);
  const chrono = [...sides].sort((a, b) => a.ts - b.ts);
  const own = sides.flatMap((s) => s.own);

  /* ratings */
  const ratingHistory: RatingSeries[] = Object.values(players)
    .filter((p) => p.ref.model === model && history.has(p.id))
    .map((p) => {
      const pts = history.get(p.id)!;
      return {
        playerId: p.id,
        effort: p.ref.effort,
        games: pts.length,
        current: p.rating,
        rd: p.rd,
        points: pts.map((x) => {
          const pointsW = x.g.result === "1/2-1/2" ? "D" : (x.g.result === "1-0") === (x.color === "w") ? "W" : "L";
          return { ts: x.ts, gameId: x.gameId, rating: x.rating, rd: x.rd, result: pointsW as Outcome, opponent: labelOf(x.color === "w" ? x.g.black : x.g.white) };
        }),
      };
    })
    .sort((a, b) => b.games - a.games);

  /* form and upsets */
  const last = chrono.slice(-10);
  const upsetsWon: FormGame[] = [];
  const upsetsLost: FormGame[] = [];
  for (const s of sides) {
    const rb = s.g.ratingBefore;
    if (!rb || isHuman(s.opp)) continue;
    const gap = rb[other(s.color)] - rb[s.color];
    if (gap >= 100 && s.outcome === "W") upsetsWon.push(formOf(s));
    if (gap <= -100 && s.outcome === "L") upsetsLost.push(formOf(s));
  }

  /* move quality, by phase and colour */
  const counts: Partial<Record<Classification, number>> = {};
  for (const m of own) if (m.analysis && !m.analysis.unavailable) bump(counts, m.analysis.classification);
  const phases = {} as Record<GamePhase, PhaseStats>;
  for (const ph of ["opening", "middlegame", "endgame"] as const) {
    const mine = own.filter((m) => phaseOf(m) === ph);
    const g = mine.filter(graded);
    phases[ph] = {
      moves: g.length,
      accuracy: round1(mean(g.map((m) => m.analysis!.accuracy))),
      blundersPer100: per100(g.filter((m) => m.analysis!.classification === "blunder").length, g.length),
      think: timeStats(mine.map(thinkOf).filter((x): x is number => x !== null)),
    };
  }
  const byColor = {} as ModelAnalytics["quality"]["byColor"];
  for (const c of ["w", "b"] as const) {
    const cs = sides.filter((s) => s.color === c);
    byColor[c] = { games: cs.length, accuracy: accOf(cs), score: scoreOf(cs) };
  }

  /* thinking */
  const timed = own.filter((m) => graded(m) && thinkOf(m) !== null).sort((a, b) => a.thinkMs - b.thinkMs);
  const buckets: ModelAnalytics["thinking"]["buckets"] = [];
  if (timed.length >= 3) {
    const labels = ["Fastest third", "Middle third", "Slowest third"];
    for (let i = 0; i < 3; i++) {
      const part = timed.slice(Math.floor((i * timed.length) / 3), Math.floor(((i + 1) * timed.length) / 3));
      buckets.push({
        label: labels[i],
        minMs: part[0].thinkMs,
        maxMs: part[part.length - 1].thinkMs,
        moves: part.length,
        accuracy: round1(mean(part.map((m) => m.analysis!.accuracy))),
        blundersPer100: per100(part.filter((m) => m.analysis!.classification === "blunder").length, part.length),
      });
    }
  }
  const verdictTime = (cls: Classification[]) => timeStats(timed.filter((m) => cls.includes(m.analysis!.classification)).map((m) => m.thinkMs));
  const byVerdict: ModelAnalytics["thinking"]["byVerdict"] = [
    { group: "good", label: "Good moves", think: verdictTime(GOOD) },
    { group: "inaccuracy", label: "Inaccuracies", think: verdictTime(["inaccuracy"]) },
    { group: "bad", label: "Mistakes & blunders", think: verdictTime(BAD) },
  ];

  /* critical positions, mates */
  const critTimes: number[] = [];
  const normalTimes: number[] = [];
  let onlyMoves = 0;
  let onlyFound = 0;
  let mates = 0;
  let matesFound = 0;
  let mateIn1 = 0;
  let mateIn1Found = 0;
  for (const s of sides)
    for (const m of s.own) {
      if (!graded(m)) continue;
      const a = m.analysis!;
      const pa = s.g.analysis[m.fenBefore];
      if (!pa || pa.failed || !pa.depth) continue;
      const t = thinkOf(m);
      const critical = !!pa.second && winPercentFor(pa.score, m.color) - winPercentFor(pa.second, m.color) >= 20;
      if (critical) {
        onlyMoves++;
        if (a.winBefore - a.winAfter <= 5) onlyFound++;
        if (t !== null) critTimes.push(t);
      } else if (t !== null) normalTimes.push(t);
      const mate = pa.score.mate;
      if (mate !== undefined && mate !== 0 && mate > 0 === (m.color === "w")) {
        mates++;
        if (m.san.includes("#") || (a.evalAfter.mate !== undefined && winPercentFor(a.evalAfter, m.color) === 100)) matesFound++;
        if (Math.abs(mate) === 1) {
          mateIn1++;
          if (m.san.includes("#")) mateIn1Found++;
        }
      }
    }

  /* self-knowledge */
  const bins = Array.from({ length: 10 }, () => ({ n: 0, self: 0, engine: 0 }));
  let samples = 0;
  let gapSum = 0;
  let over = 0;
  let under = 0;
  for (const s of sides) {
    const bs = beliefs(s.g);
    s.g.moves.forEach((m, i) => {
      const b = bs[i];
      if (m.color !== s.color || !b) return;
      samples++;
      gapSum += Math.abs(b.self - b.engine);
      if (b.state === "over") over++;
      if (b.state === "under") under++;
      const bin = bins[Math.min(9, Math.floor(b.self / 10))];
      bin.n++;
      bin.self += b.self;
      bin.engine += b.engine;
    });
  }
  row.calibration = samples ? round1(gapSum / samples) : null;
  const curve = bins.flatMap((b, bin) => (b.n ? [{ bin, n: b.n, self: round1(b.self / b.n)!, engine: round1(b.engine / b.n)! }] : []));

  /* resignations and draws */
  const resign: ModelAnalytics["mind"]["resign"] = { count: 0, justified: 0, avgWin: null, premature: [] };
  const resignWins: number[] = [];
  const draws = { offered: 0, offeredWorse: 0, offeredLevel: 0, offeredBetter: 0, received: 0, accepted: 0, acceptedBetter: 0 };
  for (const s of sides) {
    const g = s.g;
    const term = g.termination ?? "";
    const resignedBy: Color | null = /resigned/.test(term) ? (term.startsWith("White") ? "w" : "b") : null;
    if (resignedBy === s.color) {
      resign.count++;
      const lastMove = g.moves[g.moves.length - 1];
      const sc = lastMove && engineAfter(g, lastMove);
      if (sc) {
        const win = winPercentFor(sc, s.color);
        resignWins.push(win);
        if (win <= 15) resign.justified++;
        else resign.premature.push({ gameId: g.id, ply: lastMove.ply, win: round1(win)!, opponent: labelOf(s.opp) });
      }
    }
    g.moves.forEach((m, i) => {
      if (!m.offeredDraw) return;
      const sc = engineAfter(g, m);
      const win = sc ? winPercentFor(sc, s.color) : null;
      if (m.color === s.color) {
        draws.offered++;
        if (win !== null) {
          if (win < 40) draws.offeredWorse++;
          else if (win > 60) draws.offeredBetter++;
          else draws.offeredLevel++;
        }
      } else {
        const final = i === g.moves.length - 1;
        const acceptedIt = final && term === "draw agreed";
        // An offer on the game's last move it either took, turned down by resigning, or never got to answer
        // (the move itself ended the game, or the offerer resigned).
        if (final && !acceptedIt && resignedBy !== s.color) return;
        draws.received++;
        if (acceptedIt) {
          draws.accepted++;
          if (win !== null && win > 60) draws.acceptedBetter++;
        }
      }
    });
  }
  resign.avgWin = round1(mean(resignWins));
  resign.premature.sort((a, b) => b.win - a.win);

  /* illegal moves */
  const kindCount = new Map<IllegalKind["kind"], IllegalKind>();
  let attempts = 0;
  let movesWithIllegal = 0;
  let movesWithRepeat = 0;
  for (const s of sides)
    for (const turn of illegalTurns(s)) {
      movesWithIllegal++;
      if (turn.tries.length >= 2) movesWithRepeat++;
      for (const tried of turn.tries) {
        attempts++;
        const kind = illegalKind(turn.fen, tried);
        const k = kindCount.get(kind) ?? { kind, label: ILLEGAL_LABEL[kind], count: 0, example: { gameId: s.g.id, ply: turn.ply, tried, played: turn.played } };
        k.count++;
        kindCount.set(kind, k);
      }
    }

  /* calculation */
  let movesWithLines = 0;
  let lines = 0;
  let legalLines = 0;
  const claimed: number[] = [];
  const legal: number[] = [];
  const beforeBreak: number[] = [];
  for (const m of own) {
    if (!m.lines?.length) continue;
    movesWithLines++;
    for (const l of m.lines) {
      lines++;
      claimed.push(lineTokens(l.raw).length);
      legal.push(l.san.length);
      if (l.brokenAt) beforeBreak.push(l.san.length);
      else legalLines++;
    }
  }

  /* converting and saving */
  let winning = 0;
  let converted = 0;
  let losing = 0;
  let saved = 0;
  let drawnFromWinning = 0;
  const blown: BlownGame[] = [];
  const firstMistakes: number[] = [];
  let clean = 0;
  for (const s of sides) {
    const g = s.g;
    const wins = g.moves.map((m) => {
      const sc = engineAfter(g, m);
      return sc ? winPercentFor(sc, s.color) : null;
    });
    // A position the game ended on by the rules doesn't count (every game won by mate "reaches" a won
    // position); one left behind by a resignation or an agreed draw does.
    const terminal = ["checkmate", "stalemate", "insufficient material"].includes(g.termination ?? "");
    const before = (terminal ? wins.slice(0, -1) : wins).filter((x): x is number => x !== null);
    if (before.some((w) => w >= 80)) {
      winning++;
      if (s.outcome === "W") converted++;
    }
    if (before.some((w) => w <= 20)) {
      losing++;
      if (s.outcome !== "L") saved++;
    }
    if (s.outcome === "D" && wins.slice(-10).some((w) => w !== null && w >= 90)) drawnFromWinning++;
    if (s.outcome !== "W" && before.length) {
      const peak = Math.max(...before);
      if (peak >= 85) {
        const at = wins.indexOf(peak);
        const after = s.own.filter((m) => m.ply - 1 > at && m.analysis && !m.analysis.unavailable);
        const worst = after.reduce<MoveRecord | null>((a, m) => (!a || m.analysis!.winBefore - m.analysis!.winAfter > a.analysis!.winBefore - a.analysis!.winAfter ? m : a), null);
        if (worst) blown.push({ gameId: g.id, opponent: labelOf(s.opp), peak: round1(peak)!, ply: worst.ply, san: worst.san, result: s.outcome });
      }
    }
    const first = s.own.find((m) => m.analysis && !m.analysis.unavailable && BAD.includes(m.analysis.classification));
    if (first) firstMistakes.push(Math.ceil(first.ply / 2));
    else if (s.own.some((m) => m.analysis && !m.analysis.unavailable)) clean++;
  }
  blown.sort((a, b) => b.peak - a.peak);

  /* openings */
  const openings = {} as Record<Color, OpeningRow[]>;
  for (const c of ["w", "b"] as const) {
    const byName = new Map<string, Side[]>();
    for (const s of sides) {
      if (s.color !== c || !s.g.opening || s.g.variant === "chess960") continue;
      const name = s.g.opening.name.split(":")[0].trim();
      byName.set(name, [...(byName.get(name) ?? []), s]);
    }
    openings[c] = [...byName]
      .map(([name, ss]) => ({ name, games: ss.length, score: scoreOf(ss)!, accuracy: accOf(ss) }))
      .sort((a, b) => b.games - a.games || b.score - a.score)
      .slice(0, 6);
  }

  /* how games end */
  const endings: ModelAnalytics["endings"] = { wins: {}, losses: {}, draws: {}, avgLength: { W: null, D: null, L: null }, drawnFromWinning };
  for (const s of sides) bump(s.outcome === "W" ? endings.wins : s.outcome === "L" ? endings.losses : endings.draws, endLabel(s.g.termination ?? "", s.outcome));
  for (const o of ["W", "D", "L"] as const) {
    const len = mean(sides.filter((s) => s.outcome === o).map((s) => Math.ceil(s.g.moves.length / 2)));
    endings.avgLength[o] = len === null ? null : Math.round(len);
  }

  /* head-to-head */
  const byOpp = new Map<string, Side[]>();
  for (const s of sides) {
    if (s.opp.model === model) continue;
    const key = isHuman(s.opp) ? "human" : s.opp.model;
    byOpp.set(key, [...(byOpp.get(key) ?? []), s]);
  }
  const h2h: HeadToHead[] = [...byOpp]
    .map(([key, ss]) => ({
      model: key,
      label: key === "human" ? "Humans" : labelOf(ss[0].opp),
      provider: ss[0].opp.provider,
      ...wdlOf(ss),
      myAccuracy: accOf(ss),
      theirAccuracy: round1(mean(ss.map((s) => s.g.review?.[other(s.color)].accuracy ?? null).filter((x): x is number => x !== null))),
    }))
    .sort((a, b) => b.games - a.games);

  /* effort */
  const byEffort = new Map<string, Side[]>();
  for (const s of sides) byEffort.set(s.me.effort, [...(byEffort.get(s.me.effort) ?? []), s]);
  const effortOrder = MODELS.find((m) => m.model === model)?.efforts ?? [];
  const efforts = [...byEffort]
    .map(([effort, ss]) => ({
      effort,
      games: ss.length,
      score: scoreOf(ss),
      accuracy: accOf(ss),
      think: timeStats(ss.flatMap((s) => s.own.map(thinkOf).filter((x): x is number => x !== null))),
    }))
    .sort((a, b) => effortOrder.indexOf(a.effort) - effortOrder.indexOf(b.effort));
  const setupPlayers = Object.values(players)
    .filter((p) => p.ref.model === model)
    .map((p) => ({
      playerId: p.id,
      effort: p.ref.effort,
      rating: p.rating,
      rd: p.rd,
      record: { games: p.games, wins: p.wins, draws: p.draws, losses: p.losses },
    }));

  return {
    scope: "all",
    row,
    ratingHistory,
    form: { last: last.map(formOf), scoreLast10: scoreOf(last), accuracyLast10: accOf(last) },
    upsets: { wins: upsetsWon.length, losses: upsetsLost.length, winsOver: upsetsWon, lossesTo: upsetsLost },
    quality: { counts, field, phases, byColor },
    thinking: { overall: row.think, buckets, byVerdict, critical: { positions: onlyMoves, found: onlyFound, think: timeStats(critTimes), normal: timeStats(normalTimes) } },
    mind: { calibration: row.calibration, samples, curve, over: pct(over, samples), under: pct(under, samples), resign, draws },
    rules: { moves: own.length, attempts, movesWithIllegal, movesWithRepeat, games: sides.length, kinds: [...kindCount.values()].sort((a, b) => b.count - a.count) },
    calc: {
      movesWithLines,
      lines,
      legalLines,
      avgClaimed: round1(mean(claimed)),
      avgLegal: round1(mean(legal)),
      avgBeforeBreak: round1(mean(beforeBreak)),
    },
    conversion: { winning, converted, losing, saved, blown: blown.slice(0, 5), firstMistake: { games: firstMistakes.length + clean, clean, avgMove: round1(mean(firstMistakes)) } },
    tactics: { mates, matesFound, mateIn1, mateIn1Found, onlyMoves, onlyFound },
    openings,
    endings,
    h2h,
    setup: { efforts, players: setupPlayers },
  };
}

/* ------------------------------ cache ------------------------------ */

interface Computed {
  sig: string;
  rows: AgentRow[];
  models: Map<string, ModelAnalytics>;
}
const cache = new Map<AnalyticsScope, Computed>();

/**
 * Changes whenever anything the numbers come from does: a finished game (its result, moves, review and
 * ratings; a game still being played counts for nothing yet) or a player's rating.
 * Built from memory only, so a cached answer costs no disk reads.
 */
function signature() {
  const parts: string[] = [];
  for (const g of games.values()) {
    if (!g.result) continue;
    const pending = (g.pendingIllegal?.w.length ?? 0) + (g.pendingIllegal?.b.length ?? 0);
    parts.push(`${g.id}.${g.moves.length}.${g.result}.${g.endedAt}.${isRated(g)}.${g.classifierVersion}.${pending}.${JSON.stringify([g.review, g.ratingBefore, g.ratingChange])}`);
  }
  for (const p of Object.values(players)) parts.push(`${p.id}.${p.rating}.${p.rd}.${p.games}`);
  return parts.join("|");
}

function compute(scope: AnalyticsScope): Computed {
  const sig = signature();
  const hit = cache.get(scope);
  if (hit && hit.sig === sig) return hit;

  const byModel = new Map<string, Side[]>();
  for (const g of games.values()) {
    if (scope === "rated" && !isRated(g)) continue;
    for (const s of sidesOf(g)) byModel.set(s.me.model, [...(byModel.get(s.me.model) ?? []), s]);
  }
  // Models with rated players but no game in this scope still get a row.
  for (const p of Object.values(players)) if (!isHuman(p.ref) && !byModel.has(p.ref.model)) byModel.set(p.ref.model, []);

  const field: Partial<Record<Classification, number>> = {};
  for (const sides of byModel.values()) for (const s of sides) for (const m of s.own) if (m.analysis && !m.analysis.unavailable) bump(field, m.analysis.classification);

  const history = ratingHistories();
  const models = new Map<string, ModelAnalytics>();
  for (const [model, sides] of byModel) models.set(model, { ...analyse(model, sides, field, history), scope });
  const all = [...models.values()];
  const estimates = chessComEstimates(
    all.map((a) => {
      const sides = [...byModel.get(a.row.model)!].sort((x, y) => (x.g.id < y.g.id ? -1 : x.g.id > y.g.id ? 1 : x.color === "w" ? -1 : 1));
      return { move: moveReading(sides.flatMap((s) => moveSample(s) ?? []), a.row.model), rating: a.row.rating, rd: a.row.rd };
    }),
  );
  all.forEach((a, i) => (a.row.chessCom = estimates[i]));
  const rows =[...models.values()].map((a) => a.row).sort((a, b) => (b.rating ?? -Infinity) - (a.rating ?? -Infinity) || b.games - a.games);
  const out = { sig, rows, models };
  cache.set(scope, out);
  return out;
}

export const analyticsRows = (scope: AnalyticsScope) => compute(scope).rows;
export const modelAnalytics = (model: string, scope: AnalyticsScope) => compute(scope).models.get(model) ?? null;
