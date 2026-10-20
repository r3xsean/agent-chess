import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { looseChess, newRules, START_FEN, variantOf, type RulesMove, type Variant } from "../../../shared/rules";
import type { Classification, Color, Game, LineReach, LineRef, PlayerRef, Rivalry, Score } from "../../../shared/types";
import { seriesLine } from "../../../shared/series";
import type { VoiceManifest } from "../../../shared/voices";
import { personalityById, RISK_LABEL } from "../../../shared/personalities";
import { formatScore, winPercentWhite } from "../../../shared/evalmath";
import { beliefs, judge, selfScore, standing, type Belief } from "../../../shared/belief";
import { makerOf } from "../../../shared/models";
import { materialInfo, type MaterialInfo } from "../../../shared/material";
import { illegalMovePath, triesOf } from "../../../shared/explain";
import { fenAt, lineVerdicts, planBranch, planLine, resolveLineRefs, shownLine, type LineKind, type ShownBranch, type ShownLine } from "../../../shared/engineLine";
import { boardOf, pointsAt, quoteWords } from "../../../shared/thoughtMarks";
import { api, type Lobby } from "../api";
import { ClassIcon, CLASS_META } from "../components/ClassIcon";
import { PlayerAvatar, PlayerName } from "../components/PlayerName";
import { fullName, isHuman, selfEvalColors, sideName } from "../../../shared/naming";
import { buildTimeline, FRAME, LINE_SLIDE, MARK_FADE, sceneAt, sfxCues, VOICE_AT, type AsideCue, type Format, type Scene, type SceneMark, type SfxCue, type Timeline } from "./timeline";
import { playSfx } from "../sfx";
import { RenderPanel } from "./RenderPanel";
import { lineTransition, rewindFrame, trackAt } from "./linePlayback";
import { useMeta } from "../api";
import "./video.css";

/** Width of the render panel beside the preview. */
const PANEL_W = 340;

/*
 * A game replay laid out as a video frame (1920×1080 for YouTube, 1080×1920 for TikTok).
 * Everything on screen is a pure function of the time t, so scripts/render-video.mjs can seek
 * frame by frame and capture each one; no CSS transitions or timers are involved.
 */

const PIECE: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
/** Moves the engine would have played differently: show its choice as an arrow. */
const SHOW_BEST: Classification[] = ["good", "inaccuracy", "mistake", "miss", "blunder"];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutBack = (x: number) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const other = (c: Color): Color => (c === "w" ? "b" : "w");

type Piece = { type: string; color: Color };
function fenBoard(fen: string): Map<string, Piece> {
  const board = new Map<string, Piece>();
  fen
    .split(" ")[0]
    .split("/")
    .forEach((row, ri) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else {
          board.set(String.fromCharCode(97 + f) + (8 - ri), { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? "w" : "b" });
          f++;
        }
      }
    });
  return board;
}

/** A FEN with its piece placement replaced by `board`. */
function withBoard(fen: string, board: Map<string, Piece>): string {
  const rows = [];
  for (let r = 8; r >= 1; r--) {
    let row = "";
    let gap = 0;
    for (let f = 0; f < 8; f++) {
      const pc = board.get(String.fromCharCode(97 + f) + r);
      if (!pc) gap++;
      else {
        row += (gap || "") + (pc.color === "w" ? pc.type.toUpperCase() : pc.type);
        gap = 0;
      }
    }
    rows.push(row + (gap || ""));
  }
  return [rows.join("/"), ...fen.split(" ").slice(1)].join(" ");
}

const sqXY = (sq: string, o: Color) => {
  const f = sq.charCodeAt(0) - 97;
  const r = Number(sq[1]) - 1;
  return o === "w" ? { x: f, y: 7 - r } : { x: 7 - f, y: r };
};

const moveLabel = (ply: number, san: string) => `${Math.ceil(ply / 2)}${ply % 2 ? "." : "…"} ${san}`;

/** An engine line in SAN with move numbers, from a FEN and UCI moves. */
function pvText(fen: string, pv: string[] | undefined, variant: Variant, n = 6): string {
  if (!pv?.length) return "";
  const c = newRules(fen, variant);
  let no = Number(fen.split(" ")[5]) || 1;
  const out: string[] = [];
  for (const u of pv.slice(0, n)) {
    const turn = c.turn();
    try {
      const mv = c.move(u);
      if (turn === "w") out.push(`${no}.`);
      else if (!out.length) out.push(`${no}…`);
      out.push(mv.san);
      if (turn === "b") no++;
    } catch {
      break;
    }
  }
  return out.join(" ");
}

/* ------------------------------ per-game precomputation ------------------------------ */

interface Prep {
  /** King square in check after move i (index into moves), or after the start for -1. */
  check: (string | undefined)[];
  /** Material after i+1 plies, indexed by plies played. */
  material: MaterialInfo[];
  /** Engine continuation from the position after move i, and the engine's preferred line from before it. */
  line: string[];
  bestLine: string[];
  /** White's win% after each ply, index 0 = start. */
  graph: number[];
  /** Each side's total thinking time after i plies. */
  clocks: Record<Color, number>[];
  /** Each player's own evaluation after their moves, as White's win%. */
  self: Record<Color, { ply: number; w: number }[]>;
  /** What each mover believed against the engine, by move index. */
  belief: (Belief | null)[];
  firstOutOfBook: number;
}

function scoreAt(g: Game, fen: string, fallback?: Score): Score | undefined {
  const a = g.analysis[fen];
  return a && !a.failed && a.depth > 0 ? a.score : fallback;
}

function prepare(g: Game): Prep {
  const sans = g.moves.map((m) => m.san);
  const variant = variantOf(g);
  const start = g.startFen ?? START_FEN;
  const check = g.moves.map((m) => checkSquare(m.fenAfter));
  const material = sans.map((_, i) => materialInfo(start, sans.slice(0, i + 1), variant));
  material.unshift(materialInfo(start, [], variant));
  const line = g.moves.map((m) => pvText(m.fenAfter, g.analysis[m.fenAfter]?.pv, variant));
  const bestLine = g.moves.map((m) => pvText(m.fenBefore, g.analysis[m.fenBefore]?.pv, variant));
  let last = 50;
  const graph = [start, ...g.moves.map((m) => m.fenAfter)].map((fen, i) => {
    const s = scoreAt(g, fen, g.moves[i - 1]?.analysis?.evalAfter);
    if (s) last = winPercentWhite(s);
    return last;
  });
  const self: Prep["self"] = { w: [], b: [] };
  for (const m of g.moves) if (m.selfEval !== null) self[m.color].push({ ply: m.ply, w: winPercentWhite({ cp: m.selfEval * 100 }) });
  // Each side's total thinking time after every move (index 0 = before the first move).
  const clocks: Prep["clocks"] = [{ w: 0, b: 0 }];
  for (const m of g.moves) {
    const prev = clocks[clocks.length - 1];
    clocks.push({ ...prev, [m.color]: prev[m.color] + m.thinkMs });
  }
  return { check, material, line, bestLine, graph, self, belief: beliefs(g), clocks, firstOutOfBook: g.moves.findIndex((m) => m.analysis?.classification !== "book") };
}

/* ------------------------------ what's on screen at time t ------------------------------ */

interface BoardView {
  /** Index of the last move on the board (-1 = start position). */
  i: number;
  fen: string;
  anim?: { from: string; to: string; p: number; rook?: [string, string]; captured?: { sq: string; piece: Piece; p: number } };
  lastMove?: [string, string];
  check?: string;
  badge?: { sq: string; c: Classification; s: number };
  arrow?: [string, string];
  /**
   * What a thinking player names, drawn as it's said: arrows (the mover's side's, or the opponent's; `hit`,
   * a piece's reach rather than a move) and rings (`own`: around the mover's piece, or the opponent's;
   * neither, an empty square), each at opacity `o` and `pop` of the way through snapping in.
   */
  marks?: { arrows: { from: string; to: string; own: boolean; hit?: boolean; o: number; pop: number }[]; rings: { sq: string; own?: boolean; o: number; pop: number }[] };
  illegal?: { attempt: string; sq?: string; color: Color; p: number };
  /** A marker on a king: the draw offer or the white flag. */
  mark?: { sq: string; emoji: string; s: number };
  /** An engine line, not the game: the board is tinted. */
  engine?: boolean;
  evalW: number;
  evalText: string;
}

interface View {
  idx: number;
  kind: Scene["kind"];
  fade: number;
  board?: BoardView;
  /**
   * `status` is a plain one-line banner ("… is thinking") instead of a move verdict. `whatIf`: an engine line,
   * saying what it is ("What if 69… Kg4?", the line under it why), blue, or red for a punishment.
   */
  callout?: { label: string; cls?: Classification; evalText: string; bestWas?: string; status?: boolean; sub?: string; took?: string; whatIf?: "line" | "punish" };
  /** `color`: the line is about a player (what they thought), in their colour. */
  line?: { label: string; text: string; color?: string };
  /**
   * The thought before a key move, while the game stops for it: a bright bubble off the board, under the move
   * list in the YouTube cut (which makes room for it as it opens, and dims), above the board in the short.
   * `open`: how far the box is open (0 → 1 as it starts, back to 0 after). `prev`: the thought it's taking
   * over from, if one ran straight into it, by `mix` (0 → 1), the box going from one's height to the other's.
   */
  speech?: { now: Said; prev?: Said; mix: number; open: number };
  /**
   * Asides being said while the game plays on: comments in the move list, the way an annotated game writes
   * them, under the move they hang from (`after`, a move index), scrolling up with the list as moves come.
   * In the short, in the chart's place. `open`: how far each has folded open.
   */
  asides?: { text: string; color: Color; after: number; open: number }[];
  reveal?: number;
  /** The cold open's caption, over the payoff moment. */
  hook?: string;
  /** The wind-back after the cold open: 0 → 1 over the scene. */
  rewind?: number;
  /** On a key moment where the mover misjudges (or finally sees the truth): what they think, then the engine. */
  /** Whose belief the eval bar features: the player of move i (about to play it, during their thinking), and whether it gets a name label. */
  focus?: { i: number; label: boolean };
  /** Each side's thinking time so far, shown on the player cards. */
  clocks?: Record<Color, number>;
  /** The captured pieces on the cards, when the board isn't a position of the game (an engine line). */
  material?: MaterialInfo;
  /**
   * An engine line playing out (or the punishment before it), as a variation in the move list: the game's
   * moves up to the one it branches from (`ply` of them, the last highlighted when `current`), its moves
   * (played, the newest, still to come), and its caption under it as a comment; and on the eval graph,
   * where it would have led (faded in, o).
   */
  engine?: {
    punish?: boolean;
    /** How far the variation has opened (0 → 1): it unfolds as it comes and folds away as it goes. */
    open: number;
    /** How much of the line under the verdict shows (1 → 0 → 1): it folds away for the whole engine line. */
    under: number;
    ply: number;
    current: boolean;
    moves: { label: string; state: "done" | "now" | "next" }[];
    caption?: { text: string; lit: Lit[]; o: number };
    compare?: LineCompare & { o: number };
  };
}

/** A thought in the speech box, with its self-eval and the words its marks light up. */
type Said = { text: string; color: Color; selfEval: string; lit?: Lit[] };

const GAME_SCENES: Scene["kind"][] =["move", "illegal", "think", "draw", "resign", "rewind", "line"];
const isGameScene = (s: Scene | undefined) => !!s && GAME_SCENES.includes(s.kind);

const kingSquare = (fen: string, c: Color) => [...fenBoard(fen)].find(([, p]) => p.type === "k" && p.color === c)?.[0];

/** The position after move i, settled: what the board shows once a move has landed. */
function settledBoard(g: Game, prep: Prep, i: number): BoardView {
  const m = g.moves[i];
  const score = scoreAt(g, m.fenAfter, m.analysis?.evalAfter);
  return {
    i,
    fen: m.fenAfter,
    lastMove: [m.from, m.to],
    check: prep.check[i],
    badge: m.analysis && { sq: m.to, c: m.analysis.classification, s: 1 },
    evalW: r3(score ? winPercentWhite(score) : 50),
    evalText: formatScore(score),
  };
}

type AnimMove = { from: string; to: string; san: string; uci: string; color: Color };

/** A move sliding into place, p of the way (0 → 1), with any castling rook and the piece it takes. */
function moveAnim(fenBefore: string, m: AnimMove, variant: Variant, p: number): NonNullable<BoardView["anim"]> {
  const pre = fenBoard(fenBefore);
  const pc = pre.get(m.from);
  // Castling: the king lands on g/c and its rook on f/d. In Chess960 the rook starts wherever the
  // UCI says (king-takes-rook); in standard chess it's the corner.
  const castle = pc?.type === "k" && m.san.startsWith("O-O");
  const rank = m.from[1];
  const kingside = m.to[0] === "g";
  const rookFrom = variant === "chess960" ? m.uci.slice(2, 4) : `${kingside ? "h" : "a"}${rank}`;
  const rook: [string, string] | undefined = castle ? [rookFrom, `${kingside ? "f" : "d"}${rank}`] : undefined;
  const enPassant = pc?.type === "p" && m.from[0] !== m.to[0] && !pre.get(m.to);
  const capSq = enPassant ? m.to[0] + m.from[1] : m.to;
  const capPiece = pre.get(capSq);
  return {
    from: m.from,
    to: m.to,
    p: r3(ease(p)),
    rook,
    captured: capPiece && capPiece.color !== m.color ? { sq: capSq, piece: capPiece, p: r3(p) } : undefined,
  };
}

/** The king in check in a position, if any. */
function checkSquare(fen: string): string | undefined {
  const c = looseChess(fen);
  if (!c.inCheck()) return undefined;
  const turn = c.turn();
  for (const row of c.board()) for (const sq of row) if (sq?.type === "k" && sq.color === turn) return sq.square;
  return undefined;
}

/**
 * A caption of an engine line, ready to show once `k` of its moves are on the board, all as the director
 * gave it: the words its refs light up (the ones naming the board, or all of a ref's words when none do),
 * in the colour of the side they point at (none: an empty square); its circles, each on the piece a ref to
 * its square names, or else what stands there; and its reaches. Each circle and reach is up while its
 * piece stays put.
 */
interface LineNote {
  caption: string;
  k: number;
  lit: { word: number; color?: Color }[];
  rings: { sq: string; piece?: Piece }[];
  draw: { from: string; to: string; color: Color; piece?: Piece }[];
}

/** Moves as a variation is written, from the ply of the first: "69… Kg4", "70. Ng1", "h4", "71. Kf2". */
const variation = (sans: string[], ply: number) =>
  sans.map((san, j) => {
    const p = ply + j;
    return p % 2 ? `${Math.ceil(p / 2)}. ${san}` : j ? san : `${p / 2}… ${san}`;
  });

/**
 * What the move played cost, on the eval graph, for an "instead" line: at the move (`at`, an index into
 * the graph), where the game went with it (`real`, the point the graph already shows) and where the line
 * would have kept it (`line`, White's win% `w`), both labelled. (An "after" line starts from the position
 * on the graph, so it has nothing to compare.)
 */
type LineCompare = { at: number; line: { label: string; eval: string; w: number }; real: { label: string; eval: string } };

/**
 * An engine line ready to play: the material and check after each of its plies (index 0 = none yet), its
 * moves as written in a variation, and its caption; and, when the director tells it, the punishment of the
 * move played the same way (its moves start with the move played, already in the move list, so its
 * variation leaves that one out).
 */
interface LinePrep {
  sl: ShownLine;
  material: MaterialInfo[];
  check: (string | undefined)[];
  labels: string[];
  note: LineNote;
  compare?: LineCompare;
  punish?: { moves: RulesMove[]; material: MaterialInfo[]; labels: string[]; note: LineNote };
  /**
   * The plan's branches of the line, by their index in it (none: it can't be shown any more): each one's path
   * (the line's first `at` moves, then its own) with the material, check and variation labels after each of its
   * plies, its own moves' badges, and what it's called up top.
   */
  branches?: (LineBranchPrep | undefined)[];
}
interface LineBranchPrep {
  br: ShownBranch;
  path: RulesMove[];
  material: MaterialInfo[];
  check: (string | undefined)[];
  labels: string[];
  verdicts: (Classification | undefined)[];
  label: string;
  sub: string;
  /** The side the line favours plays it, and it throws the win away. */
  fails: boolean;
}
const lineCache = new WeakMap<Prep, Map<string, LinePrep | null>>();

const ANNOTATION: Partial<Record<Classification, string>> = { brilliant: "!!", great: "!", blunder: "??", mistake: "?", miss: "?", inaccuracy: "?!" };

function lineNote(caption: string, note: { refs?: LineRef[]; draw?: LineReach[]; rings?: string[] }, fen: string, moves: RulesMove[], k: number, side: Color): LineNote {
  const refs = note.refs ?? [];
  const colors = resolveLineRefs(caption, refs, fen, moves, k, side);
  const ws = quoteWords(caption);
  const board = boardOf(fenAt(fen, moves, k));
  const lit: LineNote["lit"] = [];
  refs.forEach((r, j) => {
    const c = colors[j];
    if ("problem" in c) return;
    const span = Array.from({ length: r.words[1] - r.words[0] + 1 }, (_, n) => r.words[0] + n);
    const naming = span.filter((n) => pointsAt(ws[n]).length);
    for (const word of naming.length ? naming : span) lit.push({ word, ...(c.color && { color: c.color }) });
  });
  const rings = (note.rings ?? []).map((sq) => {
    const j = refs.findIndex((r) => r.sqs?.includes(sq));
    const c = colors[j];
    const piece = c && "pieces" in c ? c.pieces[refs[j].sqs!.indexOf(sq)] : board.get(sq);
    return { sq, ...(piece && { piece }) };
  });
  return { caption, k, lit, rings, draw: (note.draw ?? []).map((d) => ({ ...d, ...(board.get(d.from) && { piece: board.get(d.from) }) })) };
}

function linePrep(g: Game, prep: Prep, i: number, kind: LineKind): LinePrep | null {
  const cache = lineCache.get(prep) ?? new Map<string, LinePrep | null>();
  lineCache.set(prep, cache);
  const key = `${i}:${kind}`;
  if (cache.has(key)) return cache.get(key)!;
  const ask = g.video?.moments.find((x) => x.ply === g.moves[i]?.ply)?.line;
  const sl = ask?.kind === kind ? planLine(g, i, ask) : shownLine(g, i, kind, true);
  let out: LinePrep | null = null;
  if (sl) {
    const variant = variantOf(g);
    const m = g.moves[i];
    const a = m.analysis!;
    const start = g.startFen ?? START_FEN;
    // The real game up to where the line starts, then the line.
    const played = g.moves.slice(0, kind === "instead" ? i : i + 1).map((mv) => mv.san);
    const sans = sl.moves.map((mv) => mv.san);
    // The variation marks its hard moves as an annotated game does: "Qh5!", "Bxh7+!!".
    const verdicts = lineVerdicts(g, sl.moves);
    const marked = sans.map((san, j) => (verdicts[j] === "great" || verdicts[j] === "brilliant" ? `${san}${ANNOTATION[verdicts[j]!]}` : san));
    const ks = [...Array(sl.moves.length + 1).keys()];
    const first = kind === "instead" ? m.ply : m.ply + 1;
    const lineScore = scoreAt(g, sl.fen);
    const compare: LineCompare | undefined =
      kind === "instead"
        ? {
            at: i + 1,
            line: { label: sans[0], eval: formatScore(lineScore), w: lineScore ? winPercentWhite(lineScore) : prep.graph[i] },
            real: { label: `${m.san}${ANNOTATION[a.classification] ?? ""}`, eval: formatScore(scoreAt(g, m.fenAfter, a.evalAfter)) },
          }
        : undefined;
    out = {
      sl,
      material: ks.map((k) => materialInfo(start, [...played, ...sans.slice(0, k)], variant)),
      check: ks.map((k) => checkSquare(k ? sl.moves[k - 1].after : sl.fen)),
      labels: variation(marked, first),
      // The line's own fact, when the director wrote no caption, lights and draws nothing.
      note: lineNote(ask?.caption ?? sl.caption, ask?.caption ? ask : {}, sl.fen, sl.moves, sl.moves.length, sl.for),
      compare,
    };
    if (ask?.punish && sl.punish) {
      const pm = sl.punish.moves;
      const before = g.moves.slice(0, i).map((mv) => mv.san);
      out.punish = {
        moves: pm,
        // Index k: k of the punishment's moves after the one played on the board.
        material: pm.map((_, k) => materialInfo(start, [...before, ...pm.slice(0, k + 1).map((mv) => mv.san)], variant)),
        labels: variation(pm.slice(1).map((mv) => mv.san), m.ply + 1),
        note: lineNote(ask.punish.caption, ask.punish, m.fenBefore, pm, ask.punish.at, sl.for),
      };
    }
    if (ask?.kind === kind && ask.branches?.length)
      out.branches = ask.branches.map((b): LineBranchPrep | undefined => {
        const br = planBranch(g, sl, b);
        if (!br) return undefined;
        const path = [...sl.moves.slice(0, br.at), ...br.moves];
        const own = lineVerdicts(g, br.moves);
        const pathSans = path.map((mv) => mv.san);
        const marks = path.map((mv, j) => {
          const v = j < br.at ? verdicts[j] : own[j - br.at];
          return v === "great" || v === "brilliant" ? `${mv.san}${ANNOTATION[v]}` : mv.san;
        });
        const ks = [...Array(path.length + 1).keys()];
        const fails = br.mover === sl.for && br.winLine - br.winBranch >= 25;
        const altLabel = moveLabel(first + br.at, br.moves[0].san);
        return {
          br,
          path,
          material: ks.map((k) => materialInfo(start, [...played, ...pathSans.slice(0, k)], variant)),
          check: ks.map((k) => checkSquare(k ? path[k - 1].after : sl.fen)),
          labels: variation(marks, first),
          verdicts: own,
          label: fails ? `Why not ${altLabel}?` : `What if ${altLabel}?`,
          sub: fails ? `${sideName(g, sl.for)}'s natural move, and what goes wrong` : `${sideName(g, br.mover)}'s other try`,
          fails,
        };
      });
  }
  cache.set(key, out);
  return out;
}

/** How long an engine line's variation takes to unfold into the move list, or fold away. */
const FOLD = 0.35;
/** The line under the verdict's height, and the gap between the panel's boxes (video.css .v-line, .v-panel). */
const LINE_ROW = 34;
const PANEL_GAP = 18;

/**
 * The speech box (see View.speech): how long it takes to open or close, how long one line takes to hand over
 * to the next, and how close two lines must be for the next to take over without the box closing between.
 */
const SPEECH_OPEN = 0.4;
const SPEECH_SWAP = 0.35;
const SPEECH_JOIN = 0.6;
/** The gap above the speech box once it's open (video.css .v-ml-wrap). */
const SPEECH_GAP = 14;

/** The thoughts before key moves, in order, each with its span and its think scene (whose marks light its words). */
interface SpeechSpan {
  start: number;
  end: number;
  said: Said;
  scene: number;
}
const speechCache = new WeakMap<Timeline, SpeechSpan[]>();
function speechOf(g: Game, tl: Timeline): SpeechSpan[] {
  let spans = speechCache.get(tl);
  if (!spans) {
    spans = tl.scenes.flatMap((s, scene): SpeechSpan[] => {
      if (s.kind !== "think") return [];
      const m = g.moves[s.i];
      return [{ start: s.start, end: s.start + s.dur, scene, said: { text: s.thought, color: m.color, selfEval: m.selfEvalRaw } }];
    });
    speechCache.set(tl, spans);
  }
  return spans;
}

/**
 * Where each aside hangs in the move list: under the last move on the board when it starts (its own move,
 * or one before it when it starts early; before a rejected attempt, the move before).
 */
const anchorCache = new WeakMap<Timeline, number[]>();
function asideAnchors(tl: Timeline): number[] {
  let anchors = anchorCache.get(tl);
  if (!anchors) {
    anchors = tl.asides.map((a) => {
      let at = -1;
      for (const s of tl.scenes) {
        if (s.start > a.start + 0.01) break;
        if (s.kind === "move" && !s.hook) at = s.i;
        else if (s.kind === "illegal") at = s.i - 1;
      }
      return at;
    });
    anchorCache.set(tl, anchors);
  }
  return anchors;
}

/** The asides showing at time t, each folding open as its line starts and away after it ends. */
function asidesAt(g: Game, tl: Timeline, t: number): View["asides"] {
  const anchors = asideAnchors(tl);
  const out = tl.asides.flatMap((a, k) => {
    // The narrator's beats are the engine line's comments, not the players' asides.
    if (a.narrator) return [];
    const end = a.start + a.dur;
    if (t < a.start || t >= end + SPEECH_OPEN) return [];
    const open = Math.min(ease(clamp01((t - a.start) / SPEECH_OPEN)), t < end ? 1 : 1 - ease(clamp01((t - end) / SPEECH_OPEN)));
    return open > 0 ? [{ text: a.text, color: g.moves[a.i].color, after: anchors[k], open: r3(open) }] : [];
  });
  return out.length ? out : undefined;
}

/**
 * The thought being said at time t, if any: the box opens as it starts and closes after it ends, unless the
 * next follows straight on, which then takes over in the open box. `lit`: the words the current think
 * scene's marks light up.
 */
function speechAt(g: Game, tl: Timeline, t: number, idx: number, lit: Lit[]): View["speech"] {
  const spans = speechOf(g, tl);
  let k = -1;
  for (let n = 0; n < spans.length && spans[n].start <= t; n++) k = n;
  const cur = spans[k];
  if (!cur) return undefined;
  const joinedIn = k > 0 && cur.start - spans[k - 1].end < SPEECH_JOIN;
  const joinedOut = k + 1 < spans.length && spans[k + 1].start - cur.end < SPEECH_JOIN;
  const opening = joinedIn ? 1 : ease(clamp01((t - cur.start) / SPEECH_OPEN));
  const open = t < cur.end || joinedOut ? opening : Math.min(opening, 1 - ease(clamp01((t - cur.end) / SPEECH_OPEN)));
  if (open <= 0) return undefined;
  const mix = joinedIn ? ease(clamp01((t - cur.start) / SPEECH_SWAP)) : 1;
  const now = { ...cur.said, ...(cur.scene === idx && lit.length && { lit }) };
  return { now, ...(mix < 1 && { prev: spans[k - 1].said }), mix: r3(mix), open: r3(open) };
}

/**
 * A word of the thought lit up in the colour of what it names while that's on the board, at opacity o, from
 * `at`. Where two drawings light the same word, the later one (what's being said now) colours it.
 */
type Lit = { word: number; color: string; o: number; at: number };

/**
 * The marks on the board at `local` seconds into a scene, and the words they light up. Each mark builds
 * up, arrow by arrow, and comes off fading as the next one starts drawing (or its sentence ends). Each
 * item snaps in with a little pop; in a line of three moves or more, a move dims once the next is drawn,
 * so the eye follows the newest. `alpha` fades the lot (a kept mark, as its move is played).
 */
function marksAt(marks: SceneMark[], local: number, mover: Color, alpha = 1): { marks?: BoardView["marks"]; lit: Lit[] } {
  const arrows: NonNullable<BoardView["marks"]>["arrows"] = [];
  const rings: NonNullable<BoardView["marks"]>["rings"] = [];
  const lit: Lit[] = [];
  const pop = (at: number) => r3(clamp01((local - at) / 0.2));
  // Everything is coloured by what it points at, on the board and in the bubble alike: the speaker's
  // piece (or move) green, the opponent's red, an empty square amber.
  const sideColor = (c: Color | undefined) => (c ? (c === mover ? OWN_ARROW : OPP_ARROW) : RING);
  const shown = (at: number) => clamp01((local - at) / 0.08);
  for (const mk of marks) {
    // A drawing the next mark repeats soon stays up (`hold`) past this mark's coming off, until it's drawn again.
    const held = Math.max(-Infinity, ...mk.arrows.map((a) => a.hold ?? -Infinity), ...mk.rings.map((r) => r.hold ?? -Infinity));
    if (local < mk.start || (local >= mk.end + MARK_FADE && local >= held)) continue;
    const a0 = alpha * (local < mk.end ? 1 : Math.max(0, 1 - (local - mk.end) / MARK_FADE));
    const stays = (hold?: number) => (hold !== undefined && local < hold ? alpha : a0);
    const moves = mk.arrows.filter((a) => !a.hit);
    for (const a of mk.arrows) {
      if (a.at > local) continue;
      let o = stays(a.hold) * shown(a.at);
      if (!a.hit && moves.length >= 3) {
        const next = moves[moves.indexOf(a) + 1];
        if (next && next.at <= local) o *= 1 - 0.45 * ease(clamp01((local - next.at) / 0.2));
      }
      const own = a.color === mover;
      if (o > 0) arrows.push({ from: a.from, to: a.to, own, ...(a.hit && { hit: true }), o: r3(o), pop: pop(a.at) });
      // Each word lights up as it's said (an arrow can name a piece a few words later: "Rxe8+ … the rook"),
      // in the colour of the side whose piece it names: an arrow to the opponent's knight lights "Nd7" red.
      for (const l of a.lit) if (l.at <= local) lit.push({ word: l.word, color: sideColor(l.color), o: r3(a0 * shown(a.at) * shown(l.at)), at: l.at });
    }
    for (const r of mk.rings) {
      if (r.at > local) continue;
      const o = stays(r.hold) * shown(r.at);
      if (o > 0) rings.push({ sq: r.sq, ...(r.side && { own: r.side === mover }), o: r3(o), pop: pop(r.at) });
      // Words come off with their mark, even under a drawing that stays up.
      for (const l of r.lit) if (l.at <= local) lit.push({ word: l.word, color: sideColor(l.color), o: r3(a0 * shown(r.at) * shown(l.at)), at: l.at });
    }
    // The director's refs: exactly the words it said point at the board.
    for (const l of mk.lit ?? []) if (l.at <= local) lit.push({ word: l.word, color: sideColor(l.color), o: r3(a0 * shown(l.at)), at: l.at });
  }
  // The same arrow or circle drawn by two marks at once (the idea coming off, the next one drawing it
  // again) is one drawing: as solid and as settled as the more so, so it stays put rather than fading out
  // and popping back in.
  const once = <T extends { o: number; pop: number }>(items: T[], key: (x: T) => string) => {
    const by = new Map<string, T>();
    for (const x of items) {
      const had = by.get(key(x));
      by.set(key(x), had ? { ...had, o: Math.max(had.o, x.o), pop: Math.max(had.pop, x.pop) } : x);
    }
    return [...by.values()];
  };
  const drawn = {
    arrows: once(arrows, (a) => `${a.from}${a.to}${a.hit ? "~" : ""}${a.own}`),
    rings: once(rings, (r) => `${r.sq}${r.own}`),
  };
  return { marks: arrows.length || rings.length ? drawn : undefined, lit };
}

/** Worth calling out: the mover is far from the truth, or has just come back to it. */
const telling = (b: Belief | null) => !!b && (!!b.state || b.change === "realizes");

function derive(g: Game, tl: Timeline, prep: Prep, t: number): View {
  const s = sceneAt(tl, t);
  const idx = tl.scenes.indexOf(s);
  const local = Math.max(0, t - s.start);
  // Cut between game scenes; fade into everything else.
  const fade = isGameScene(s) && isGameScene(tl.scenes[idx - 1]) ? 1 : r3(clamp01(local / 0.35));
  const v: View = { idx, kind: s.kind, fade };
  // The words the thought's marks light up, for the speech box.
  let thinkLit: Lit[] = [];

  if (s.kind === "interview") v.reveal = s.text.split(/\s+/).length;
  if ((s.kind === "think" || s.kind === "move") && s.hook) v.hook = s.hook;

  if (s.kind === "rewind") {
    // The game winds back from the cold open's move to the start, quickly at first, settling at move 0.
    const p = ease(clamp01(local / Math.max(0.1, s.dur - 0.35)));
    const k = Math.round(s.i - p * (s.i + 1));
    const m = g.moves[k];
    v.board = {
      i: k,
      fen: m ? m.fenAfter : (g.startFen ?? START_FEN),
      lastMove: m && [m.from, m.to],
      check: m ? prep.check[k] : undefined,
      evalW: r3(prep.graph[k + 1]),
      evalText: "",
    };
    v.clocks = prep.clocks[k + 1];
    v.rewind = r3(p);
  }

  if (s.kind === "think") {
    const m = g.moves[s.i];
    const prev = g.moves[s.i - 1];
    const score = scoreAt(g, m.fenBefore, prev?.analysis?.evalAfter);
    const name = sideName(g, m.color);
    // Their clock runs while the bubble is up, to their total after this move: from before it, or from
    // their last illegal attempt, shown just before.
    const before = prep.clocks[s.i];
    const from = Math.min(m.thinkMs, triesOf(m.illegalAttempts, m.tries).at(-1)?.thinkMs ?? 0);
    const spent = Math.floor((from + (m.thinkMs - from) * clamp01(local / s.dur)) / 1000) * 1000;
    v.clocks = { ...before, [m.color]: before[m.color] + spent };
    v.board = {
      i: s.i - 1,
      fen: m.fenBefore,
      lastMove: prev && [prev.from, prev.to],
      check: prep.check[s.i - 1],
      evalW: r3(score ? winPercentWhite(score) : 50),
      evalText: formatScore(score),
    };
    // Only the idea being said is up: the board wipes for each new one.
    const drawn = s.marks ? marksAt(s.marks, local, m.color) : { lit: [] };
    if (drawn.marks) v.board.marks = drawn.marks;
    v.callout = { label: `${name} is thinking…`, evalText: formatScore(score), status: true };
    thinkLit = drawn.lit;
    // While they think, the bar already shows where they believe their move leaves them; the engine's
    // level only moves once it lands.
    v.focus = { i: s.i, label: telling(prep.belief[s.i]) };
  }

  if (s.kind === "draw") {
    const m = g.moves[s.i];
    const name = (c: Color) => sideName(g, c);
    const b = settledBoard(g, prep, s.i);
    v.clocks = prep.clocks[s.i + 1];
    const sq = kingSquare(m.fenAfter, m.color);
    if (sq) b.mark = { sq, emoji: "🤝", s: r3(easeOutBack(clamp01(local / 0.3))) };
    v.board = b;
    const answered = local >= 1.1;
    const reply = s.answer === "declined" ? `${name(other(m.color))} declines — play on` : s.answer === "accepted" ? `${name(other(m.color))} accepts` : "";
    v.callout = { label: `🤝 ${name(m.color)} offers a draw`, evalText: b.evalText, status: true, sub: answered && reply ? reply : undefined };
  }

  if (s.kind === "resign") {
    const last = g.moves.length - 1;
    const b = settledBoard(g, prep, last);
    const sq = kingSquare(g.moves[last].fenAfter, s.color);
    if (sq) b.mark = { sq, emoji: "🏳️", s: r3(easeOutBack(clamp01(local / 0.3))) };
    v.board = b;
    v.callout = { label: `🏳️ ${sideName(g, s.color)} resigns`, evalText: b.evalText, status: true };
    v.clocks = prep.clocks[last + 1];
  }

  if (s.kind === "illegal") {
    const m = g.moves[s.i];
    const prev = g.moves[s.i - 1];
    const score = scoreAt(g, m.fenBefore, prev?.analysis?.evalAfter);
    // The attempt is played on the board anyway, like a premove (any piece of the named kind, legal or
    // not), then slides back as it's rejected.
    const path = illegalMovePath(m.fenBefore, s.attempt);
    let fen = m.fenBefore;
    let anim: BoardView["anim"];
    if (path) {
      const board = fenBoard(m.fenBefore);
      const pc = board.get(path.from)!;
      const rook = path.rook && board.get(path.rook[0]);
      board.delete(path.from);
      if (path.rook) board.delete(path.rook[0]);
      const captured = board.get(path.to);
      board.set(path.to, path.promo ? { type: path.promo, color: pc.color } : pc);
      if (path.rook && rook) board.set(path.rook[1], rook);
      fen = withBoard(m.fenBefore, board);
      const p = ease(Math.min(clamp01(local / 0.25), clamp01((s.dur - local) / 0.3)));
      anim = {
        from: path.from,
        to: path.to,
        p: r3(p),
        rook: path.rook && rook ? path.rook : undefined,
        captured: captured && { sq: path.to, piece: captured, p: r3(p) },
      };
    }
    v.board = {
      i: s.i - 1,
      fen,
      anim,
      lastMove: prev && [prev.from, prev.to],
      check: prep.check[s.i - 1],
      evalW: r3(score ? winPercentWhite(score) : 50),
      evalText: formatScore(score),
      illegal: { attempt: s.attempt, sq: path?.to ?? s.attempt.match(/[a-h][1-8](?!.*[a-h][1-8])/)?.[0], color: m.color, p: r3(clamp01(local / 0.25)) },
    };
    // Their clock as it was when the attempt was sent (older games don't know: the start of the turn).
    const before = prep.clocks[s.i];
    const sentAt = Math.min(m.thinkMs, triesOf(m.illegalAttempts, m.tries)[s.n]?.thinkMs ?? 0);
    v.clocks = { ...before, [m.color]: before[m.color] + Math.floor(sentAt / 1000) * 1000 };
  }

  if (s.kind === "line") {
    const m = g.moves[s.i];
    const L = linePrep(g, prep, s.i, s.line);
    // The last real move under the line: for "instead", the move is taken back first.
    const real = s.line === "instead" ? s.i - 1 : s.i;
    if (!L) v.board = settledBoard(g, prep, s.i);
    else {
      const { sl } = L;
      const variant = variantOf(g);
      const label = moveLabel(m.ply, m.san);
      const fade = (at: number, d = 0.35) => r3(clamp01((local - at) / d));
      // Coloured as everywhere else, from the side the line favours: its pieces green, the other side's red.
      const litColor = (c: Color | undefined) => (c ? (c === sl.for ? LIT_OWN : LIT_OPP) : LIT_EMPTY);
      // The newest of a run of moves on the board, while it's still sliding in.
      const slide = (moves: RulesMove[], moveAt: number[], k: number) => {
        const mv = moves[k - 1];
        const p = k ? clamp01((local - moveAt[k - 1]) / LINE_SLIDE) : 1;
        return mv && p < 1 ? moveAnim(mv.before, mv, variant, p) : undefined;
      };
      // A caption's circles and reaches, from when it shows, each while its piece stays on its square.
      const noted = (note: LineNote, fen: string, from: number, alpha: number) => {
        if (local < from) return { rings: [], arrows: [] };
        const board = fenBoard(fen);
        const stays = (sq: string, pc?: Piece) => (pc ? board.get(sq)?.type === pc.type && board.get(sq)?.color === pc.color : !board.get(sq));
        const o = r3(alpha * fade(from, 0.2));
        const pop = fade(from, 0.2);
        return {
          rings: note.rings.filter((r) => stays(r.sq, r.piece)).map((r) => ({ sq: r.sq, ...(r.piece && { own: r.piece.color === sl.for }), o, pop })),
          arrows: note.draw.filter((d) => stays(d.from, d.piece)).map((d) => ({ from: d.from, to: d.to, own: d.color === sl.for, hit: true, o, pop })),
        };
      };
      const caption = (note: LineNote, from: number, alpha: number) => {
        const o = r3(fade(from) * alpha);
        return o > 0 ? { text: note.caption, lit: note.lit.map((l) => ({ word: l.word, color: litColor(l.color), o: 1, at: from })), o } : undefined;
      };
      // A variation's moves as they're played: the ones played, and the newest (the position on the board,
      // highlighted as the game's current move is). The ones still to come aren't written yet, so the list never
      // gives away a move before the board (and the narrator) gets to it.
      const track = (labels: string[], k: number) => labels.slice(0, Math.max(0, k)).map((label, j) => ({ label, state: (j < k - 1 ? "done" : "now") as "done" | "now" | "next" }));
      // Up top, what's being shown, in words: what the move allows, what if the better move had been played,
      // how it could have been punished, or why it works. Only the eval follows the board. The line under the
      // move's verdict folds away as the variation opens, and comes back as it closes.
      const a = m.analysis;
      // As on the move: an `instead` line revealed after it doesn't name its answer under the verdict either.
      const askLine = g.video?.moments.find((x) => x.ply === m.ply)?.line;
      const spoiler = s.line === "instead" && !s.first && !askLine?.showBest;
      const bad = !!a?.bestUci && a.bestUci !== m.uci && SHOW_BEST.includes(a.classification) && !spoiler;
      const marked = `${m.san}${(a && ANNOTATION[a.classification]) ?? ""}`;
      // The line's first move is only named up top once it's on the board: "What if…?" until then.
      const whatIf = (evalText: string, punish: boolean, revealed = true): View["callout"] => {
        const firstLabel = revealed ? moveLabel(s.line === "instead" ? m.ply : m.ply + 1, sl.moves[0].san) : "…";
        if (punish) return { label: `What ${label} allows`, sub: `The engine's best answer for ${sideName(g, other(m.color))}`, evalText, whatIf: "punish" };
        // Played before the move: what was there, without giving away what they played.
        if (s.first) return { label: `What if ${firstLabel}?`, sub: `What ${sideName(g, m.color)} had here`, evalText, whatIf: "line" };
        if (s.line === "instead") return { label: `What if ${firstLabel}?`, sub: `${sideName(g, m.color)}'s better move, instead of ${marked}`, evalText, whatIf: "line" };
        if (sl.for !== m.color) return { label: `What if ${firstLabel}?`, sub: `How ${sideName(g, sl.for)} could have punished ${marked}`, evalText, whatIf: "line" };
        return { label: `Why ${marked} works`, sub: "The engine's line from here", evalText, whatIf: "line" };
      };
      v.line = s.first ? undefined : verdictLine(g, prep, s.i, bad, telling(prep.belief[s.i]));
      // A move's badge as it lands in a line (`land`: when it settled), popping in like a game move's.
      const badgeOf = (mv: RulesMove | undefined, c: Classification | undefined, land: number): BoardView["badge"] =>
        mv && c ? { sq: mv.to, c, s: r3(easeOutBack(clamp01((local - land) / 0.3))) } : undefined;
      // The narrator's line being said, as the variation's comment (the director's caption takes over at the end).
      const beatNow = s.beats?.filter((b) => b.at <= local).at(-1);
      // What the narrator draws on its words, on the board as it stands (`fen`), each from when its word is said;
      // the words light up in the colour of what they point at.
      const beatDrawn = (fen: string) => {
        const board = fenBoard(fen);
        const arrows: NonNullable<BoardView["marks"]>["arrows"] = [];
        const rings: NonNullable<BoardView["marks"]>["rings"] = [];
        const lit: Lit[] = [];
        for (const d of beatNow?.draws ?? []) {
          const t0 = beatNow!.at + d.at;
          if (local < t0) continue;
          const o = r3(clamp01((local - t0) / 0.08));
          const pop = r3(clamp01((local - t0) / 0.2));
          const pc = board.get(d.ring ?? d.from ?? "");
          if (d.ring) rings.push({ sq: d.ring, ...(pc && { own: pc.color === sl.for }), o, pop });
          else if (d.from && d.to) arrows.push({ from: d.from, to: d.to, own: (pc?.color ?? sl.for) === sl.for, hit: true, o, pop });
          // The words name what the drawing points at: the circled piece, or the piece a reach hits (else the one reaching).
          const named = d.ring ? pc : (board.get(d.to ?? "") ?? pc);
          for (let w = d.word; w <= (d.last ?? d.word); w++) lit.push({ word: w, color: litColor(named?.color), o: 1, at: t0 });
        }
        return { arrows, rings, lit };
      };
      // A branch's beats after the caption (an "after" branch) take over from it.
      const comment = (from: number, lit: Lit[] = []) =>
        s.caption && local >= s.captionAt && !(beatNow && beatNow.at > s.captionAt) ? caption(L.note, s.captionAt, 1) : beatNow ? { text: beatNow.text, lit, o: r3(fade(beatNow.at, 0.25)) } : from >= 0 ? caption(L.note, from, 1) : undefined;
      // Opening over FOLD at the start, closing over FOLD at the end, and for a punishment, closing as the
      // board winds back and the line's variation opening in its place. The line under the verdict stays
      // folded away in between.
      const unfold = (from: number, to: number) => r3(ease(clamp01((local - from) / FOLD)) * ease(clamp01((to - local) / FOLD)));
      const under = r3(1 - unfold(s.enterAt, s.restoreEnd));
      const drawn = (arrows: NonNullable<BoardView["marks"]>["arrows"], rings: NonNullable<BoardView["marks"]>["rings"]) => (arrows.length || rings.length ? { arrows, rings } : undefined);

      const sp = s.punish;
      const P = L.punish;
      if (sp && P && local < sp.back[1]) {
        // What the move played allowed, from the position it left, then wound back a move at a time (the
        // move played last) to before it, for the line. `on`: how many of its moves are on the board.
        const pm = P.moves;
        const n = sp.sans.length;
        let on: number;
        let fen: string;
        let anim: BoardView["anim"];
        let alpha = 1;
        if (local < sp.back[0]) {
          on = sp.moveAt.filter((t) => t <= local).length + 1;
          fen = pm[on - 1].after;
          anim = slide(pm.slice(1), sp.moveAt, on - 1);
        } else {
          const frame = rewindFrame(pm, sp.back, local);
          on = frame.count;
          fen = frame.move.after;
          anim = moveAnim(frame.move.before, frame.move, variant, frame.progress);
          alpha = 1 - clamp01((local - sp.back[0]) / (sp.back[1] - sp.back[0]));
        }
        const last = pm[on - 1];
        const score = scoreAt(g, m.fenAfter, m.analysis?.evalAfter);
        const evalText = formatScore(score);
        const extra = noted(P.note, fen, sp.captionAt, alpha);
        // The newest move's badge, once it has landed (the move played keeps the game's).
        const landed = on > 1 ? sp.moveAt[on - 2] + LINE_SLIDE : -1;
        v.board = {
          i: s.i,
          fen,
          anim,
          lastMove: last && [last.from, last.to],
          check: checkSquare(fen),
          engine: true,
          ...(!anim && local < sp.back[0] && { badge: badgeOf(last, sp.verdicts[on - 1], landed) }),
          marks: drawn(extra.arrows, extra.rings),
          evalW: r3(score ? winPercentWhite(score) : prep.graph[s.i + 1]),
          evalText,
        };
        v.material = on ? P.material[on - 1] : prep.material[s.i];
        v.clocks = prep.clocks[s.i + 1];
        v.callout = whatIf(evalText, true);
        v.engine = {
          punish: true,
          open: unfold(0, sp.back[1]),
          under,
          ply: s.i + 1,
          // The move played is the position on the board until the punishment's first move lands.
          current: on <= 1,
          moves: track(P.labels, on - 1),
          caption: caption(P.note, sp.captionAt, alpha),
        };
      } else {
        // With branches, the board follows the scene's steps (the line, a branch, back to where they part);
        // without, the line's moves as they land.
        const T = s.steps && L.branches ? trackAt(s.steps, [sl.moves, ...L.branches.map((b) => b?.path ?? [])], local) : undefined;
        const B = T && T.seg >= 0 ? L.branches?.[T.seg] : undefined;
        const k = T ? T.count : s.moveAt.filter((t) => t <= local).length;
        const path = B ? B.path : sl.moves;
        const mv = path[k - 1];
        let anim = T ? T.moving && moveAnim(T.moving.move.before, T.moving.move, variant, T.moving.progress) : slide(sl.moves, s.moveAt, k);
        const prev = g.moves[real];
        // In a branch, once its move is on the board, the eval is where that move leads: the bar shows what it costs.
        const score = B && k > B.br.at ? scoreAt(g, B.path[B.br.at].after) : scoreAt(g, sl.fen);
        const evalText = formatScore(score);
        const fen = mv ? mv.after : sl.fen;
        const said = beatDrawn(fen);
        const noteMarks = B ? { arrows: [], rings: [] } : noted(L.note, fen, s.captionAt, 1);
        const extra = { arrows: [...noteMarks.arrows, ...said.arrows], rings: [...noteMarks.rings, ...said.rings] };
        const verdict = B ? (k > B.br.at ? B.verdicts[k - B.br.at - 1] : s.verdicts[k - 1]) : s.verdicts[k - 1];
        const landedAt = T ? T.landed : s.moveAt[k - 1] + LINE_SLIDE;
        v.board = {
          i: real,
          fen,
          anim,
          lastMove: mv ? [mv.from, mv.to] : prev && [prev.from, prev.to],
          check: (B ? B.check : L.check)[k],
          engine: true,
          ...(!anim && k > 0 && landedAt >= 0 && { badge: badgeOf(mv, verdict, landedAt) }),
          marks: drawn(extra.arrows, extra.rings),
          evalW: r3(score ? winPercentWhite(score) : prep.graph[real + 1]),
          evalText,
        };
        v.material = (B ? B.material : L.material)[k];
        v.clocks = prep.clocks[real + 1];
        v.callout = B
          ? { label: k > B.br.at ? B.label : "What if…?", sub: B.sub, evalText, whatIf: B.fails ? "punish" : "line" }
          : whatIf(evalText, false, k > 0);
        const compareAt = s.captionAt + 0.3;
        v.engine = {
          open: unfold(sp && P ? sp.back[1] : 0, s.restoreEnd),
          under,
          // Played first, the move isn't in the list yet: the variation hangs from the move before it.
          ply: s.first ? s.i : s.i + 1,
          current: false,
          moves: track(B ? B.labels : L.labels, k),
          caption: comment(s.captionAt, said.lit),
          ...(!B && L.compare && !s.first && local >= compareAt && { compare: { ...L.compare, o: r3(fade(compareAt) * unfold(0, s.dur)) } }),
        };
      }
      // The final wind-back takes off what's on the board then: the line, or the branch left on it.
      const offBoard = s.backFrom && L.branches ? ((s.backFrom.seg >= 0 ? L.branches[s.backFrom.seg]?.path : sl.moves) ?? sl.moves).slice(0, s.backFrom.count) : sl.moves;
      const transition = lineTransition(s, m, sl, local, offBoard);
      if (transition) {
        const { phase, fen, count } = transition;
        const engine = phase === "enter" || phase === "rewind";
        const mv = "move" in transition ? transition.move : undefined;
        const before = mv && ("before" in mv ? mv.before : mv.fenBefore);
        const anim = mv && before ? moveAnim(before, mv, variant, transition.progress!) : undefined;
        const actual = !s.first && !engine;
        const score = scoreAt(g, fen, actual ? m.analysis?.evalAfter : undefined);
        const prev = g.moves[s.i - 1];
        const landed = phase === "hold" || phase === "done";
        const last = phase === "rewind" ? offBoard[count - 1] : actual ? m : prev;
        const backB = s.backFrom && s.backFrom.seg >= 0 ? L.branches?.[s.backFrom.seg] : undefined;
        const marks = phase === "hold" ? beatDrawn(fen) : undefined;
        v.board = {
          i: actual ? s.i : real,
          fen,
          anim,
          engine,
          lastMove: last && [last.from, last.to],
          check: landed ? checkSquare(fen) : undefined,
          badge: actual && landed && a ? { sq: m.to, c: a.classification, s: 1 } : undefined,
          arrow: actual && landed && bad ? [a!.bestUci!.slice(0, 2), a!.bestUci!.slice(2, 4)] : undefined,
          marks: marks && drawn(marks.arrows, marks.rings),
          evalW: r3(score ? winPercentWhite(score) : prep.graph[(actual ? s.i : real) + 1]),
          evalText: formatScore(score),
        };
        v.material = phase === "rewind" ? (backB ?? L).material[count] : prep.material[(actual ? s.i : real) + 1];
        v.clocks = prep.clocks[(s.first ? s.i - 1 : s.i) + 1];
        v.focus = actual ? { i: s.i, label: telling(prep.belief[s.i]) } : undefined;
        // While a branch left on the board winds back, it keeps its own callout until only the line's moves are left.
        const branchUp = phase === "rewind" && backB && count > backB.br.at;
        v.callout = branchUp
          ? { label: backB!.label, sub: backB!.sub, evalText: v.board.evalText, whatIf: backB!.fails ? "punish" : "line" }
          : engine ? whatIf(v.board.evalText, false, phase === "rewind") : actual
          ? { label, cls: a?.classification, evalText: v.board.evalText, bestWas: bad ? a!.bestSan : undefined, took: took(m.thinkMs) }
          : { label: `${sideName(g, m.color)} to move`, status: true, evalText: v.board.evalText };
        v.line = actual ? verdictLine(g, prep, s.i, bad, telling(prep.belief[s.i])) : undefined;
        v.engine = {
          open: phase === "hold" ? unfold(0, s.dur) : phase === "enter" ? 1 : 1 - fade(s.back[0], s.back[1] - s.back[0]),
          under: phase === "hold" || !engine ? 1 : under,
          ply: s.first ? s.i : s.i + 1,
          current: !engine,
          moves: phase === "rewind" ? track((backB ?? L).labels, count) : [],
          caption: comment(s.captionAt, marks?.lit),
        };
      }
    }
  }

  if (s.kind === "move") {
    const m = g.moves[s.i];
    const a = m.analysis;
    const before = scoreAt(g, m.fenBefore, g.moves[s.i - 1]?.analysis?.evalAfter);
    const after = scoreAt(g, m.fenAfter, a?.evalAfter) ?? before;
    const p = clamp01(local / s.anim);
    const ep = ease(clamp01((local - s.anim * 0.5) / 0.5));
    const wb = before ? winPercentWhite(before) : 50;
    const wa = after ? winPercentWhite(after) : wb;
    const settled = local >= s.anim;
    // An `instead` line the narrator reveals after this move: its answer isn't given away as the move lands (no
    // best-move arrow, no "best was"), unless the director kept them.
    const ask = g.video?.moments.find((x) => x.ply === m.ply)?.line;
    const spoiler = !!ask && ask.kind === "instead" && !ask.first && !ask.showBest;
    const bad = !!a?.bestUci && a.bestUci !== m.uci && SHOW_BEST.includes(a.classification) && !spoiler;
    const showBest = settled && bad;

    const anim = p < 1 ? moveAnim(m.fenBefore, m, variantOf(g), p) : undefined;

    v.board = {
      i: s.i,
      fen: m.fenAfter,
      anim,
      lastMove: [m.from, m.to],
      check: settled ? prep.check[s.i] : undefined,
      badge: settled && a ? { sq: m.to, c: a.classification, s: r3(easeOutBack(clamp01((local - s.anim) / 0.3))) } : undefined,
      arrow: showBest ? [a!.bestUci!.slice(0, 2), a!.bestUci!.slice(2, 4)] : undefined,
      evalW: r3(wb + (wa - wb) * ep),
      evalText: formatScore(ep < 0.5 ? before : after),
    };
    // The thought's last idea, ending on this move, comes off as the piece goes along its arrow.
    const kept = s.carry && 1 - clamp01(local / (s.anim + 0.25));
    if (s.carry && kept) v.board.marks = marksAt([{ ...s.carry, start: -Infinity, end: Infinity }], 1e6, m.color, r3(kept)).marks;
    v.callout = {
      label: moveLabel(m.ply, m.san),
      cls: a?.classification,
      evalText: formatScore(after),
      bestWas: bad ? a!.bestSan : undefined,
      // On the moments that matter, how long they took is part of the story.
      took: s.key ? took(m.thinkMs) : undefined,
    };
    v.clocks = prep.clocks[s.i + 1];
    // Once it has landed, the hold is the next player thinking: their clock runs, to their total after their move.
    if (s.clock) {
      const n = g.moves[s.i + 1];
      const from = s.anim + 0.15;
      const spent = Math.floor((n.thinkMs * clamp01((local - from) / Math.max(0.1, s.dur - from))) / 1000) * 1000;
      v.clocks = { ...v.clocks, [n.color]: v.clocks[n.color] + spent };
    }
    // The reveal is the bar: the engine's level slides away from (or back to) the mover's marker as the move lands.
    const callOut = s.key && telling(prep.belief[s.i]);
    v.focus = { i: s.i, label: callOut };
    v.line = verdictLine(g, prep, s.i, bad, callOut && settled);
  }
  if (isGameScene(s)) {
    v.speech = speechAt(g, tl, t, idx, thinkLit);
    v.asides = asidesAt(g, tl, t);
  }
  return v;
}

/**
 * The line under a move's verdict: the engine's line (the one it preferred, when the move wasn't it), or, on
 * a misjudged key moment once the move has landed (`callOut`), plainly what the mover thought (the better
 * move is already in the verdict and on the board as an arrow).
 */
function verdictLine(g: Game, prep: Prep, i: number, bad: boolean, callOut: boolean): View["line"] {
  const m = g.moves[i];
  const bl = prep.belief[i];
  if (callOut && bl) {
    const said = `${formatScore(selfScore(m))}, ${standing(bl.self)}`;
    const color = selfEvalColors(g)[m.color];
    return bl.state ? { label: `${sideName(g, m.color)} thought`, text: said, color } : { label: `${sideName(g, m.color)} now sees it:`, text: said, color };
  }
  if (bad) return { label: "Engine preferred", text: prep.bestLine[i] };
  return prep.line[i] ? { label: "Engine line", text: prep.line[i] } : undefined;
}

/* ------------------------------ pieces of the frame ------------------------------ */

function VBoard({ b, size, orientation }: { b: BoardView; size: number; orientation: Color }) {
  const sq = size / 8;
  const at = (s: string) => sqXY(s, orientation);
  const box = (s: string) => ({ left: at(s).x * sq, top: at(s).y * sq, width: sq, height: sq });
  const pieces = [...fenBoard(b.fen)];
  const lerp = (from: string, to: string, p: number) => {
    const a = at(from);
    const z = at(to);
    return { x: a.x + (z.x - a.x) * p, y: a.y + (z.y - a.y) * p };
  };
  const files = orientation === "w" ? "abcdefgh" : "hgfedcba";
  const ranks = orientation === "w" ? "87654321" : "12345678";
  return (
    <div className={`v-board cg-wrap ${b.illegal ? "illegal" : ""} ${b.engine ? "engine" : ""}`} style={{ width: size, height: size }}>
      {b.lastMove?.map((s) => <div key={s} className="v-hl" style={box(s)} />)}
      {b.check && <div className="v-check" style={box(b.check)} />}
      {b.illegal?.sq && <div className="v-illegal-sq" style={{ ...box(b.illegal.sq), opacity: b.illegal.p }} />}
      {[...files].map((f, i) => (
        <span key={f} className={`v-coord file ${i % 2 ? "on-light" : "on-dark"}`} style={{ left: (i + 1) * sq - sq * 0.2, top: size - sq * 0.27, fontSize: sq * 0.2 }}>
          {f}
        </span>
      ))}
      {[...ranks].map((r, i) => (
        <span key={r} className={`v-coord rank ${i % 2 ? "on-dark" : "on-light"}`} style={{ left: sq * 0.06, top: i * sq + sq * 0.03, fontSize: sq * 0.2 }}>
          {r}
        </span>
      ))}
      {b.anim?.captured && (
        <piece
          className={`${PIECE[b.anim.captured.piece.type]} ${b.anim.captured.piece.color === "w" ? "white" : "black"}`}
          style={{ transform: `translate(${at(b.anim.captured.sq).x * sq}px, ${at(b.anim.captured.sq).y * sq}px)`, opacity: 1 - b.anim.captured.p }}
        />
      )}
      {pieces.map(([s, pc]) => {
        let pos = at(s);
        let moving = false;
        if (b.anim && s === b.anim.to) {
          pos = lerp(b.anim.from, b.anim.to, b.anim.p);
          moving = true;
        } else if (b.anim?.rook && s === b.anim.rook[1]) {
          pos = lerp(b.anim.rook[0], b.anim.rook[1], b.anim.p);
          moving = true;
        }
        return (
          <piece
            key={s}
            className={`${PIECE[pc.type]} ${pc.color === "w" ? "white" : "black"}`}
            style={{ transform: `translate(${pos.x * sq}px, ${pos.y * sq}px)`, zIndex: moving ? 5 : 2 }}
          />
        );
      })}
      {(b.arrow || b.marks) && (
        <svg className="v-arrows" viewBox="0 0 8 8">
          {b.marks?.rings.map((r, k) => <Ring key={k} at={at(r.sq)} color={r.own === undefined ? RING : r.own ? OWN_ARROW : OPP_ARROW} o={r.o} pop={r.pop} />)}
          {b.marks?.arrows.map((a, k) => <Arrow key={k} from={at(a.from)} to={at(a.to)} color={a.own ? OWN_ARROW : OPP_ARROW} o={a.o} pop={a.pop} thin={a.hit} />)}
          {b.arrow && <Arrow from={at(b.arrow[0])} to={at(b.arrow[1])} color={ENGINE_ARROW} />}
        </svg>
      )}
      {b.mark && (
        <div
          className="v-mark"
          style={{ left: at(b.mark.sq).x * sq - sq * 0.12, top: at(b.mark.sq).y * sq - sq * 0.12, width: sq * 0.5, height: sq * 0.5, fontSize: sq * 0.3, transform: `scale(${b.mark.s})` }}
        >
          {b.mark.emoji}
        </div>
      )}
      {b.badge && (
        <div
          className="v-badge"
          style={{
            left: (at(b.badge.sq).x + 1) * sq - sq * 0.3,
            top: at(b.badge.sq).y * sq - sq * 0.18,
            width: sq * 0.48,
            height: sq * 0.48,
            transform: `scale(${b.badge.s})`,
          }}
        >
          <ClassIcon c={b.badge.c} />
        </div>
      )}
    </div>
  );
}

/**
 * Mark colours, by what they point at: green for the thinking player's pieces and moves, red for the
 * opponent's, amber for an empty square, and the engine's pick in blue, apart from the players (lichess's
 * arrow colours).
 */
const OWN_ARROW = "#15781b";
const OPP_ARROW = "#b0302a";
const RING = "#e68f00";
const ENGINE_ARROW = "#2f6fd0";
/** The same three, lighter, for words lit on the dark engine-line panel. */
const LIT_OWN = "#8fdc6a";
const LIT_OPP = "#ff8f86";
const LIT_EMPTY = "#ffc14d";

type XY = { x: number; y: number };

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

/**
 * An arrow between two squares (in board units), the way it's drawn on lichess: whole at once, landing a
 * touch bold and settling (`pop` 0 → 1). `thin`: a piece's reach rather than a move, lighter.
 */
function Arrow({ from, to, color, o = 1, pop = 1, thin = false }: { from: XY; to: XY; color: string; o?: number; pop?: number; thin?: boolean }) {
  const x1 = from.x + 0.5;
  const y1 = from.y + 0.5;
  const full = Math.hypot(to.x - from.x, to.y - from.y);
  if (!full || o <= 0) return null;
  const ux = (to.x - from.x) / full;
  const uy = (to.y - from.y) / full;
  const x2 = x1 + ux * full;
  const y2 = y1 + uy * full;
  const bold = 1 + 0.35 * (1 - easeOut(pop));
  const head = Math.min(thin ? 0.34 : 0.42, full * 0.6) * bold;
  const bx = x2 - ux * head;
  const by = y2 - uy * head;
  const w = (thin ? 0.2 : 0.25) * (head / (thin ? 0.34 : 0.42));
  return (
    <g opacity={r3((thin ? 0.7 : 0.85) * o)}>
      <line x1={x1} y1={y1} x2={bx} y2={by} stroke={color} strokeWidth={(thin ? 0.1 : 0.17) * bold} />
      <polygon points={`${x2},${y2} ${bx - uy * w},${by + ux * w} ${bx + uy * w},${by - ux * w}`} fill={color} />
    </g>
  );
}

/** A ring around a square, landing a touch wide and settling (`pop` 0 → 1). */
function Ring({ at, color, o, pop }: { at: XY; color: string; o: number; pop: number }) {
  return <circle cx={at.x + 0.5} cy={at.y + 0.5} r={0.44 * (1 + 0.12 * (1 - easeOut(pop)))} fill="none" stroke={color} strokeWidth={0.07} opacity={r3(0.9 * o)} />;
}

/** A player's own evaluation on the bar: White's win% as they see it, in their colour. */
type BarMark = { color: Color; w: number; fill: string; misjudged: boolean; label?: string };

/**
 * Each player's latest own evaluation up to the move on the board. One player is featured: the one
 * about to play (during their thinking, with the evaluation that comes with that move) or who just
 * moved. Only that player's gap to the engine's level is striped, so two never overlap, and on key
 * moments their marker carries a name label.
 */
function barMarks(g: Game, prep: Prep, b: BoardView, focus?: View["focus"]): BarMark[] {
  const colors = selfEvalColors(g);
  const i = focus?.i ?? b.i;
  const featured = g.moves[i]?.color;
  return (["w", "b"] as Color[]).flatMap((c) => {
    const own = prep.self[c].filter((p) => p.ply <= (c === featured ? i : b.i) + 1).at(-1);
    if (!own) return [];
    const side = (white: number) => (c === "w" ? white : 100 - white);
    const lead = c === featured;
    const label = lead && focus?.label ? `${sideName(g, c)}: ${formatScore(selfScore(g.moves[own.ply - 1]))}` : undefined;
    return [{ color: c, w: own.w, fill: colors[c], misjudged: lead && !!judge(side(own.w), side(b.evalW)), label }];
  });
}
function EvalBar({ w, text, length, thickness, marks = [] }: { w: number; text: string; length: number; thickness: number; marks?: BarMark[] }) {
  const whiteAhead = w >= 50;
  return (
    <div className="v-evalbar-wrap" style={{ width: thickness, height: length }}>
    <div className="v-evalbar" style={{ width: thickness, height: length }}>
      <div className="v-evalbar-white" style={{ height: `${w}%` }} />
      {marks.map((m) => (
        <div key={m.color}>
          {m.misjudged && (
            <div className="v-evalbar-gap" style={{ bottom: `${Math.min(m.w, w)}%`, height: `${Math.abs(m.w - w)}%`, ["--c" as string]: m.fill }} />
          )}
          <div className={`v-evalbar-mark ${m.misjudged ? "off" : ""}`} style={{ bottom: `${m.w}%`, background: m.fill }} />
        </div>
      ))}
      <span className={`v-evalbar-text ${whiteAhead ? "bottom" : "top"}`} style={{ fontSize: thickness * 0.5 }}>
        {text.replace(/^[+-]/, "")}
      </span>
    </div>
      {/* Whose marker it is, beside the bar (over the board's edge) on the moments that matter. */}
      {marks.map(
        (m) =>
          m.label && (
            <div key={m.color} className="v-evalbar-label" style={{ bottom: `${m.w}%`, left: thickness + 8, borderColor: m.fill, fontSize: Math.max(20, thickness * 0.72) }}>
              {m.label}
            </div>
          ),
      )}
    </div>
  );
}

function Avatar({ player, size }: { player: PlayerRef; size: number }) {
  return <PlayerAvatar player={player} size={size} />;
}

/** Thinking time as a chess clock: m:ss, or h:mm:ss. */
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
/** One move's thinking time in words: "48s", "3m 12s". */
const took = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

function Captured({ info, color }: { info: MaterialInfo; color: Color }) {
  const opp = other(color);
  const lead = info.material[color] - info.material[opp];
  const groups = ["p", "b", "n", "r", "q"].map((t) => ({ t, n: info.captured[color].filter((x) => x === t).length })).filter((g) => g.n > 0);
  return (
    <div className="v-captured cg-wrap">
      {groups.map((gr) => (
        <span key={gr.t} className="v-capgroup">
          {Array.from({ length: gr.n }, (_, i) => (
            <piece key={i} className={`${PIECE[gr.t]} ${opp === "w" ? "white" : "black"}`} />
          ))}
        </span>
      ))}
      {lead > 0 && <span className="v-adv">+{lead}</span>}
    </div>
  );
}

function PlayerCard({ g, color, material, rating, toMove, clockMs }: { g: Game; color: Color; material: MaterialInfo; rating?: number; toMove: boolean; clockMs: number }) {
  const ref = color === "w" ? g.white : g.black;
  return (
    <div className={`v-player ${toMove ? "to-move" : ""}`}>
      <Avatar player={ref} size={52} />
      <div className="v-player-meta">
        <div className="v-player-name">
          <PlayerName player={ref} />
          {rating !== undefined && <span className="v-rating">({rating})</span>}
        </div>
        <Captured info={material} color={color} />
      </div>
      <div className={`v-side ${color}`}>{color === "w" ? "White" : "Black"}</div>
      <div className={`v-clock ${toMove ? "active" : ""}`}>{clock(clockMs)}</div>
    </div>
  );
}

function Callout({ c, wide }: { c: NonNullable<View["callout"]>; wide: boolean }) {
  const meta = c.cls && CLASS_META[c.cls];
  if (c.whatIf)
    return (
      <div className={`v-callout what-if ${c.whatIf}`}>
        <div className="v-callout-icon">
          <svg className="v-what-if-icon" viewBox="0 0 68 68">
            <circle cx="34" cy="34" r="34" />
            <circle cx="30" cy="30" r="13" fill="none" stroke="#fff" strokeWidth="6" />
            <line x1="40" y1="40" x2="50" y2="50" stroke="#fff" strokeWidth="7" strokeLinecap="round" />
          </svg>
        </div>
        <div className="v-callout-main">
          <div className="v-callout-move">{c.label}</div>
          <div className="v-callout-cls">{c.sub}</div>
        </div>
        <div className="v-evalchip">{c.evalText}</div>
      </div>
    );
  if (c.status)
    return (
      <div className="v-callout status">
        <div className="v-callout-main">
          <div className="v-callout-move">{c.label}</div>
          {c.sub && <div className="v-callout-sub">{c.sub}</div>}
        </div>
        <div className="v-evalchip">{c.evalText}</div>
      </div>
    );
  return (
    <div className="v-callout" style={meta ? { borderColor: meta.color } : undefined}>
      <div className="v-callout-icon">{c.cls && <ClassIcon c={c.cls} size={wide ? 68 : 64} />}</div>
      <div className="v-callout-main">
        <div className="v-callout-move">{c.label}</div>
        <div className="v-callout-cls" style={{ color: meta?.color }}>
          {meta?.label ?? " "}
          {c.bestWas && <span className="v-bestwas"> · best was {c.bestWas}</span>}
          {c.took && <span className="v-bestwas"> · ⏱ {c.took}</span>}
        </div>
      </div>
      <div className="v-evalchip">{c.evalText}</div>
    </div>
  );
}

function IllegalBanner({ g, b }: { g: Game; b: BoardView }) {
  const ill = b.illegal!;

  return (
    <div className="v-callout illegal" style={{ opacity: ill.p }}>
      <div className="v-callout-icon">
        <div className="v-illegal-x">✕</div>
      </div>
      <div className="v-callout-main">
        <div className="v-callout-move">ILLEGAL MOVE</div>
        <div className="v-callout-cls">
          {sideName(g, ill.color)} tried <b>{ill.attempt}</b>
        </div>
      </div>
    </div>
  );
}

const fitFont = (size: number, len: number) => (len > 450 ? size * 0.68 : len > 300 ? size * 0.78 : len > 200 ? size * 0.88 : size);

function ThoughtLabel({ g, t }: { g: Game; t: Said }) {
  const ref = t.color === "w" ? g.white : g.black;
  const p = personalityById(ref.personality);
  return (
    <div className="v-thought-label" style={{ color: p.color }}>
      💭 {sideName(g, t.color)} thinks{t.selfEval && <span className="v-selfeval">self-eval {t.selfEval}</span>}
    </div>
  );
}

/**
 * A thought, off the board (never over it, where it would hide what their words point at): their avatar and
 * a border in their colour say who it is.
 */
function ThoughtBubble({ g, t, size, style }: { g: Game; t: Said; size: number; style?: CSSProperties }) {
  const ref = t.color === "w" ? g.white : g.black;
  return (
    <div className="v-bubble off" style={{ ...style, borderColor: makerOf(ref.provider).color }}>
      <div className="v-bubble-who">
        <Avatar player={ref} size={Math.round(size * 1.5)} />
        <ThoughtLabel g={g} t={t} />
      </div>
      <div className="v-bubble-text" style={{ fontSize: fitFont(size, t.text.length) }}>
        {t.lit?.length ? <LitText text={t.text} lit={t.lit} /> : t.text}
      </div>
    </div>
  );
}

/**
 * The YouTube cut's speech box, under the move list: it opens to the line's height as the line starts (the
 * list above making room, its newest moves staying in sight) and closes after. When one line takes over from
 * another, the two crossfade and the box goes from one's height to the other's. Heights depend on how the
 * words wrap, so they're measured.
 */
function SpeechBox({ g, sp }: { g: Game; sp: NonNullable<View["speech"]> }) {
  const box = useRef<HTMLDivElement>(null);
  const now = useRef<HTMLDivElement>(null);
  const prev = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!box.current || !now.current) return;
    const hn = now.current.offsetHeight;
    const hp = prev.current?.offsetHeight ?? hn;
    box.current.style.height = `${(hp + (hn - hp) * sp.mix) * sp.open}px`;
  });
  const border = (s: Said) => makerOf((s.color === "w" ? g.white : g.black).provider).color;
  // One bubble stays up through a handover, its border turning to the new speaker's colour; the words go
  // first, then the new ones come, so the two never show over each other.
  const color = sp.prev ? `color-mix(in srgb, ${border(sp.now)} ${Math.round(sp.mix * 100)}%, ${border(sp.prev)})` : border(sp.now);
  return (
    <div ref={box} className="v-speech" style={{ marginTop: r3(SPEECH_GAP * sp.open), opacity: r3(Math.min(1, sp.open * 1.3)) }}>
      <div className="v-speech-frame" style={{ borderColor: color }} />
      {sp.prev && (
        <div ref={prev} className="v-speech-line" style={{ opacity: r3(1 - clamp01(sp.mix / 0.45)) }}>
          <ThoughtBubble g={g} t={sp.prev} size={36} />
        </div>
      )}
      <div ref={now} className="v-speech-line" style={{ opacity: r3(sp.prev ? clamp01((sp.mix - 0.45) / 0.55) : 1) }}>
        <ThoughtBubble g={g} t={sp.now} size={36} />
      </div>
    </div>
  );
}

/**
 * An aside as a comment in the move list: indented under the move it hangs from behind a rule in the
 * speaker's colour, their avatar and the words in the list's own dark style (not the bright bubble of a
 * thought, which stops the game). It folds open to its height and away again, the rows below moving with
 * it. `compact`: the short's, in the chart's place, which just fades.
 */
function AsideComment({ g, a, compact = false }: { g: Game; a: NonNullable<View["asides"]>[number]; compact?: boolean }) {
  const fold = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (compact || !fold.current || !body.current) return;
    fold.current.style.height = `${body.current.offsetHeight * a.open}px`;
  });
  const ref = a.color === "w" ? g.white : g.black;
  return (
    <div ref={fold} className={compact ? "v-aside-box" : "v-aside-fold"} style={{ opacity: a.open }}>
      <div ref={body} className="v-aside-body">
        <div className={`v-aside ${compact ? "compact" : ""}`} style={{ borderColor: makerOf(ref.provider).color }}>
          <Avatar player={ref} size={compact ? 52 : 40} />
          <div className="v-aside-text">{a.text}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * The thought with the words that name what's on the board lit up in its colour, fading with it. Only the
 * colour changes, never the size or weight, so the bubble keeps the size it was measured at.
 */
function LitText({ text, lit, tint = true }: { text: string; lit: Lit[]; tint?: boolean }) {
  // A word lit by more than one drawing takes the latest one's colour, but stays as bright as the
  // brightest: lit again, it changes colour (if it does) without fading in all over again.
  const byWord = new Map<number, Lit>();
  for (const l of lit) {
    const had = byWord.get(l.word);
    if (!had) byWord.set(l.word, l);
    else byWord.set(l.word, { ...(l.at >= had.at ? l : had), o: Math.max(l.o, had.o) });
  }
  let k = -1;
  return (
    <>
      {text
        .trim()
        .split(/(\s+)/)
        .map((part, n) => {
          if (n % 2) return part;
          const l = byWord.get(++k);
          if (!l) return part;
          const pct = Math.round(l.o * 100);
          return (
            <span
              key={n}
              className="v-lit"
              style={{ color: `color-mix(in srgb, ${l.color} ${pct}%, currentColor)`, ...(tint && { backgroundColor: `color-mix(in srgb, ${l.color} ${Math.round(pct * 0.16)}%, transparent)` }) }}
            >
              {part}
            </span>
          );
        })}
    </>
  );
}

/**
 * An engine line as a variation, the way an annotated game writes one: indented under the move it branches
 * from, behind a rule (red for what the move allowed, blue for the better line), its moves in the list's
 * type, the newest highlighted and the ones to come faint, and the director's caption under it as a
 * comment (its room kept from the start, so nothing moves when it fades in).
 */
/** The short's narrator line: its size, and the smallest it steps down to when a long one has to fit its box. */
const COMPACT_COMMENT_PX = 38;
const COMPACT_COMMENT_MIN_PX = 24;

function Variation({ e, compact = false }: { e: NonNullable<View["engine"]>; compact?: boolean }) {
  // In the move list it opens to its height as it comes (and closes as it goes), so the rows above rise and
  // settle smoothly. Its height depends on how the caption wraps, so it's measured. In the short it has its
  // own box above the board, and just fades in and out.
  const fold = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const comment = useRef<HTMLDivElement>(null);
  const variation = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!compact) {
      if (fold.current && body.current) fold.current.style.height = `${body.current.offsetHeight * e.open}px`;
      return;
    }
    // In the short its box has a fixed height: a long narrator line steps its type down until it fits,
    // rather than spilling over the player's card below.
    const box = variation.current;
    const c = comment.current;
    if (!box || !c) return;
    let px = COMPACT_COMMENT_PX;
    c.style.fontSize = `${px}px`;
    while (px > COMPACT_COMMENT_MIN_PX && box.scrollHeight > box.clientHeight + 1) {
      px -= 2;
      c.style.fontSize = `${px}px`;
    }
  });
  return (
    <div ref={fold} className={compact ? "v-var-box" : "v-var-fold"} style={{ opacity: e.open }}>
      <div ref={body} className="v-var-body">
        <div ref={variation} className={`v-variation ${e.punish ? "punish" : ""} ${compact ? "compact" : ""}`}>
          <div className="v-var-moves">
            {e.moves.map((mv, j) => (
              <span key={j} className={`v-var-move ${mv.state}`}>
                {mv.label}
              </span>
            ))}
          </div>
          <div ref={comment} className="v-var-comment" style={{ opacity: e.caption?.o ?? 0 }}>
            {/* The lit words' colour alone: a tint behind them would run into the next line of the big caption. */}
            {e.caption && <LitText text={e.caption.text} lit={e.caption.lit} tint={false} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The moves played so far (never the ones to come), newest at the bottom, with their verdicts. `branch`: a
 * variation under the last move; `current`: whether that move is highlighted as the one on the board.
 */
function MoveList({ g, ply, branch, current = true, comments = [], dim = 1 }: { g: Game; ply: number; branch?: ReactNode; current?: boolean; comments?: NonNullable<View["asides"]>; dim?: number }) {
  // More than ever fit: the list fills its box from the bottom, the oldest rows going off the top.
  const ROWS = 30;
  const rows: { no: number; w?: number; b?: number }[] = [];
  for (let i = 0; i < ply; i++) {
    const m = g.moves[i];
    if (m.color === "w" || !rows.length) rows.push({ no: Math.ceil(m.ply / 2) });
    rows[rows.length - 1][m.color] = i;
  }
  const cell = (i?: number) => {
    if (i === undefined) return <span className="v-ml-move" />;
    const m = g.moves[i];
    const c = m.analysis?.classification;
    return (
      <span className={`v-ml-move ${current && i === ply - 1 ? "current" : ""}`}>
        {c && <ClassIcon c={c} size={26} />}
        {m.san}
      </span>
    );
  };
  // Like a scoresheet: it fills from the top, and once it's full the newest stays at the bottom, the
  // oldest fading off the top (only then, or the first moves would be faded too).
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!box.current || !list.current) return;
    const cs = getComputedStyle(box.current);
    const room = box.current.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    box.current.classList.toggle("full", list.current.scrollHeight > room + 1);
  });
  // An aside hangs under the row of the move it's from; one from before the first move, at the top.
  const under = (r: { w?: number; b?: number } | null) =>
    comments.filter((c) => (r ? c.after === r.w || c.after === r.b : c.after < 0)).map((c, k) => <AsideComment key={`${c.after}-${k}-${c.text}`} g={g} a={c} />);
  return (
    <div ref={box} className="v-movelist" style={dim < 1 ? { opacity: r3(dim) } : undefined}>
      <div ref={list} className="v-ml-rows">
        {under(null)}
        {rows.slice(-ROWS).map((r) => (
          <Fragment key={r.no}>
            <div className="v-ml-row">
              <span className="v-ml-no">{r.no}.</span>
              {cell(r.w)}
              {cell(r.b)}
            </div>
            {under(r)}
          </Fragment>
        ))}
        {branch}
      </div>
    </div>
  );
}

function ChartLegend({ g }: { g: Game }) {
  const colors = selfEvalColors(g);
  return (
    <div className="v-legend">
      <span>
        <i className="v-swatch engine" /> Engine
      </span>
      {/* Only players who gave their own evals (a human doesn't). */}
      {(["w", "b"] as Color[]).filter((c) => g.moves.some((m) => m.color === c && m.selfEval !== null)).map((c) => (
        <span key={c}>
          <i className="v-swatch" style={{ background: colors[c] }} /> {sideName(g, c)}'s own eval
        </span>
      ))}
    </div>
  );
}

/**
 * `compare`: what the move cost, at the move: where the game went (its point on the graph) and where the
 * engine's line would have kept it (a blue point), joined by a dashed line, each labelled to its left.
 */
function EvalGraph({ prep, g, ply, width, height, compare }: { prep: Prep; g: Game; ply: number; width: number; height: number; compare?: LineCompare & { o: number } }) {
  const graph = <EvalGraphSvg prep={prep} g={g} ply={ply} width={width} height={height} compare={compare} />;
  if (!compare) return graph;
  const n = prep.graph.length - 1;
  const x = n ? (compare.at / n) * width : 0;
  const y = (w: number) => height - (w / 100) * height;
  const yLine = y(compare.line.w);
  const yReal = y(prep.graph[compare.at]);
  // Each label is centred on its point's height, kept inside the graph; when the points are close, they
  // move apart, the higher one up.
  const TAG = 30;
  const apart = Math.max(0, TAG + 4 - Math.abs(yLine - yReal)) / 2;
  const top = (yp: number, up: boolean) => Math.max(2, Math.min(height - TAG - 2, yp - TAG / 2 + (up ? -apart : apart)));
  return (
    <div className="v-graph-wrap" style={{ width, height }}>
      {graph}
      <span className="v-graph-tag line" style={{ right: width - x + 16, top: top(yLine, yLine < yReal), opacity: compare.o }}>
        {compare.line.label} <b>{compare.line.eval}</b>
      </span>
      <span className="v-graph-tag real" style={{ right: width - x + 16, top: top(yReal, yReal <= yLine), opacity: compare.o }}>
        {compare.real.label} <b>{compare.real.eval}</b>
      </span>
    </div>
  );
}

function EvalGraphSvg({ prep, g, ply, width, height, compare }: { prep: Prep; g: Game; ply: number; width: number; height: number; compare?: LineCompare & { o: number } }) {
  const n = prep.graph.length - 1;
  const x = (i: number) => (n ? (i / n) * width : 0);
  const y = (w: number) => height - (w / 100) * height;
  // Drawn only up to the current move, so the chart never spoils what's coming.
  const shown = prep.graph.slice(0, ply + 1);
  const area = `M0,${height} ` + shown.map((w, i) => `L${x(i)},${y(w)}`).join(" ") + ` L${x(shown.length - 1)},${height} Z`;
  const colors = selfEvalColors(g);
  return (
    <svg className="v-graph" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <rect width={width} height={height} fill="#403d39" />
      <path d={area} fill="#e8e6e3" />
      <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke="#8b8987" strokeWidth={1} strokeDasharray="4 4" />
      {(["w", "b"] as Color[]).map((c) => {
        const pts = prep.self[c].filter((p) => p.ply <= ply);
        if (!pts.length) return null;
        return (
          <polyline
            key={c}
            points={pts.map((p) => `${x(p.ply)},${y(p.w)}`).join(" ")}
            fill="none"
            stroke={colors[c]}
            strokeWidth={3.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            filter="drop-shadow(0 0 1.5px rgba(0,0,0,0.6))"
          />
        );
      })}
      {g.moves.map((m, i) => {
        const c = m.analysis?.classification;
        if (!c || !["brilliant", "great", "inaccuracy", "mistake", "miss", "blunder"].includes(c) || i > ply - 1) return null;
        return <circle key={i} cx={x(i + 1)} cy={y(prep.graph[i + 1])} r={6} fill={CLASS_META[c].color} stroke="#1e1d1a" strokeWidth={2} />;
      })}
      <line x1={x(ply)} x2={x(ply)} y1={0} y2={height} stroke="#81b64c" strokeWidth={3} />
      {compare && (
        <g opacity={compare.o}>
          <line x1={x(compare.at)} x2={x(compare.at)} y1={y(prep.graph[compare.at])} y2={y(compare.line.w)} stroke="#5d9bd5" strokeWidth={3} strokeDasharray="6 5" />
          <circle cx={x(compare.at)} cy={y(compare.line.w)} r={7} fill="#5d9bd5" stroke="#1e1d1a" strokeWidth={2} />
        </g>
      )}
    </svg>
  );
}

type Ratings = Record<Color, { before: number; after: number }> | null;

function GameScene({ g, v, prep, wide, ratings }: { g: Game; v: View; prep: Prep; wide: boolean; ratings: Ratings }) {
  const b = v.board!;
  const sp = v.speech;
  const thoughtO = sp?.open ?? 0;
  const asides = v.asides ?? [];
  const asideO = Math.max(0, ...asides.map((a) => a.open));
  // While the game stops for a thought, the rest of the panel dims under its bright bubble.
  const dim = r3(1 - 0.55 * thoughtO);
  const line = v.line && (
    <>
      <span className="v-line-label" style={v.line.color ? { color: v.line.color } : undefined}>
        {v.line.label}
      </span>{" "}
      {v.line.text}
    </>
  );
  const turn: Color = b.fen.split(" ")[1] as Color;
  const mat = v.material ?? prep.material[b.i + 1];
  const opening = g.opening && b.i >= prep.firstOutOfBook - 1 ? g.opening.name : "";
  const card = (c: Color) => <PlayerCard g={g} color={c} material={mat} rating={ratings?.[c].before} toMove={turn === c && !b.anim} clockMs={v.clocks?.[c] ?? 0} />;
  const callout = b.illegal ? <IllegalBanner g={g} b={b} /> : v.callout ? <Callout c={v.callout} wide={wide} /> : null;
  const hook =
    v.rewind !== undefined ? (
      <div className="v-hook rewind">
        <div className="v-hook-rewind">⏪</div>
        <div className="v-hook-text">How did we get here?</div>
        <div className="v-hook-sub">{b.i >= 0 ? moveLabel(g.moves[b.i].ply, g.moves[b.i].san) : "Move 1"}</div>
      </div>
    ) : v.hook ? (
      <div className="v-hook">
        <div className="v-hook-text">{v.hook}</div>
      </div>
    ) : null;
  // An engine line is a variation in the move list (and a branch on the graph), with the game's moves only
  // up to the one it branches from.
  const engine = v.engine;
  const listPly = engine?.ply ?? b.i + 1;
  // The line under the verdict folds away while a player thinks (there's no verdict yet) and for an engine
  // line, the boxes below rising with it, and unfolds again after.
  const under = r3(Math.min(engine?.under ?? 1, 1 - thoughtO));

  if (wide)
    return (
      <div className="v-game landscape">
        <div className="v-top-card">{card("b")}</div>
        <div className="v-evalbar-pos">
          <EvalBar w={b.evalW} text={b.evalText} length={860} thickness={34} marks={barMarks(g, prep, b, v.focus)} />
        </div>
        <div className="v-board-pos">
          <VBoard b={b} size={860} orientation="w" />
        </div>
        <div className="v-bottom-card">{card("w")}</div>
        <div className="v-panel">
          <div className="v-brand">
            <span className="v-logo">♞ Agent Chess</span>
            <span className="v-opening">{opening}</span>
          </div>
          {callout}
          <div
            className="v-line"
            style={under < 1 ? { height: r3(LINE_ROW * under), minHeight: 0, marginBottom: r3(-PANEL_GAP * (1 - under)), opacity: under, overflow: "hidden" } : undefined}
          >
            {line}
          </div>
          {/* The cold open and its rewind hold the big caption where the move list and chart go, the cold
              open's thought under a smaller one. */}
          {hook ? (
            sp ? (
              <>
                <div className="v-hook-compact">{hook}</div>
                <ThoughtBubble g={g} t={sp.now} size={40} style={{ opacity: sp.open }} />
              </>
            ) : (
              hook
            )
          ) : (
            <>
              {/* Asides are comments in the move list; a thought goes under it, the list making room. */}
              <div className="v-ml-wrap">
                <MoveList g={g} ply={listPly} current={engine?.current ?? true} branch={engine && <Variation e={engine} />} comments={asides} dim={dim} />
                {sp && <SpeechBox g={g} sp={sp} />}
              </div>
              <div className="v-chart-block" style={dim < 1 ? { opacity: dim } : undefined}>
                <ChartLegend g={g} />
                <EvalGraph prep={prep} g={g} ply={listPly} width={840} height={130} compare={engine?.compare} />
              </div>
            </>
          )}
        </div>
      </div>
    );

  // In the short the variation takes the place of the verdict's line and the chart, so they make way as it
  // opens, including while it opens over the move just played before the board winds back.
  const pUnder = r3(engine && !hook ? Math.min(under, engine.under, 1 - engine.open) : under);
  return (
    <div className="v-game portrait">
      <div className="v-p-title">
        <span className="v-opening">{opening}</span>
      </div>
      {hook && sp ? (
        <div className="v-p-bubble">
          <div className="v-hook-compact">{hook}</div>
          <ThoughtBubble g={g} t={sp.now} size={28} style={{ opacity: sp.open }} />
        </div>
      ) : (
        <>
          {/* A thought crossfades with everything above the board, an aside with the chart: each in its place,
              so nothing moves. */}
          <div className="v-p-callout" style={thoughtO ? { opacity: r3(1 - thoughtO) } : undefined}>
            {callout}
          </div>
          {/* The line under the verdict and the chart fade out for an engine line, its variation fading in over
              them in place (there's no move list here to hang it from), and back at its end. */}
          {!hook && (
            <div className="v-p-line v-line" style={pUnder < 1 ? { opacity: pUnder } : undefined}>
              {line}
            </div>
          )}
          {engine && !hook && (
            <div className="v-p-caption hooked">
              <Variation e={engine} compact />
            </div>
          )}
          {/* How the game went so far, and how each player saw it; in the cold open, the hook caption instead. */}
          <div className={`v-p-caption ${hook ? "hooked" : ""}`} style={{ opacity: r3((engine && !hook ? pUnder : 1) * (1 - Math.max(thoughtO, asideO))) }}>
            {hook ? (
              hook
            ) : (
              <div className="v-p-chart">
                <ChartLegend g={g} />
                <EvalGraph prep={prep} g={g} ply={b.i + 1} width={900} height={150} />
              </div>
            )}
          </div>
          {!hook &&
            asides.map((a, k) => (
              <div key={`${a.after}-${k}-${a.text}`} className="v-p-caption v-p-aside">
                <AsideComment g={g} a={a} compact />
              </div>
            ))}
          {!hook && sp && (
            <div className="v-p-bubble" style={{ opacity: thoughtO }}>
              <ThoughtBubble g={g} t={sp.now} size={36} />
            </div>
          )}
        </>
      )}
      <div className="v-p-top-card">{card("b")}</div>
      <div className="v-p-evalbar">
        <EvalBar w={b.evalW} text={b.evalText} length={900} thickness={28} marks={barMarks(g, prep, b, v.focus)} />
      </div>
      <div className="v-p-board">
        <VBoard b={b} size={900} orientation="w" />
      </div>
      <div className="v-p-bottom-card">{card("w")}</div>
    </div>
  );
}


function PlayerHero({ g, color, rating }: { g: Game; color: Color; rating?: number }) {
  const ref = color === "w" ? g.white : g.black;
  const p = personalityById(ref.personality);
  return (
    <div className="v-hero">
      <Avatar player={ref} size={170} />
      <div className="v-hero-name" style={{ color: makerOf(ref.provider).color }}>
        {ref.modelLabel}
      </div>
      <div className="v-hero-as">{isHuman(ref) ? "Human player" : p.plain ? "No personality" : <>as <span style={{ color: p.color }}>{p.name}</span></>}</div>
      <div className="v-hero-tags">
        <span className={`v-side ${color}`}>{color === "w" ? "White" : "Black"}</span>
        {!isHuman(ref) && <span className="v-chip">{ref.effort} effort</span>}
        {rating !== undefined && <span className="v-chip">Rated {rating}</span>}
        {!isHuman(ref) && !p.plain && <span className={`v-risk ${p.risk}`}>{RISK_LABEL[p.risk].label}</span>}
      </div>
      <div className="v-hero-tagline">“{p.tagline}”</div>
    </div>
  );
}

/** The series line under the matchup: a first meeting, a rematch, or a revenge match. */
function SeriesBanner({ g, rival }: { g: Game; rival: Rivalry | null }) {
  if (!rival) return null;
  const name = (c: Color) => sideName(g, c);
  if (!rival.last) return <div className="v-series first">First meeting</div>;
  const tag = rival.last.winner === null ? "Rematch" : `Revenge match for ${name(rival.last.winner === "w" ? "b" : "w")}`;
  return (
    <div className="v-series">
      <b>{tag}</b> · {seriesLine(rival.before, name)}
    </div>
  );
}

function VersusScene({ g, v, wide, ratings, rival }: { g: Game; v: View; wide: boolean; ratings: Ratings; rival: Rivalry | null }) {
  return (
    <div className={`v-versus ${wide ? "landscape" : "portrait"}`}>
      <div className="v-logo big">♞ Agent Chess</div>
      <div className="v-versus-row">
        <PlayerHero g={g} color="w" rating={ratings?.w.before} />
        <div className="v-vs">VS</div>
        <PlayerHero g={g} color="b" rating={ratings?.b.before} />
      </div>
      <SeriesBanner g={g} rival={rival} />
    </div>
  );
}

function InterviewScene({ g, s, v, wide }: { g: Game; s: Extract<Scene, { kind: "interview" }>; v: View; wide: boolean }) {
  const ref = s.color === "w" ? g.white : g.black;
  const p = personalityById(ref.personality);
  const ws = s.text.split(/\s+/);
  const len = s.text.length;
  const font = wide ? (len > 650 ? 42 : len > 420 ? 50 : 56) : len > 650 ? 42 : len > 420 ? 48 : 54;
  return (
    <div className={`v-interview ${wide ? "landscape" : "portrait"}`}>
      <div className="v-interview-head">
        <Avatar player={ref} size={wide ? 120 : 140} />
        <div>
          <div className="v-interview-kind">{s.when === "pre" ? "Pre-game interview" : "Post-game interview"}</div>
          <div className="v-interview-name" style={{ color: makerOf(ref.provider).color }}>
            {ref.modelLabel}
          </div>
          <div className="v-interview-sub">
            <span className="v-hero-as">{isHuman(ref) ? "Human player" : p.plain ? "No personality" : <>as <span style={{ color: p.color }}>{p.name}</span></>}</span>
            <span className={`v-side ${s.color}`}>{s.color === "w" ? "White" : "Black"}</span>
          </div>
        </div>
      </div>
      <div className="v-quote" style={{ fontSize: font, borderColor: p.color }}>
        {ws.map((w, i) => (
          <span key={i} style={{ opacity: i < (v.reveal ?? 0) ? 1 : 0 }}>
            {w}{" "}
          </span>
        ))}
      </div>
    </div>
  );
}

const RESULT_COUNTS: Classification[] = ["brilliant", "great", "best", "excellent", "good", "inaccuracy", "mistake", "miss", "blunder"];

function ResultScene({ g, v, wide, ratings, rival }: { g: Game; v: View; wide: boolean; ratings: Ratings; rival: Rivalry | null }) {
  const winner: Color | null = g.result === "1-0" ? "w" : g.result === "0-1" ? "b" : null;
  const headline = winner ? `${sideName(g, winner)} wins` : "Draw";
  const side = (c: Color) => {
    const ref = c === "w" ? g.white : g.black;
    const r = g.review?.[c];
    const delta = g.ratingChange?.[c];
    return (
      <div className={`v-result-side ${winner === c ? "won" : ""}`}>
        <Avatar player={ref} size={110} />
        <div className="v-hero-name small" style={{ color: makerOf(ref.provider).color }}>
          {ref.modelLabel}
        </div>
        <div className="v-hero-as small">
          {isHuman(ref) ? "Human player" : personalityById(ref.personality).plain ? "No personality" : <>as <span style={{ color: personalityById(ref.personality).color }}>{personalityById(ref.personality).name}</span></>}
        </div>
        <div className="v-time-total">
          ⏱ {clock(g.moves.filter((m) => m.color === c).reduce((sum, m) => sum + m.thinkMs, 0))} thinking · {took(g.moves.filter((m) => m.color === c).reduce((sum, m) => sum + m.thinkMs, 0) / Math.max(1, g.moves.filter((m) => m.color === c).length))} a move
        </div>
        <div className="v-acc">
          <span>{r?.accuracy?.toFixed(1) ?? "—"}</span>
          <small>accuracy</small>
        </div>
        {ratings && (
          <div className="v-rating-change">
            {ratings[c].before} → {ratings[c].after}{" "}
            {delta !== undefined && <b className={delta >= 0 ? "up" : "down"}>{delta >= 0 ? `+${delta}` : delta}</b>}
          </div>
        )}
        <div className="v-counts">
          {RESULT_COUNTS.filter((k) => r?.counts[k]).map((k) => (
            <span key={k} className="v-count">
              <ClassIcon c={k} size={34} />
              {r!.counts[k]}
            </span>
          ))}
        </div>
      </div>
    );
  };
  return (
    <div className={`v-result ${wide ? "landscape" : "portrait"}`}>
      <div className="v-result-score">{g.result ?? "*"}</div>
      <div className="v-result-headline">{headline}</div>
      <div className="v-result-term">{g.termination}</div>
      {rival && rival.after.w + rival.after.b + rival.after.draws > 1 && <div className="v-series">{seriesLine(rival.after, (c) => sideName(g, c))}</div>}
      <div className="v-result-row">
        {side("w")}
        {side("b")}
      </div>
    </div>
  );
}

function EndScene({ g }: { g: Game }) {
  const name = (c: Color) => {
    const ref = c === "w" ? g.white : g.black;
    return fullName(ref);
  };
  return (
    <div className="v-end">
      <div className="v-logo huge">♞ Agent Chess</div>
      <div className="v-end-sub">AI models playing chess against each other</div>
      <div className="v-end-match">
        {name("w")} vs {name("b")}
      </div>
    </div>
  );
}

function Frame({ g, tl, prep, v, ratings, rival }: { g: Game; tl: Timeline; prep: Prep; v: View; ratings: Ratings; rival: Rivalry | null }) {
  const wide = tl.format === "landscape";
  const s = tl.scenes[v.idx];
  let body: React.ReactNode = null;
  if (v.board) body = <GameScene g={g} v={v} prep={prep} wide={wide} ratings={ratings} />;
  else if (s.kind === "versus") body = <VersusScene g={g} v={v} wide={wide} ratings={ratings} rival={rival} />;
  else if (s.kind === "interview") body = <InterviewScene g={g} s={s} v={v} wide={wide} />;
  else if (s.kind === "result") body = <ResultScene g={g} v={v} wide={wide} ratings={ratings} rival={rival} />;
  else if (s.kind === "end") body = <EndScene g={g} />;
  const { w, h } = FRAME[tl.format];
  return (
    <div className={`v-frame ${tl.format}`} style={{ width: w, height: h }}>
      <div className="v-fade" style={{ opacity: v.fade }}>
        {body}
      </div>
    </div>
  );
}

/* ------------------------------ thumbnail ------------------------------ */

export const THUMB = { w: 1280, h: 720 };

/**
 * The YouTube thumbnail: the director's chosen position with its verdict, a few huge words and the matchup.
 * `opt`: the director's thumbnail option of that number (from 0) instead of the one in use.
 */
function Thumbnail({ g, prep, opt }: { g: Game; prep: Prep; opt?: number }) {
  const th = opt === undefined ? g.video?.packaging?.thumbnail : g.video?.packagingOptions?.thumbnails[opt];
  const words = th?.text ?? "";
  const i = Math.max(0, g.moves.findIndex((m) => m.ply === th?.ply));
  const b = settledBoard(g, prep, i);
  const cls = g.moves[i]?.analysis?.classification;
  // The text starts as big as it can be and shrinks, measured in the real font, until no word sticks out
  // and the column (icon, text, matchup) fits the frame. data-fit tells the renderer it's settled: "1" fitted, "0" didn't.
  const text = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<"1" | "0" | null>(null);
  useLayoutEffect(() => {
    let alive = true;
    setFit(null);
    // Measured in the real font, so once it has loaded (or after 3 s, if it never reports in).
    Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]).then(() => {
      const el = text.current;
      const col = column.current;
      if (!alive || !el || !col) return;
      const wide = () => el.scrollWidth > el.clientWidth + 1;
      const tall = () => col.getBoundingClientRect().height > THUMB.h - 40;
      let size = 104;
      const at = (px: number) => (el.style.fontSize = `${(size = px)}px`);
      at(104);
      el.style.overflowWrap = "normal";
      while (size > 28 && (wide() || tall())) at(size - 4);
      // A single word too long for the column even at 28px is allowed to break, then sized to fit the height.
      if (wide()) {
        el.style.overflowWrap = "anywhere";
        while (size > 12 && tall()) at(size - 2);
      }
      setFit(!wide() && !tall() ? "1" : "0");
    });
    return () => {
      alive = false;
    };
  }, [words]);
  const side = (c: Color) => {
    const ref = c === "w" ? g.white : g.black;
    return (
      <div className="v-thumb-player">
        <Avatar player={ref} size={64} />
        <span style={{ color: makerOf(ref.provider).color }}>{ref.modelLabel}</span>
      </div>
    );
  };
  return (
    <div className="v-thumb" style={{ width: THUMB.w, height: THUMB.h }} data-fit={fit ?? undefined}>
      <div className="v-thumb-board">
        <VBoard b={b} size={640} orientation="w" />
      </div>
      <div className="v-thumb-right" ref={column}>
        {cls && <ClassIcon c={cls} size={120} />}
        <div className="v-thumb-text" ref={text}>
          {words}
        </div>
        <div className="v-thumb-vs">
          {side("w")}
          <span className="v-thumb-vs-word">vs</span>
          {side("b")}
        </div>
      </div>
    </div>
  );
}
/* ------------------------------ ratings at the time of the game ------------------------------ */

async function loadRatings(g: Game): Promise<Ratings> {
  // An unrated game's video shows no ratings.
  if (g.options?.rated === false) return null;
  // Saved when the game was rated, so games played since never move them.
  const before = g.ratingBefore;
  const change = g.ratingChange;
  if (before && change) return { w: { before: before.w, after: before.w + change.w }, b: { before: before.b, after: before.b + change.b } };
  // A game from before that was saved: worked back from today's ratings.
  const lobby = await api<Lobby>("/api/lobby");
  const out = {} as NonNullable<Ratings>;
  for (const c of ["w", "b"] as Color[]) {
    const ref = c === "w" ? g.white : g.black;
    const p = lobby.players.find((x) => x.id === ref.id);
    if (!p) return null;
    // Undo every rating change from games that finished after this one.
    // Every rated game counts, including ones still in their post-game (rated the moment they ended).
    const others = lobby.games.filter((s) => s.id !== g.id && s.result && (s.white.id === ref.id || s.black.id === ref.id));
    let after = p.rating;
    for (const s of others) {
      const full = await api<Game>(`/api/games/${s.id}`);
      if ((full.endedAt ?? 0) > (g.endedAt ?? 0)) after -= full.ratingChange?.[full.white.id === ref.id ? "w" : "b"] ?? 0;
    }
    out[c] = { before: after - (g.ratingChange?.[c] ?? 0), after };
  }
  return out;
}

/* ------------------------------ page ------------------------------ */

declare global {
  interface Window {
    __video?: { ready: boolean; duration: number; scenes: Scene[]; asides: AsideCue[]; cues: SfxCue[]; fps: number; seek: (t: number) => string; settle: () => Promise<void> };
  }
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function VideoPage({ id, query }: { id: string; query: URLSearchParams }) {
  const meta = useMeta();
  const format: Format = query.get("format") === "portrait" ? "portrait" : "landscape";
  const render = query.get("render") === "1";
  const [game, setGame] = useState<Game | null>(null);
  const [ratings, setRatings] = useState<Ratings | undefined>(undefined);
  const [rival, setRival] = useState<Rivalry | null | undefined>(undefined);
  const [voice, setVoice] = useState<VoiceManifest | undefined>(undefined);
  const [error, setError] = useState("");
  // The preview opens just past the intro's fade-in rather than on a blank frame.
  const [t, setT] = useState(Number(query.get("t")) || (render ? 0 : 0.5));
  const [playing, setPlaying] = useState(false);
  // Counts the viewer's jumps in the preview (not the clock running on), so a spoken line can follow them.
  const [seeks, setSeeks] = useState(0);
  const seek = (to: number | ((x: number) => number)) => {
    setT(to);
    setSeeks((n) => n + 1);
  };
  const [reload, setReload] = useState(0);
  const keyRef = useRef("");
  const livePlan = useRef<string | undefined>(undefined);

  // The director works in T3 Code; each saved plan arrives over the existing game stream.
  // Export frames use a fixed snapshot, while the preview keeps its current playback position.
  useEffect(() => {
    if (render) return;
    livePlan.current = undefined;
    const events = new EventSource(`/api/games/${id}/stream`);
    events.onmessage = e => {
      const next = JSON.parse(e.data) as Game;
      const signature = JSON.stringify(next.video ?? null);
      if (livePlan.current !== undefined && livePlan.current !== signature) setReload(n => n + 1);
      livePlan.current = signature;
    };
    return () => events.close();
  }, [id, render]);

  // Voices land one line at a time while a render records them: the preview takes each as it comes, so it
  // can be heard (and its timing seen) without waiting for the whole recording.
  const muted = query.get("voices") === "off";
  useEffect(() => {
    if (render || muted) return;
    const events = new EventSource(`/api/games/${id}/voice/stream`);
    // Only a manifest that differs from the one in hand rebuilds the timeline (the first is usually the same).
    events.onmessage = (e) => setVoice((prev) => (prev && JSON.stringify(prev) === e.data ? prev : (JSON.parse(e.data) as VoiceManifest)));
    return () => events.close();
  }, [id, render, muted]);

  useEffect(() => {
    api<Game>(`/api/games/${id}`)
      .then((g) => {
        setGame(g);
        return loadRatings(g).catch(() => null);
      })
      .then((r) => setRatings(r ?? null))
      .catch((e) => setError(String(e.message ?? e)));
    // The series between the two models (absent on the public mirror: the cards just leave it out).
    api<{ rivalry: Rivalry | null }>(`/api/games/${id}/rivalry`)
      .then((r) => setRival(r.rivalry))
      .catch(() => setRival(null));
    // The players' recorded lines, whose lengths set the timing (none on the public mirror).
    // (A render asked to be silent gets none.)
    if (query.get("voices") === "off") setVoice({ clips: {} });
    else
      api<VoiceManifest>(`/api/games/${id}/voice`)
        .then(setVoice)
        .catch(() => setVoice({ clips: {} }));
  }, [id, reload]);

  const thoughts = query.get("thoughts") !== "off";
  const pace = Number(query.get("pace")) || 1;
  const tl = useMemo(() => game && voice && buildTimeline(game, format, { thoughts, pace, voice }), [game, format, thoughts, pace, voice]);
  const prep = useMemo(() => game && prepare(game), [game]);
  const cues = useMemo(() => game && tl && sfxCues(tl, game), [game, tl]);
  const ready = !!(game && tl && prep && ratings !== undefined && rival !== undefined);
  const v = ready ? derive(game!, tl!, prep!, Math.min(t, tl!.duration - 1e-3)) : null;
  if (v) keyRef.current = JSON.stringify(v);

  // The renderer drives the clock: seek, wait for paint, report what's on screen.
  useEffect(() => {
    if (!ready) return;
    window.__video = {
      ready: true,
      duration: tl!.duration,
      scenes: tl!.scenes,
      asides: tl!.asides,
      cues: cues!,
      fps: 30,
      seek: (time) => {
        flushSync(() => setT(time));
        return keyRef.current;
      },
      settle: () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    };
    return () => {
      delete window.__video;
    };
  }, [ready, tl, cues]);

  // Preview playback.
  useEffect(() => {
    if (!playing || !tl) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((x) => {
        const n = x + dt;
        if (n >= tl.duration) {
          setPlaying(false);
          return tl.duration;
        }
        return n;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, tl]);

  // Preview playback speaks the recorded lines as their scenes come up (a render mixes them into the
  // soundtrack instead).
  const sceneIdx = v?.idx ?? -1;
  // Every recorded line is loaded as soon as the timeline is known, so each starts on its cue rather than a
  // fetch later (most noticeable on the short asides).
  const clips = useRef(new Map<string, HTMLAudioElement>());
  useEffect(() => {
    if (render || !tl) return;
    for (const s of [...tl.scenes, ...tl.asides])
      if (s.voice && !clips.current.has(s.voice.url)) {
        const a = new Audio(s.voice.url);
        a.preload = "auto";
        clips.current.set(s.voice.url, a);
      }
  }, [tl, render]);
  // A line recorded for something starting at `from` (a scene, an aside): it picks up from wherever the preview
  // is in it, its start or mid-line after a seek or a pause.
  const speak = (voice: { url: string; rate: number }, from: number) => {
    const audio = clips.current.get(voice.url) ?? new Audio(voice.url);
    audio.playbackRate = voice.rate;
    const into = (t - from - VOICE_AT) * voice.rate;
    const start = () => {
      audio.currentTime = Math.max(0, into);
      audio.play().catch(() => {});
    };
    const wait = setTimeout(start, Math.max(0, -into / voice.rate) * 1000);
    return () => {
      clearTimeout(wait);
      audio.pause();
    };
  };
  useEffect(() => {
    const s = tl?.scenes[sceneIdx];
    if (render || !playing || !s?.voice) return;
    return speak(s.voice, s.start);
    // A new scene, play/pause or a seek starts or stops a line; time running on within the scene doesn't.
  }, [sceneIdx, playing, tl, render, seeks]);
  // The asides, over the scenes, the same way.
  const asideIdx = tl ? tl.asides.findIndex((a) => t >= a.start && t < a.start + a.dur) : -1;
  useEffect(() => {
    const a = tl?.asides[asideIdx];
    if (render || !playing || !a?.voice) return;
    return speak(a.voice, a.start);
  }, [asideIdx, playing, tl, render, seeks]);

  // ...and its sound effects, the ones the render mixes in, as the clock passes them. A jump (a seek)
  // plays nothing for the stretch it skipped.
  const cueFrom = useRef(t);
  useEffect(() => {
    const from = cueFrom.current;
    cueFrom.current = t;
    if (render || !playing || !cues || t <= from || t - from > 0.5) return;
    for (const c of cues) if (c.t > from && c.t <= t) playSfx(c.ev, c.gain);
  }, [t]);

  const [win, setWin] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => {
    const on = () => setWin({ w: innerWidth, h: innerHeight });
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);

  useEffect(() => {
    if (render) return;
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, button, [contenteditable]")) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight") seek((x) => x + 5);
      else if (e.key === "ArrowLeft") seek((x) => Math.max(0, x - 5));
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [render]);

  if (error) return <div className="v-msg">Couldn't load game: {error}</div>;
  if (!ready || !v)
    return <div className="v-msg">Loading…</div>;
  if (query.get("thumb") === "1") {
    const opt = query.get("opt");
    return <div className="v-render">{<Thumbnail g={game!} prep={prep!} opt={opt === null ? undefined : Number(opt)} />}</div>;
  }

  const frame = <Frame g={game!} tl={tl!} prep={prep!} v={v} ratings={ratings!} rival={rival ?? null} />;
  if (render) return <div className="v-render">{frame}</div>;

  const { w, h } = FRAME[format];
  // The render panel sits beside the video on a wide screen and below it on a narrow one (and isn't there on the public site).
  const panel = !!meta && !meta.publicMode;
  const narrow = win.w < 900;
  const mainW = win.w - (narrow ? 24 : 48) - (panel && !narrow ? PANEL_W : 0);
  // Under ~920px the controls wrap onto a second row, which needs room under the video.
  const scale = Math.max(0.1, Math.min(mainW / w, (win.h - (narrow || mainW < 920 ? 180 : 130)) / h));
  const swap = (f: Format) => `#/video/${id}?format=${f}${thoughts ? "" : "&thoughts=off"}${pace !== 1 ? `&pace=${pace}` : ""}`;
  return (
    <div className="v-preview">
      <div className="v-preview-main">
      <div className="v-stage" style={{ width: w * scale, height: h * scale }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}>{frame}</div>
      </div>
      <div className="v-controls" style={{ maxWidth: mainW }}>
        <button onClick={() => (t >= tl!.duration ? (seek(0), setPlaying(true)) : setPlaying((p) => !p))}>{playing ? "⏸" : "▶"}</button>
        <span className="v-time">
          {fmtTime(t)} / {fmtTime(tl!.duration)}
        </span>
        <input type="range" min={0} max={tl!.duration} step={0.05} value={t} onChange={(e) => seek(Number(e.target.value))} />
        <a className={format === "landscape" ? "on" : ""} href={swap("landscape")}>
          YouTube 16:9
        </a>
        <a className={format === "portrait" ? "on" : ""} href={swap("portrait")}>
          TikTok 9:16
        </a>
        <a href={`#/game/${id}`}>Back to game</a>
      </div>
      </div>
      {panel && <RenderPanel key={id} gameId={id} onPlan={() => setReload((n) => n + 1)} context={{ time: t, format, ...(v.board && game!.moves[v.board.i] && { ply: game!.moves[v.board.i].ply }) }} />}
    </div>
  );
}
