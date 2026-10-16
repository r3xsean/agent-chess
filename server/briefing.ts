import { writeFileSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import type { Color, Game, MoveRecord } from "../shared/types";
import { personalityById } from "../shared/personalities";
import { fullName, isHuman, sideName } from "../shared/naming";
import { formatScore } from "../shared/evalmath";
import { materialInfo } from "../shared/material";
import { explainIllegal, lineBreakReason } from "../shared/explain";
import { board, playerOf, ratingOf } from "./game";
import { renderBoardPng } from "./boardImage";
import { agentDir, games, readJournal, readLessons } from "./store";
import { MAX_LESSONS, MAX_LESSON_LINES } from "./game";
import { modelLabel } from "../shared/models";

const colorName = (c: Color) => (c === "w" ? "White" : "Black");
const other = (c: Color): Color => (c === "w" ? "b" : "w");
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const SYMBOL: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };

export function describePlayer(g: Game, c: Color) {
  const p = playerOf(g, c);
  if (isHuman(p)) return `${p.modelLabel} (a human player, rating ${ratingOf(p)})`;
  return `${fullName(p)} (${p.effort} effort, rating ${ratingOf(p)})`;
}

export function asciiBoard(fen: string, orientation: Color): string {
  const c = new Chess(fen);
  const rows = c.board();
  const files = "abcdefgh";
  const out: string[] = [];
  const rankOrder = orientation === "w" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const fileOrder = orientation === "w" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const fileHeader = "    " + fileOrder.map((f) => files[f]).join(" ");
  out.push(fileHeader, "  +-----------------+");
  for (const r of rankOrder) {
    const cells = fileOrder.map((f) => {
      const sq = rows[r][f];
      if (!sq) return ".";
      return sq.color === "w" ? sq.type.toUpperCase() : sq.type;
    });
    out.push(`${8 - r} | ${cells.join(" ")} | ${8 - r}`);
  }
  out.push("  +-----------------+", fileHeader);
  return out.join("\n");
}

/** Every piece with its square — the same facts as the diagram, but easy to trace lines and diagonals from. */
export function pieceList(fen: string): string {
  const c = new Chess(fen);
  const ORDER = "kqrbnp";
  const LETTER: Record<string, string> = { k: "K", q: "Q", r: "R", b: "B", n: "N" };
  const side = (col: Color) => {
    const sq = c
      .board()
      .flat()
      .filter((s): s is NonNullable<typeof s> => !!s && s.color === col)
      .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.square.localeCompare(b.square));
    const pieces = sq.filter((s) => s.type !== "p").map((s) => LETTER[s.type] + s.square);
    const pawns = sq.filter((s) => s.type === "p").map((s) => s.square);
    return `${colorName(col)}: ${pieces.join(", ")}${pawns.length ? `; pawns ${pawns.join(", ")}` : "; no pawns"}`;
  };
  return `Pieces — ${side("w")}\nPieces — ${side("b")}`;
}

/** What chess.com shows next to each name: the pieces you've taken, and the material lead. */
function capturedSummary(g: Game) {
  const { captured, material } = materialInfo(g.moves[0]?.fenBefore ?? START_FEN, g.moves.map((m) => m.san));
  const lines: string[] = [];
  for (const col of ["w", "b"] as Color[]) {
    const taken: string[] = [];
    for (const t of ["q", "r", "b", "n", "p"]) {
      const n = captured[col].filter((x) => x === t).length;
      if (n > 0) taken.push(`${n} ${SYMBOL[t]}${n > 1 ? "s" : ""}`);
    }
    lines.push(`${colorName(col)} has captured: ${taken.length ? taken.join(", ") : "nothing"}`);
  }
  const diff = material.w - material.b;
  lines.push(diff === 0 ? "Material: level" : `Material: ${diff > 0 ? "White" : "Black"} +${Math.abs(diff)}`);
  return lines.join("\n");
}

export function moveList(moves: MoveRecord[]): string {
  if (!moves.length) return "(none yet)";
  const parts: string[] = [];
  for (const m of moves) parts.push(m.color === "w" ? `${Math.ceil(m.ply / 2)}. ${m.san}` : m.san);
  return parts.join(" ");
}

export function turnBrief(g: Game, color: Color): string {
  const c = board(g);
  const fen = c.fen();
  const last = g.moves[g.moves.length - 1];
  const moveNo = Math.ceil((g.moves.length + 1) / 2);
  const img = path.join(agentDir(g.id, color), "board.png");
  try {
    writeFileSync(img, renderBoardPng(fen, color, last ? { from: last.from, to: last.to } : undefined));
  } catch (e) {
    console.error("[board image]", e);
  }
  const out = [
    `=== YOUR MOVE — move ${moveNo}, you are ${colorName(color)} ===`,
    `Opponent: ${describePlayer(g, other(color))}`,
    "",
    "Board (your side at the bottom; White = UPPERCASE, Black = lowercase, '.' = empty):",
    asciiBoard(fen, color),
    "",
    ...(g.options?.pieceList ? [pieceList(fen), ""] : []),
    `FEN: ${fen}`,
    last ? `Last move: ${colorName(last.color)} played ${last.san} (${last.from} → ${last.to})` : "Last move: none — the game begins.",
  ];
  if (c.inCheck()) out.push("⚠ You are in CHECK.");
  out.push(capturedSummary(g));
  out.push(`Moves so far: ${moveList(g.moves)}`);
  if (g.drawOffer === other(color)) {
    out.push("", "🤝 Your opponent has offered a draw. Accept with `accept-draw`, or simply make a move to decline.");
  }
  if (g.pendingIllegal[color].length) out.push(`(Rejected this turn: ${g.pendingIllegal[color].join(", ")})`);
  const lessons = g.options?.learning ? readLessons(playerOf(g, color).model).text : "";
  if (lessons) out.push("", "Your lessons from past games (keep them in mind — they sharpen your execution, they don't change your style or risk appetite):", lessons);
  out.push("", `Board image (same position, as it looks on screen): ${img}`);
  out.push("", "Submit with: move <turn.json>   (see your instructions for the JSON format)");
  return out.join("\n");
}

function headToHead(g: Game, color: Color) {
  const me = playerOf(g, color).id;
  const opp = playerOf(g, other(color)).id;
  let w = 0,
    d = 0,
    l = 0;
  for (const x of games.values()) {
    if (!x.result || x.id === g.id) continue;
    const ids = [x.white.id, x.black.id];
    if (!ids.includes(me) || !ids.includes(opp) || me === opp) continue;
    const myColor: Color = x.white.id === me ? "w" : "b";
    if (x.result === "1/2-1/2") d++;
    else if ((x.result === "1-0") === (myColor === "w")) w++;
    else l++;
  }
  return w + d + l ? `Your record against this opponent: ${w} wins, ${d} draws, ${l} losses.` : "You have never played this opponent before.";
}

export function pregameBrief(g: Game, color: Color): string {
  const me = playerOf(g, color);
  const opp = playerOf(g, other(color)).id;
  const all = readJournal(me.id);
  // Last 3 entries overall, plus the last 2 against this opponent (so rivalry notes don't scroll away).
  const picked = new Set([...all.slice(-3), ...all.filter((e) => e.opponent === opp).slice(-2)]);
  const journal = all.filter((e) => picked.has(e));
  const out = [
    "=== PRE-GAME ===",
    `You are ${colorName(color)}: ${describePlayer(g, color)}`,
    `Opponent (${colorName(other(color))}): ${describePlayer(g, other(color))}`,
    isHuman(playerOf(g, other(color)))
      ? "Your opponent is a human, playing their own moves on the website."
      : `Opponent's style: ${personalityById(playerOf(g, other(color)).personality).tagline}`,
    headToHead(g, color),
    "",
    journal.length ? "Your journal — recent games, plus your notes on this opponent (oldest first):" : "Your journal is empty — this is your first game.",
    ...journal.map((e) => `- [${new Date(e.ts).toISOString().slice(0, 10)} vs ${e.opponent}, result ${e.result}, you were ${colorName(e.color)}] ${e.text}`),
    "",
    ...lessonsBlock(g, color),
    "INTERVIEWER: \"Welcome to the board. How are you feeling about this matchup, and what's your plan for the game?\"",
    "Answer in character, under 800 characters, with: interview <file.txt>  (or: interview --text \"...\")",
  ];
  return out.join("\n");
}

function lessonsBlock(g: Game, color: Color): string[] {
  if (!g.options?.learning) return [];
  const model = playerOf(g, color).model;
  const l = readLessons(model);
  return l.text
    ? [`Your LESSONS — your own playbook, written by you after past games (shared by every ${modelLabel(model)} player):`, l.text, ""]
    : ["You have no lessons yet. After this game you'll study your worst moves and write your first ones.", ""];
}

/** Engine line as SAN, starting from a position. */
export function pvSan(fen: string, pv: string[] | undefined, plies = 6): string {
  if (!pv?.length) return "";
  const c = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, plies)) {
    try {
      out.push(c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  return out.join(" ");
}

/** The player's worst moves, explained: position, their own thinking at the time, the engine's best line and refutation. */
function worstMoves(g: Game, color: Color, limit = 5): string[] {
  const mine = g.moves
    .filter((m) => m.color === color && m.analysis && !m.analysis.unavailable)
    .filter((m) => ["blunder", "mistake", "miss", "inaccuracy"].includes(m.analysis!.classification))
    .sort((a, b) => b.analysis!.winBefore - b.analysis!.winAfter - (a.analysis!.winBefore - a.analysis!.winAfter))
    .slice(0, limit)
    .sort((a, b) => a.ply - b.ply);
  if (!mine.length) return ["No mistakes worth reviewing — clean game."];
  const out: string[] = [];
  for (const m of mine) {
    const a = m.analysis!;
    const no = `${Math.ceil(m.ply / 2)}${m.color === "w" ? "." : "..."}`;
    const before = g.analysis[m.fenBefore];
    const after = g.analysis[m.fenAfter];
    out.push(
      `--- ${no} ${m.san} — ${a.classification.toUpperCase()} (your winning chances ${Math.round(a.winBefore)}% → ${Math.round(a.winAfter)}%)`,
      asciiBoard(m.fenBefore, color),
      `FEN before your move: ${m.fenBefore}`,
      `What you thought: "${m.commentary.slice(0, 350)}${m.commentary.length > 350 ? "…" : ""}" (your eval ${m.selfEvalRaw}, engine after your move ${formatScore(a.evalAfter)})`,
      `Engine's best was ${a.bestSan ?? "?"}: ${pvSan(m.fenBefore, before?.pv)}`,
      `What punishes ${m.san}: ${pvSan(m.fenAfter, after?.pv) || "(no line available)"}`,
      "",
    );
  }
  return out;
}

export function postgameBrief(g: Game, color: Color): string {
  const r = g.review?.[color];
  const res = g.result === "1/2-1/2" ? "Draw" : (g.result === "1-0") === (color === "w") ? "You WON" : "You LOST";
  const mine = g.moves.filter((m) => m.color === color && m.analysis);
  const notable = mine.filter((m) => ["brilliant", "great", "blunder", "mistake", "miss"].includes(m.analysis!.classification));
  const out = [
    "=== GAME OVER ===",
    `${res} — ${g.result} (${g.termination}). Rating change: ${g.ratingChange?.[color] && g.ratingChange[color] > 0 ? "+" : ""}${g.ratingChange?.[color] ?? 0}`,
    `Full game: ${moveList(g.moves)}`,
    "",
    "Engine review of your play (now that the game is over, you may see it):",
    r && r.accuracy != null
      ? `Accuracy ${r.accuracy}% · estimated performance ~${r.estElo} · your self-evaluations were off by ${r.selfEvalError ?? "?"} pawns on average`
      : "(engine review unavailable for this game)",
    r ? `Move quality: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(", ")}` : "",
    ...notable.map((m) => {
      const a = m.analysis!;
      const no = `${Math.ceil(m.ply / 2)}${m.color === "w" ? "." : "..."}`;
      return `- ${no} ${m.san}: ${a.classification.toUpperCase()}${a.bestSan && a.bestSan !== m.san ? ` (engine preferred ${a.bestSan})` : ""}, eval after ${formatScore(a.evalAfter)}`;
    }),
  ];
  if (personalityById(playerOf(g, color).personality).risk === "wild")
    out.push(
      "",
      "Note: you play for practical chances, so the engine will mark some deliberate risks as inaccuracies or mistakes. Judge a risk by whether it was a real practical chance, not by the engine's number — but a risk that simply lost material for nothing is still a mistake.",
    );
  if (g.options?.learning) out.push("", "Your worst moves, in detail (diagrams from your side):", ...worstMoves(g, color));
  const needs: string[] = [];
  if (!g.interviews.post[color]) {
    needs.push(
      "1) INTERVIEWER: \"Walk us through that game — what was the key moment, and how do you feel about it?\"",
      "   Answer in character, under 800 characters: interview <file.txt>",
    );
  }
  if (!g.journalDone[color]) {
    needs.push(
      g.options?.learning
        ? "2) Write a SHORT private journal entry (under 600 characters) about this game and this opponent — what happened, what they like to do. Future-you reads your recent entries before each game."
        : "2) Write a SHORT private journal entry (under 600 characters) with lessons you want to remember for future games — about your own play, and about this opponent. Future-you will read it before the next game.",
      "   Submit with: journal <file.txt>",
    );
  }
  if (g.options?.learning && !g.lessonsDone?.[color]) {
    const model = playerOf(g, color).model;
    const l = readLessons(model);
    // Remember which version this player was shown, so a concurrent update can't be silently overwritten.
    g.lessonsSeen = { ...g.lessonsSeen, [color]: l.version };
    needs.push(
      `3) Update your LESSONS — your playbook, shown to you before and during every future game (shared by all your ${modelLabel(model)} personalities).`,
      `   Study your worst moves above. Then rewrite the WHOLE list: at most ${MAX_LESSON_LINES} bullet items and ${MAX_LESSONS} characters in total. Keep what still matters, merge duplicates, sharpen vague items, drop what's stale, add what this game taught you.`,
      "   Each item is one bullet in the form \"- When [situation] → [what to do]\", e.g. \"- When a piece leaves a diagonal or file → re-check what that line now opens for BOTH sides, especially a queen or bishop standing behind it.\"",
      "   Lessons are GENERAL PRINCIPLES about how you think, calculate and check moves — no opening move sequences, no specific positions.",
      "   They're shared by every personality you play, calm or wild, so they're about EXECUTION, never about how much risk to take: no \"avoid gambits\", \"play solid\" or \"don't sacrifice\". Your personality decides the risk; lessons make you better at whatever style you're playing (e.g. \"- When I sacrifice for an attack → count the attackers and defenders around the king before committing.\").",
      `   Your current lessons: ${l.text ? `\n${l.text}` : "(none yet)"}`,
      "   Submit with: lessons <file.txt>",
    );
  }
  if (needs.length) out.push("", "Still to do:", ...needs);
  return out.join("\n");
}

/* ------------------------- broadcaster event feed ------------------------- */

export interface FeedEvent {
  id: string;
  ts: number;
  text: string;
}

export function broadcasterEvents(g: Game): FeedEvent[] {
  const ev: FeedEvent[] = [];
  const W = describePlayer(g, "w");
  const B = describePlayer(g, "b");
  ev.push({ id: "matchup", ts: g.createdAt, text: `[MATCHUP] White: ${W}  vs  Black: ${B}` });
  for (const c of ["w", "b"] as Color[]) {
    const i = g.interviews.pre[c];
    if (i) ev.push({ id: `pre-${c}`, ts: i.ts, text: `[PRE-GAME INTERVIEW — ${colorName(c)}, ${sideName(g, c)}] "${i.text}"` });
  }
  if (g.playStartedAt) ev.push({ id: "start", ts: g.playStartedAt, text: "[GAME STARTED] White is on move." });
  for (const m of g.moves) {
    if (!m.analysis) break; // wait for the engine so every move event carries its review
    const a = m.analysis;
    const human = isHuman(playerOf(g, m.color));
    const who = `${colorName(m.color)} (${sideName(g, m.color)}${human ? ", the human" : ""})`;
    const no = `${Math.ceil(m.ply / 2)}${m.color === "w" ? "." : "..."}`;
    // A human shares no thinking or self-evaluation, only the move.
    const own = human ? "" : ` Player's own eval: ${m.selfEvalRaw}.`;
    const parts = [
      `[MOVE ${no} ${m.san}] by ${who}, thought for ${Math.round(m.thinkMs / 1000)}s.`,
      a.unavailable
        ? `Engine: analysis unavailable for this move.${own}`
        : `Engine: ${a.classification.toUpperCase()}; eval now ${formatScore(a.evalAfter)}${a.bestSan && a.bestSan !== m.san ? `; engine preferred ${a.bestSan}` : ""}.${own}`,
    ];
    if (!human) parts.push(`Player's thinking: "${m.commentary.slice(0, 700)}${m.commentary.length > 700 ? "…" : ""}"`);
    if (m.lines.length)
      parts.push(
        `Calculated lines: ${m.lines.map((l, i) => `(${i + 1}) ${l.san.join(" ")}${l.brokenAt ? ` [breaks: ${l.brokenAt} is illegal — ${lineBreakReason(m.fenBefore, l)}]` : ""}${l.note ? ` — ${l.note.slice(0, 160)}` : ""}`).join(" | ")}`,
      );
    if (m.illegalAttempts.length)
      parts.push(`Before this, the player tried illegal move(s): ${m.illegalAttempts.map((t) => `${t} (${explainIllegal(m.fenBefore, t)})`).join(", ")}.`);
    if (m.offeredDraw) parts.push(`${colorName(m.color)} offered a draw with this move.`);
    ev.push({ id: `move-${m.ply}`, ts: m.ts, text: parts.join("\n") });
  }
  if (g.result && g.moves.every((m) => m.analysis)) {
    ev.push({ id: "result", ts: Date.now(), text: `[RESULT] ${g.result} — ${g.termination}.` });
  }
  if (g.review) {
    const rv = (c: Color) =>
      g.review![c].accuracy != null ? `${colorName(c)} accuracy ${g.review![c].accuracy}% (≈${g.review![c].estElo})` : `${colorName(c)} accuracy unavailable`;
    ev.push({ id: "review", ts: Date.now(), text: `[GAME REVIEW] ${rv("w")}, ${rv("b")}.` });
  }
  for (const c of ["w", "b"] as Color[]) {
    const i = g.interviews.post[c];
    if (i) ev.push({ id: `post-${c}`, ts: i.ts, text: `[POST-GAME INTERVIEW — ${colorName(c)}] "${i.text}"` });
  }
  return ev;
}
