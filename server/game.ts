import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { BroadcastLine, CalcLine, Color, Game, MoveRecord, PlayerRef, Result } from "../shared/types";
import { Engine } from "./engine";
import { CLASSIFIER_VERSION, classifyMove, reviewSide, terminalScore } from "./classify";
import { lookupOpening } from "./openings";
import { glickoUpdate } from "./glicko";
import { triggerOrchestrator } from "./summon";
import { isHuman } from "../shared/naming";
import { chess960Fen, newRules, START_FEN, variantOf, type Rules } from "../shared/rules";
import {
  appendJournal,
  freshStats,
  readLessons,
  writeLessons,
  ensurePlayer,
  games,
  players,
  saveGame,
  saveGameNow,
  savePlayersNow,
  saveSeatsNow,
  saveTournament,
  seatKeys,
  tournaments,
} from "./store";

const BROADCAST_GATE_MS = 90_000;
const MAX_COMMENTARY = 6000;
const MAX_INTERVIEW = 800;
const MAX_JOURNAL = 600;
const MAX_BROADCAST = 600;

export const bus = new EventEmitter();
bus.setMaxListeners(1000);
export const engine = new Engine();

const boards = new Map<string, Rules>();
const other = (c: Color): Color => (c === "w" ? "b" : "w");
const colorName = (c: Color) => (c === "w" ? "White" : "Black");

/** Where a game began: the normal setup, or its Chess960 position. */
export const startFenOf = (g: Pick<Game, "startFen">) => g.startFen ?? START_FEN;

/** The live position of a game, with its move history (for repetition). */
export function board(g: Game): Rules {
  let c = boards.get(g.id);
  if (!c) {
    const variant = variantOf(g);
    c = newRules(startFenOf(g), variant);
    // Chess960 replays by UCI (castling is king-takes-rook there); standard games by SAN, as always.
    for (const m of g.moves) c.move(variant === "chess960" ? m.uci : m.san);
    boards.set(g.id, c);
  }
  return c;
}

export function touch(g: Game) {
  saveGame(g);
  bus.emit(`game:${g.id}`, g);
  bus.emit("lobby");
}

const newId = (prefix: string) => `${prefix}${Date.now().toString(36).slice(-5)}${randomBytes(2).toString("hex")}`;

export function createGame(opts: {
  white: PlayerRef;
  black: PlayerRef;
  broadcaster: Game["broadcaster"];
  tournamentId?: string;
  learning?: boolean;
  /** A Chess960 game from this starting position (0–959). */
  chess960?: number;
}): Game {
  const g: Game = {
    id: newId("g"),
    createdAt: Date.now(),
    white: opts.white,
    black: opts.black,
    ...(opts.chess960 !== undefined ? { variant: "chess960" as const, chess960: opts.chess960, startFen: chess960Fen(opts.chess960) } : {}),
    broadcaster: opts.broadcaster,
    tournamentId: opts.tournamentId,
    phase: "pregame",
    moves: [],
    drawOffer: null,
    result: null,
    termination: null,
    interviews: { pre: {}, post: {} },
    journalDone: {},
    broadcast: [],
    broadcasterDone: !opts.broadcaster?.enabled,
    bcDelivered: [],
    seen: {},
    pendingIllegal: { w: [], b: [] },
    turnStartedAt: null,
    analysis: {},
    opening: null,
    review: null,
    playStartedAt: null,
    interviewsCompleteAt: null,
    ...(opts.chess960 !== undefined ? { opening: { eco: "960", name: `Chess960 #${opts.chess960}` } } : {}),
    options: { pieceList: true, learning: opts.learning ?? true },
    classifierVersion: CLASSIFIER_VERSION,
  };
  ensurePlayer(opts.white);
  ensurePlayer(opts.black);
  games.set(g.id, g);
  for (const role of ["w", "b", "x"] as const) {
    const key = `${g.id}-${role}-${randomBytes(4).toString("hex")}`;
    seatKeys[key] = { gameId: g.id, role };
  }
  // The caller is about to hand out these seat keys, so they must be on disk first.
  saveSeatsNow();
  saveGameNow(g);
  touch(g);
  analyzeGame(g);
  return g;
}

export const seatKeysFor = (gameId: string) =>
  Object.fromEntries(
    Object.entries(seatKeys)
      .filter(([, v]) => v.gameId === gameId)
      .map(([k, v]) => [v.role, k]),
  ) as Record<"w" | "b" | "x", string>;

/* ------------------------------ analysis ------------------------------ */

const inFlight = new Set<string>();

export function analyzeGame(g: Game) {
  const fens = [g.moves[0]?.fenBefore ?? startFenOf(g), ...g.moves.map((m) => m.fenAfter)];
  // A game drawn by repetition or the 50-move rule ends in a dead draw, whatever the bare FEN says.
  const historyDraw =
    g.termination === "threefold repetition" || g.termination === "50-move rule" ? g.moves[g.moves.length - 1]?.fenAfter : undefined;
  for (const fen of fens) {
    if (fen === historyDraw && g.analysis[fen]?.depth !== 0) {
      g.analysis[fen] = { depth: 0, score: { cp: 0 }, pv: [] };
      const last = g.moves[g.moves.length - 1];
      if (last) delete last.analysis; // re-classify the drawing move against the true outcome
      continue;
    }
    if (g.analysis[fen] || inFlight.has(`${g.id}|${fen}`)) continue;
    const term = terminalScore(fen);
    if (term) {
      g.analysis[fen] = { depth: 0, score: term, pv: [] };
      continue;
    }
    inFlight.add(`${g.id}|${fen}`);
    engine
      .analyze(fen, variantOf(g))
      .then((a) => {
        if (g.analysis[fen]?.depth === 0) return; // pinned as terminal/drawn while we were searching
        g.analysis[fen] = a;
        classifyPending(g);
        touch(g);
      })
      .catch((e) => console.error("[engine]", e))
      .finally(() => inFlight.delete(`${g.id}|${fen}`));
  }
  classifyPending(g);
}

function classifyPending(g: Game) {
  let changed = false;
  let allBook = true;
  for (let i = 0; i < g.moves.length; i++) {
    const m = g.moves[i];
    if (!m.analysis) {
      const before = g.analysis[m.fenBefore];
      const after = g.analysis[m.fenAfter];
      if (!before || !after) break; // classify strictly in order (miss/great depend on the previous move)
      m.analysis =
        before.failed || after.failed
          ? { classification: "good", winBefore: 50, winAfter: 50, accuracy: 0, cpLoss: 0, evalAfter: after.score, unavailable: true }
          : classifyMove(m, before, after.score, g.moves[i - 1], allBook, variantOf(g));
      changed = true;
    }
    if (m.analysis.classification !== "book") allBook = false;
  }
  if (changed) maybeFinishReview(g);
}

function maybeFinishReview(g: Game) {
  if (!g.result || g.review) return;
  if (g.moves.some((m) => !m.analysis)) return;
  g.review = { w: reviewSide(g, "w"), b: reviewSide(g, "b") };
  touch(g);
}

/* ------------------------------ phases ------------------------------ */

/** A human seat: plays its moves on the website and owes nothing else (no interviews, commentary or journal). */
export const seatIsHuman = (g: Game, c: Color) => isHuman(playerOf(g, c));

/** A player's post-game duties: interview, journal, and (when learning is on) their lessons rewrite. */
export const playerFinished = (g: Game, c: Color) =>
  seatIsHuman(g, c) || (!!g.interviews.post[c] && !!g.journalDone[c] && (!g.options?.learning || !!g.lessonsDone?.[c]));

/** Ready to start: the pre-game interview is in (a human is always ready). */
const preReady = (g: Game, c: Color) => seatIsHuman(g, c) || !!g.interviews.pre[c];

/** Periodic housekeeping: phase gates that depend on time. */
export function tick() {
  const now = Date.now();
  for (const g of games.values()) {
    if (g.phase === "pregame" && preReady(g, "w") && preReady(g, "b")) {
      g.interviewsCompleteAt ??= now;
      const bcSpoke = g.broadcast.some((l) => l.ts >= g.interviewsCompleteAt!);
      if (!g.broadcaster?.enabled || bcSpoke || now - g.interviewsCompleteAt > BROADCAST_GATE_MS) {
        g.phase = "playing";
        g.playStartedAt = now;
        g.turnStartedAt = now;
        touch(g);
      }
    }
    if (g.phase === "postgame" && g.review) {
      const playersDone = playerFinished(g, "w") && playerFinished(g, "b");
      if (playersDone) {
        const lastPlayerTs = Math.max(g.interviews.post.w?.ts ?? g.endedAt ?? 0, g.interviews.post.b?.ts ?? g.endedAt ?? 0);
        const bcWrapped = g.broadcast.some((l) => l.ts >= lastPlayerTs);
        if (!g.broadcaster?.enabled || bcWrapped || g.broadcasterDone || now - lastPlayerTs > BROADCAST_GATE_MS) {
          g.phase = "finished";
          touch(g);
        }
      }
    }
    // Auto-run tournaments: once a game is fully over, ask T3 to start the next pairing.
    if (g.phase === "finished" && g.tournamentId && !g.nextTriggered) {
      const t = tournaments.get(g.tournamentId);
      if (t?.autoRun && t.status === "running") {
        g.nextTriggered = true;
        saveGameNow(g);
        triggerOrchestrator({ action: "tournament-next", tournamentId: t.id }).catch((e) => {
          console.error("[summon] tournament-next failed (retrying in 60s):", e.message);
          setTimeout(() => (g.nextTriggered = false), 60_000);
        });
      }
    }
  }
}

function endGame(g: Game, result: Result, termination: string) {
  g.result = result;
  g.termination = termination;
  g.phase = "postgame";
  g.drawOffer = null;
  g.turnStartedAt = null;
  g.endedAt = Date.now();
  applyRating(g);
  if (g.tournamentId) {
    const t = tournaments.get(g.tournamentId);
    if (t && t.pairings.every((p) => p.gameId && games.get(p.gameId)?.result)) {
      t.status = "finished";
      saveTournament(t);
    }
  }
  maybeFinishReview(g);
  // The result and the ratings must hit disk together.
  saveGameNow(g);
  savePlayersNow();
  touch(g);
}

/** Glicko-2 for one finished game: both players update from their ratings before it. */
function applyRating(g: Game) {
  if (!g.result) return;
  const pw = ensurePlayer(g.white);
  const pb = ensurePlayer(g.black);
  const sw = g.result === "1-0" ? 1 : g.result === "0-1" ? 0 : 0.5;
  const nw = glickoUpdate(pw.glicko, pb.glicko, sw);
  const nb = glickoUpdate(pb.glicko, pw.glicko, 1 - sw);
  const show = (x: number) => Math.round(x);
  g.ratingChange = { w: show(nw.rating) - pw.rating, b: show(nb.rating) - pb.rating };
  for (const [p, n] of [
    [pw, nw],
    [pb, nb],
  ] as const) {
    p.glicko = n;
    p.rating = show(n.rating);
    p.rd = show(n.rd);
  }
  for (const [p, s] of [
    [pw, sw],
    [pb, 1 - sw],
  ] as const) {
    p.games++;
    if (s === 1) p.wins++;
    else if (s === 0) p.losses++;
    else p.draws++;
  }
}

/** Ratings are derived from game results, so a crash can never double-count a game. */
export function rebuildRatings() {
  // Players who no longer appear in any game (e.g. deleted test games) leave the leaderboard.
  const inGames = new Set([...games.values()].flatMap((g) => [g.white.id, g.black.id]));
  for (const id of Object.keys(players)) if (!inGames.has(id)) delete players[id];
  for (const p of Object.values(players)) Object.assign(p, freshStats());
  const done = [...games.values()].filter((g) => g.result).sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));
  for (const g of done) applyRating(g);
  savePlayersNow();
}

/* ------------------------------ actions ------------------------------ */

export class ActionError extends Error {}

export interface TurnInput {
  move: string;
  commentary: string;
  eval: string | number;
  lines?: { moves: string; note?: string }[];
  offerDraw?: boolean;
}

/** Strip move numbers and annotation glyphs a model might add. */
export function cleanToken(t: string): string {
  return t
    .trim()
    .replace(/^\d+\.(\.\.)?/, "")
    .replace(/[!?]+$/, "")
    .replace(/^[.…]+/, "")
    .trim();
}

function tryMove(c: Rules, raw: string) {
  const t = cleanToken(raw);
  if (!t) return null;
  try {
    return c.move(t.replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O"));
  } catch {
    return null;
  }
}

function isAmbiguous(c: Rules, raw: string): boolean {
  const m = /^([KQRBN])x?([a-h][1-8])/.exec(cleanToken(raw).replace(/[+#]$/, ""));
  if (!m) return false;
  const type = m[1].toLowerCase();
  return c.moves().filter((mv) => mv.piece === type && mv.to === m[2]).length > 1;
}

export function parseEval(v: string | number): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s/g, "");
  if (!s) return null;
  const mate = /^([+-]?)(?:#|M)(\d+)$/i.exec(s);
  if (mate) return mate[1] === "-" ? -10 : 10;
  const n = Number(s.replace(/^\+/, ""));
  return Number.isFinite(n) ? n : null;
}

function parseLine(g: Game, fen: string, raw: string, note: string): CalcLine {
  const c = newRules(fen, variantOf(g));
  const san: string[] = [];
  let brokenAt: string | undefined;
  const tokens = raw
    .replace(/(\d+)\.(\.\.)?/g, " ")
    .split(/[\s,]+/)
    .map(cleanToken)
    .filter(Boolean);
  for (const t of tokens) {
    const mv = tryMove(c, t);
    if (!mv) {
      brokenAt = t;
      break;
    }
    san.push(mv.san);
  }
  return { raw: raw.slice(0, 400), note: note.slice(0, 600), san, brokenAt };
}

export function submitTurn(g: Game, color: Color, input: TurnInput): MoveRecord {
  if (g.phase !== "playing" || g.result) throw new ActionError("The game is not in progress.");
  const c = board(g);
  if (c.turn() !== color) throw new ActionError("It is not your turn. Run `wait`.");
  // Agents explain every move; a human just plays it.
  const human = seatIsHuman(g, color);
  const commentary = human ? "" : String(input.commentary ?? "").trim();
  if (!commentary && !human) throw new ActionError("`commentary` is required: explain your thinking for this move.");
  const selfEval = human ? null : parseEval(input.eval ?? "");
  if (selfEval === null && !human) throw new ActionError('`eval` is required: your evaluation from White\'s point of view, e.g. "+0.8", "-1.5", "0.0", "#3", "-#2".');
  if (!input.move || typeof input.move !== "string") throw new ActionError("`move` is required.");

  const fenBefore = c.fen();
  const mv = tryMove(c, input.move);
  if (!mv && isAmbiguous(c, input.move)) {
    // A notation problem, not a chess one: a human would just pick up the right piece.
    throw new ActionError('Ambiguous move — more than one piece of that type could make it. Say which one, e.g. "Nbd2" / "R1e2", or use UCI like "b1d2".');
  }
  if (!mv) {
    g.pendingIllegal[color].push(input.move.slice(0, 20));
    touch(g);
    throw new ActionError("Illegal move.");
  }

  const lines = (Array.isArray(input.lines) && !human ? input.lines : [])
    .slice(0, 6)
    .filter((l) => l && typeof l.moves === "string" && l.moves.trim())
    .map((l) => parseLine(g, fenBefore, l.moves, String(l.note ?? "")));

  const now = Date.now();
  const rec: MoveRecord = {
    ply: g.moves.length + 1,
    color,
    san: mv.san,
    uci: mv.uci,
    from: mv.from,
    to: mv.to,
    fenBefore,
    fenAfter: c.fen(),
    commentary: commentary.slice(0, MAX_COMMENTARY),
    selfEval,
    selfEvalRaw: human ? "" : String(input.eval).slice(0, 12),
    lines,
    illegalAttempts: g.pendingIllegal[color],
    offeredDraw: !!input.offerDraw,
    thinkMs: g.turnStartedAt ? now - g.turnStartedAt : 0,
    ts: now,
  };
  g.pendingIllegal[color] = [];
  g.moves.push(rec);
  g.drawOffer = input.offerDraw ? color : null;
  g.turnStartedAt = now;
  // Opening names are for the standard setup; a Chess960 game is named after its start position.
  const op = variantOf(g) === "standard" ? lookupOpening(rec.fenAfter) : null;
  if (op) g.opening = op;

  if (c.isCheckmate()) endGame(g, color === "w" ? "1-0" : "0-1", "checkmate");
  else if (c.isStalemate()) endGame(g, "1/2-1/2", "stalemate");
  else if (c.isInsufficientMaterial()) endGame(g, "1/2-1/2", "insufficient material");
  else if (c.isThreefoldRepetition()) endGame(g, "1/2-1/2", "threefold repetition");
  else if (c.isDrawByFiftyMoves()) endGame(g, "1/2-1/2", "50-move rule");
  analyzeGame(g);
  saveGameNow(g);
  touch(g);
  return rec;
}

export function resign(g: Game, color: Color) {
  if (g.phase !== "playing" || g.result) throw new ActionError("The game is not in progress.");
  endGame(g, color === "w" ? "0-1" : "1-0", `${colorName(color)} resigned`);
}

export function acceptDraw(g: Game, color: Color) {
  if (g.phase !== "playing" || g.result) throw new ActionError("The game is not in progress.");
  if (g.drawOffer !== other(color)) throw new ActionError("There is no draw offer from your opponent to accept.");
  endGame(g, "1/2-1/2", "draw agreed");
}

export function submitInterview(g: Game, color: Color, text: string) {
  text = String(text ?? "").trim();
  if (!text) throw new ActionError("Interview answer is empty.");
  if (text.length > MAX_INTERVIEW) throw new ActionError(`Keep it under ${MAX_INTERVIEW} characters (yours: ${text.length}).`);
  if (g.phase === "pregame") {
    if (g.interviews.pre[color]) throw new ActionError("You already gave your pre-game interview.");
    g.interviews.pre[color] = { text, ts: Date.now() };
    // The broadcaster's intro counts from the moment the second interview lands.
    if (preReady(g, "w") && preReady(g, "b")) g.interviewsCompleteAt = Date.now();
  } else if (g.phase === "postgame") {
    if (g.interviews.post[color]) throw new ActionError("You already gave your post-game interview.");
    g.interviews.post[color] = { text, ts: Date.now() };
  } else throw new ActionError("Interviews happen before and after the game only.");
  saveGameNow(g);
  touch(g);
}

export function submitJournal(g: Game, color: Color, text: string) {
  text = String(text ?? "").trim();
  if (g.phase !== "postgame") throw new ActionError("Journal entries are written after the game.");
  if (!text) throw new ActionError("Journal entry is empty.");
  if (text.length > MAX_JOURNAL) throw new ActionError(`Keep it under ${MAX_JOURNAL} characters (yours: ${text.length}).`);
  const me = color === "w" ? g.white : g.black;
  const opp = color === "w" ? g.black : g.white;
  appendJournal(me.id, {
    gameId: g.id,
    ts: Date.now(),
    opponent: opp.id,
    color,
    result: g.result ?? "*",
    text,
  });
  g.journalDone[color] = true;
  saveGameNow(g);
  touch(g);
}

export const MAX_LESSONS = 1200;
export const MAX_LESSON_LINES = 10;

/** Lesson items: bullet/numbered lines start an item, plain lines continue the previous one (so wrapping is fine). */
export function lessonItems(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bulleted = lines.some((l) => /^([-*•]|\d+[.)])\s+/.test(l));
  if (!bulleted) return lines;
  const items: string[] = [];
  for (const l of lines) {
    if (/^([-*•]|\d+[.)])\s+/.test(l) || !items.length) items.push(l);
    else items[items.length - 1] += " " + l;
  }
  return items;
}

/** The player rewrites its model's whole lessons file (shared by every personality of that model). */
export function submitLessons(g: Game, color: Color, text: string) {
  if (!g.options?.learning) throw new ActionError("Learning is off for this game.");
  if (g.phase !== "postgame") throw new ActionError("Lessons are updated after the game.");
  text = String(text ?? "").trim();
  if (!text) throw new ActionError("Lessons are empty. Rewrite the full list (keep what still matters, add what you learned).");
  if (text.length > MAX_LESSONS) throw new ActionError(`Keep the whole list under ${MAX_LESSONS} characters (yours: ${text.length}). Merge or drop the least useful items.`);
  const items = lessonItems(text);
  if (items.length > MAX_LESSON_LINES) throw new ActionError(`At most ${MAX_LESSON_LINES} lessons (yours: ${items.length}). Merge or drop the least useful ones.`);
  const vague = items.filter((i) => !/→|->/.test(i));
  if (vague.length)
    throw new ActionError(
      `Every lesson must be a trigger and an action: "When [situation] → [what to do]". These are missing the "→": ${vague.map((v) => `"${v.slice(0, 60)}"`).join(", ")}`,
    );
  const model = playerOf(g, color).model;
  const current = readLessons(model);
  const seen = g.lessonsSeen?.[color];
  if (seen !== undefined && seen !== current.version) {
    // Another game with the same model updated the file since this player read it.
    g.lessonsSeen = { ...g.lessonsSeen, [color]: current.version };
    touch(g);
    throw new ActionError(
      `Your model's lessons were just updated by another of your games. Here is the latest version — rewrite your list starting from it:\n\n${current.text || "(empty)"}`,
    );
  }
  writeLessons(model, text, g.id);
  g.lessonsDone = { ...g.lessonsDone, [color]: true };
  saveGameNow(g);
  touch(g);
}

export function say(g: Game, text: string) {
  text = String(text ?? "").trim();
  if (!text) throw new ActionError("Nothing to say.");
  if (text.length > MAX_BROADCAST) throw new ActionError(`Keep each segment under ${MAX_BROADCAST} characters (yours: ${text.length}).`);
  // A retried `say` (e.g. after a CLI timeout) must not put the same segment on air twice.
  const prev = g.broadcast[g.broadcast.length - 1];
  if (prev && prev.text === text && Date.now() - prev.ts < 5 * 60_000) return prev;
  const line: BroadcastLine = { id: g.broadcast.length + 1, ts: Date.now(), text, ply: g.moves.length };
  g.broadcast.push(line);
  saveGameNow(g);
  touch(g);
  return line;
}

export function playerOf(g: Game, c: Color) {
  return c === "w" ? g.white : g.black;
}

export const ratingOf = (ref: PlayerRef) => players[ref.id]?.rating ?? 1500;
