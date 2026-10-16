import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { looseChess, newRules, START_FEN, variantOf, type Variant } from "../../../shared/rules";
import type { Classification, Color, Game, PlayerRef, Rivalry, Score } from "../../../shared/types";
import { seriesLine } from "../../../shared/series";
import type { VoiceManifest } from "../../../shared/voices";
import { personalityById, RISK_LABEL } from "../../../shared/personalities";
import { formatScore, winPercentWhite } from "../../../shared/evalmath";
import { beliefs, judge, selfScore, standing, type Belief } from "../../../shared/belief";
import { makerOf } from "../../../shared/models";
import { materialInfo, type MaterialInfo } from "../../../shared/material";
import { illegalMovePath, triesOf } from "../../../shared/explain";
import { api, type Lobby } from "../api";
import { ClassIcon, CLASS_META } from "../components/ClassIcon";
import { PlayerAvatar, PlayerName } from "../components/PlayerName";
import { fullName, isHuman, selfEvalColors, sideName } from "../../../shared/naming";
import { buildTimeline, FRAME, sceneAt, VOICE_AT, type Format, type Scene, type Timeline } from "./timeline";
import { RenderPanel } from "./RenderPanel";
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
  const check = g.moves.map((m) => {
    const c = looseChess(m.fenAfter);
    if (!c.inCheck()) return undefined;
    const turn = c.turn();
    for (const row of c.board()) for (const sq of row) if (sq?.type === "k" && sq.color === turn) return sq.square;
    return undefined;
  });
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
  illegal?: { attempt: string; sq?: string; color: Color; p: number };
  /** A marker on a king: the draw offer or the white flag. */
  mark?: { sq: string; emoji: string; s: number };
  evalW: number;
  evalText: string;
}

interface View {
  idx: number;
  kind: Scene["kind"];
  fade: number;
  board?: BoardView;
  /** `status` is a plain one-line banner ("… is thinking") instead of a move verdict. */
  callout?: { label: string; cls?: Classification; evalText: string; bestWas?: string; status?: boolean; sub?: string; took?: string };
  /** `color`: the line is about a player (what they thought), in their colour. */
  line?: { label: string; text: string; color?: string };
  thought?: { text: string; color: Color; selfEval: string; fade: number };
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
}

const GAME_SCENES: Scene["kind"][] = ["move", "illegal", "think", "draw", "resign", "rewind"];
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

/** Worth calling out: the mover is far from the truth, or has just come back to it. */
const telling = (b: Belief | null) => !!b && (!!b.state || b.change === "realizes");

function derive(g: Game, tl: Timeline, prep: Prep, t: number): View {
  const s = sceneAt(tl, t);
  const idx = tl.scenes.indexOf(s);
  const local = Math.max(0, t - s.start);
  // Cut between game scenes; fade into everything else.
  const fade = isGameScene(s) && isGameScene(tl.scenes[idx - 1]) ? 1 : r3(clamp01(local / 0.35));
  const v: View = { idx, kind: s.kind, fade };

  if (s.kind === "interview" || s.kind === "flashback") v.reveal = s.text.split(/\s+/).length;
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
    v.callout = { label: `${name} is thinking…`, evalText: formatScore(score), status: true };
    v.thought = { text: s.thought, color: m.color, selfEval: m.selfEvalRaw, fade: r3(clamp01(local / 0.3)) };
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
    const bad = !!a?.bestUci && a.bestUci !== m.uci && SHOW_BEST.includes(a.classification);
    const showBest = settled && bad;

    let anim: BoardView["anim"];
    if (p < 1) {
      const pre = fenBoard(m.fenBefore);
      const pc = pre.get(m.from);
      // Castling: the king lands on g/c and its rook on f/d. In Chess960 the rook starts wherever the
      // UCI says (king-takes-rook); in standard chess it's the corner.
      const castle = pc?.type === "k" && m.san.startsWith("O-O");
      const rank = m.from[1];
      const kingside = m.to[0] === "g";
      const rookFrom = variantOf(g) === "chess960" ? m.uci.slice(2, 4) : `${kingside ? "h" : "a"}${rank}`;
      const rook: [string, string] | undefined = castle ? [rookFrom, `${kingside ? "f" : "d"}${rank}`] : undefined;
      const enPassant = pc?.type === "p" && m.from[0] !== m.to[0] && !pre.get(m.to);
      const capSq = enPassant ? m.to[0] + m.from[1] : m.to;
      const capPiece = pre.get(capSq);
      anim = {
        from: m.from,
        to: m.to,
        p: r3(ease(p)),
        rook,
        captured: capPiece && capPiece.color !== m.color ? { sq: capSq, piece: capPiece, p: r3(p) } : undefined,
      };
    }

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
    v.callout = {
      label: moveLabel(m.ply, m.san),
      cls: a?.classification,
      evalText: formatScore(after),
      bestWas: bad ? a!.bestSan : undefined,
      // On the moments that matter, how long they took is part of the story.
      took: s.key ? took(m.thinkMs) : undefined,
    };
    v.clocks = prep.clocks[s.i + 1];
    // The reveal is the bar: the engine's level slides away from (or back to) the mover's marker as the move lands.
    const bl = prep.belief[s.i];
    const callOut = s.key && telling(bl);
    v.focus = { i: s.i, label: callOut };
    v.line = bad
        ? { label: "Engine preferred", text: prep.bestLine[s.i] }
        : prep.line[s.i]
          ? { label: "Engine line", text: prep.line[s.i] }
          : undefined;
    // On a misjudged key moment the line under the verdict says, plainly, what the mover thought (the
    // better move is already in the verdict and on the board as an arrow).
    if (callOut && settled) {
      const said = `${formatScore(selfScore(m))}, ${standing(bl!.self)}`;
      const color = selfEvalColors(g)[m.color];
      v.line = bl!.state ? { label: `${sideName(g, m.color)} thought`, text: said, color } : { label: `${sideName(g, m.color)} now sees it:`, text: said, color };
    }
  }
  return v;
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
    <div className={`v-board cg-wrap ${b.illegal ? "illegal" : ""}`} style={{ width: size, height: size }}>
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
      {b.arrow && <Arrow from={at(b.arrow[0])} to={at(b.arrow[1])} />}
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

function Arrow({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  const x1 = from.x + 0.5;
  const y1 = from.y + 0.5;
  const x2 = to.x + 0.5;
  const y2 = to.y + 0.5;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const head = 0.42;
  const bx = x2 - ux * head;
  const by = y2 - uy * head;
  const w = 0.25;
  return (
    <svg className="v-arrows" viewBox="0 0 8 8">
      <g opacity="0.85">
        <line x1={x1} y1={y1} x2={bx} y2={by} stroke="#15781b" strokeWidth={0.17} />
        <polygon points={`${x2},${y2} ${bx - uy * w},${by + ux * w} ${bx + uy * w},${by - ux * w}`} fill="#15781b" />
      </g>
    </svg>
  );
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

function ThoughtLabel({ g, t }: { g: Game; t: NonNullable<View["thought"]> }) {
  const ref = t.color === "w" ? g.white : g.black;
  const p = personalityById(ref.personality);
  return (
    <div className="v-thought-label" style={{ color: p.color }}>
      💭 {sideName(g, t.color)} thinks{t.selfEval && <span className="v-selfeval">self-eval {t.selfEval}</span>}
    </div>
  );
}

/** The mover's thinking as a speech bubble over the board, coming out of their player card. */
function ThoughtBubble({ g, t, size }: { g: Game; t: NonNullable<View["thought"]>; size: number }) {
  return (
    <div className={`v-bubble ${t.color === "b" ? "from-top" : "from-bottom"}`} style={{ opacity: t.fade }}>
      <ThoughtLabel g={g} t={t} />
      <div className="v-bubble-text" style={{ fontSize: fitFont(size, t.text.length) }}>
        {t.text}
      </div>
    </div>
  );
}

/** The moves played so far (never the ones to come), newest at the bottom, with their verdicts. */
function MoveList({ g, ply }: { g: Game; ply: number }) {
  const ROWS = 11;
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
      <span className={`v-ml-move ${i === ply - 1 ? "current" : ""}`}>
        {c && <ClassIcon c={c} size={26} />}
        {m.san}
      </span>
    );
  };
  return (
    <div className="v-movelist">
      {rows.slice(-ROWS).map((r) => (
        <div key={r.no} className="v-ml-row">
          <span className="v-ml-no">{r.no}.</span>
          {cell(r.w)}
          {cell(r.b)}
        </div>
      ))}
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

function EvalGraph({ prep, g, ply, width, height }: { prep: Prep; g: Game; ply: number; width: number; height: number }) {
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
    </svg>
  );
}

type Ratings = Record<Color, { before: number; after: number }> | null;

function GameScene({ g, v, prep, wide, ratings }: { g: Game; v: View; prep: Prep; wide: boolean; ratings: Ratings }) {
  const b = v.board!;
  const t = v.thought;
  const bubble = t && <ThoughtBubble g={g} t={t} size={30} />;
  const line = v.line && (
    <>
      <span className="v-line-label" style={v.line.color ? { color: v.line.color } : undefined}>
        {v.line.label}
      </span>{" "}
      {v.line.text}
    </>
  );
  const turn: Color = b.fen.split(" ")[1] as Color;
  const mat = prep.material[b.i + 1];
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

  if (wide)
    return (
      <div className="v-game landscape">
        <div className="v-top-card">{card("b")}</div>
        <div className="v-evalbar-pos">
          <EvalBar w={b.evalW} text={b.evalText} length={860} thickness={34} marks={barMarks(g, prep, b, v.focus)} />
        </div>
        <div className="v-board-pos">
          <VBoard b={b} size={860} orientation="w" />
          {bubble}
        </div>
        <div className="v-bottom-card">{card("w")}</div>
        <div className="v-panel">
          <div className="v-brand">
            <span className="v-logo">♞ Agent Chess</span>
            <span className="v-opening">{opening}</span>
          </div>
          {callout}
          {/* Only moves have an engine line; while a player thinks the broadcaster box moves up instead of leaving a gap. */}
          {!t && (
          <div className="v-line">{line}</div>
          )}
          {/* The cold open and its rewind hold the big caption where the move list and chart go. */}
          {hook ?? (
            <>
              <MoveList g={g} ply={b.i + 1} />
              <ChartLegend g={g} />
              <EvalGraph prep={prep} g={g} ply={b.i + 1} width={840} height={130} />
            </>
          )}
        </div>
      </div>
    );

  return (
    <div className="v-game portrait">
      <div className="v-p-title">
        <span className="v-opening">{opening}</span>
      </div>
      <div className="v-p-callout">{callout}</div>
      {!hook && <div className="v-p-line v-line">{line}</div>}
      {/* How the game went so far, and how each player saw it; in the cold open, the hook caption instead. */}
      <div className={`v-p-caption ${hook ? "hooked" : ""}`}>
        {hook ? (
          hook
        ) : (
          <div className="v-p-chart">
            <ChartLegend g={g} />
            <EvalGraph prep={prep} g={g} ply={b.i + 1} width={900} height={150} />
          </div>
        )}
      </div>
      <div className="v-p-top-card">{card("b")}</div>
      <div className="v-p-evalbar">
        <EvalBar w={b.evalW} text={b.evalText} length={900} thickness={28} marks={barMarks(g, prep, b, v.focus)} />
      </div>
      <div className="v-p-board">
        <VBoard b={b} size={900} orientation="w" />
        {bubble}
      </div>
      <div className="v-p-bottom-card">{card("w")}</div>
    </div>
  );
}

/** "Before the game, X said…": a pre-game line coming back at the moment it's proven wrong (or right). */
function FlashbackScene({ g, s, v, wide }: { g: Game; s: Extract<Scene, { kind: "flashback" }>; v: View; wide: boolean }) {
  const ref = s.color === "w" ? g.white : g.black;
  const ws = s.text.split(/\s+/);
  return (
    <div className={`v-interview v-flashback ${wide ? "landscape" : "portrait"}`}>
      <div className="v-flashback-tag">⏮ Flashback · before the game</div>
      <div className="v-interview-head">
        <Avatar player={ref} size={wide ? 120 : 140} />
        <div>
          <div className="v-interview-kind">Pre-game interview</div>
          <div className="v-interview-name" style={{ color: makerOf(ref.provider).color }}>
            {ref.modelLabel}
          </div>
        </div>
      </div>
      <div className="v-quote" style={{ fontSize: wide ? 60 : 58 }}>
        {ws.map((w, i) => (
          <span key={i} style={{ opacity: i < (v.reveal ?? 0) ? 1 : 0 }}>
            {w}{" "}
          </span>
        ))}
      </div>
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
  else if (s.kind === "flashback") body = <FlashbackScene g={g} s={s} v={v} wide={wide} />;
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

/** The YouTube thumbnail: the director's chosen position with its verdict, a few huge words and the matchup. */
function Thumbnail({ g, prep }: { g: Game; prep: Prep }) {
  const pk = g.video?.packaging;
  const words = pk?.thumbnail.text ?? "";
  const i = Math.max(0, g.moves.findIndex((m) => m.ply === pk?.thumbnail.ply));
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
  const lobby = await api<Lobby>("/api/lobby");
  const out = {} as NonNullable<Ratings>;
  for (const c of ["w", "b"] as Color[]) {
    const ref = c === "w" ? g.white : g.black;
    const p = lobby.players.find((x) => x.id === ref.id);
    if (!p) return null;
    // Undo every rating change from games that finished after this one.
    const others = lobby.games.filter((s) => s.id !== g.id && s.phase === "finished" && (s.white.id === ref.id || s.black.id === ref.id));
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
    __video?: { ready: boolean; duration: number; scenes: Scene[]; fps: number; seek: (t: number) => string; settle: () => Promise<void> };
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
  }, [ready, tl]);

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
  useEffect(() => {
    const s = tl?.scenes[sceneIdx];
    if (render || !playing || !s?.voice) return;
    const audio = new Audio(s.voice.url);
    audio.playbackRate = s.voice.rate;
    // Picks up from wherever the preview is in the scene: its start, or mid-line after a seek or a pause.
    const into = (t - s.start - VOICE_AT) * s.voice.rate;
    const start = () => {
      audio.currentTime = Math.max(0, into);
      audio.play().catch(() => {});
    };
    const wait = setTimeout(start, Math.max(0, -into / s.voice.rate) * 1000);
    return () => {
      clearTimeout(wait);
      audio.pause();
    };
    // A new scene, play/pause or a seek starts or stops a line; time running on within the scene doesn't.
  }, [sceneIdx, playing, tl, render, seeks]);

  const [win, setWin] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => {
    const on = () => setWin({ w: innerWidth, h: innerHeight });
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);

  useEffect(() => {
    if (render) return;
    const on = (e: KeyboardEvent) => {
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
  if (!ready || !v) return <div className="v-msg">Loading…</div>;
  if (query.get("thumb") === "1") return <div className="v-render">{<Thumbnail g={game!} prep={prep!} />}</div>;

  const frame = <Frame g={game!} tl={tl!} prep={prep!} v={v} ratings={ratings!} rival={rival ?? null} />;
  if (render) return <div className="v-render">{frame}</div>;

  const { w, h } = FRAME[format];
  const scale = Math.min((win.w - 48 - PANEL_W) / w, (win.h - 130) / h);
  const swap = (f: Format) => `#/video/${id}?format=${f}${thoughts ? "" : "&thoughts=off"}${pace !== 1 ? `&pace=${pace}` : ""}`;
  return (
    <div className="v-preview">
      <div className="v-preview-main">
      <div className="v-stage" style={{ width: w * scale, height: h * scale }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}>{frame}</div>
      </div>
      <div className="v-controls">
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
      {meta && !meta.publicMode && <RenderPanel gameId={id} onPlan={() => setReload((n) => n + 1)} />}
    </div>
  );
}
