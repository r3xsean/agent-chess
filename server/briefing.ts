import type { Square } from "chess.js";
import { castlingNote, looseChess, newRules, variantOf, type Variant } from "../shared/rules";
import type { Color, Game, MoveRecord } from "../shared/types";
import { fullName, isHuman, sideName } from "../shared/naming";
import { formatScore } from "../shared/evalmath";
import { materialInfo } from "../shared/material";
import { explainIllegal, lineBreakReason } from "../shared/explain";
import { board, isRated, playerOf, ratingOf, startFenOf } from "./game";
import { rivalry, seriesLine } from "./rivalry";

const colorName = (c: Color) => (c === "w" ? "White" : "Black");
const other = (c: Color): Color => (c === "w" ? "b" : "w");
const SYMBOL: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };

export function describePlayer(g: Game, c: Color) {
  const p = playerOf(g, c);
  // Once the game is rated, the rating it was played at (games since don't change who was the favourite).
  const rating = g.ratingBefore?.[c] ?? ratingOf(p);
  if (isHuman(p)) return `${p.modelLabel} (a human player, rating ${rating})`;
  return `${fullName(p)} (${p.effort} effort, rating ${rating})`;
}

export function asciiBoard(fen: string, orientation: Color): string {
  const c = looseChess(fen);
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
  const c = looseChess(fen);
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
  const { captured, material } = materialInfo(startFenOf(g), g.moves.map((m) => m.san), variantOf(g));
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

/** Display the last double pawn push, without revealing whether en passant is legal. */
export function briefingFen(g: Game, fen: string): string {
  const fields = fen.split(" ");
  const last = g.moves[g.moves.length - 1];
  // A custom starting position may carry its own en-passant target.
  fields[3] = last ? "-" : startFenOf(g).split(" ")[3];
  if (last && last.from[0] === last.to[0] && Math.abs(Number(last.from[1]) - Number(last.to[1])) === 2
      && looseChess(last.fenBefore).get(last.from as Square)?.type === "p") {
    fields[3] = `${last.from[0]}${(Number(last.from[1]) + Number(last.to[1])) / 2}`;
  }
  return fields.join(" ");
}

export function turnBrief(g: Game, color: Color): string {
  const c = board(g);
  const fen = briefingFen(g, c.fen());
  const toMove = c.turn();
  const last = g.moves[g.moves.length - 1];
  const moveNo = fen.split(" ")[5];
  const chess960 = variantOf(g) === "chess960";
  const out = [
    toMove === color ? "=== YOUR MOVE ===" : "=== POSITION STATUS ===",
    `Game: ${g.id}`,
    `Variant: ${chess960 ? `Chess960 (start position #${g.chess960})` : "Standard chess"}`,
    `You are: ${colorName(color)}`,
    `Side to move: ${colorName(toMove)}`,
    `Move: ${moveNo}${toMove === "w" ? "." : "..."}`,
    `Next ply: ${g.moves.length + 1} — ${g.moves.length} individual moves have been played.`,
    "",
    "The CURRENT POSITION below is authoritative and supersedes earlier board snapshots. Your earlier plans and calculated variations are hypothetical unless that continuation was actually played, as recorded in ACTUAL GAME HISTORY.",
    "",
    "=== ACTUAL GAME HISTORY ===",
    ...(chess960 ? [`Starting FEN: ${startFenOf(g)}`] : []),
    "These are all moves actually played, from the starting position (SAN):",
    moveList(g.moves),
    "",
    last ? `Last move: ${colorName(last.color)} played ${last.san} (${last.from} → ${last.to})` : "Last move: none — the game begins.",
    "",
    "=== CURRENT POSITION ===",
    `The ${g.options?.pieceList ? "FEN, piece list, and diagram" : "FEN and diagram"} describe the same current position.`,
    `FEN: ${fen}`,
    "",
    ...(g.options?.pieceList ? [pieceList(fen), ""] : []),
    "Board orientation: White at the bottom, regardless of your color.",
    `You are ${colorName(color)}; your pieces are ${color === "w" ? "UPPERCASE" : "lowercase"}.`,
    "K/k = king; Q/q = queen; R/r = rook; B/b = bishop; N/n = knight; P/p = pawn.",
    "White = UPPERCASE; Black = lowercase; '.' = empty.",
    asciiBoard(fen, "w"),
    "",
    "=== GAME NOTICES ===",
    ...(chess960 ? [`Chess960 castling rules (from the starting setup): ${castlingNote(startFenOf(g))}`] : []),
  ];
  if (c.inCheck()) out.push(toMove === color ? "⚠ You are in CHECK." : `⚠ ${colorName(toMove)} is in CHECK.`);
  if (g.drawOffer === other(color)) {
    out.push("🤝 Your opponent has offered a draw. Accept with `accept-draw`, or simply make a move to decline.");
  } else {
    out.push(g.drawOffer === color ? "Your draw offer is pending." : "No pending draw offer.");
  }
  out.push(g.pendingIllegal[color].length ? `Rejected attempts this turn (not played): ${g.pendingIllegal[color].join(", ")}` : "No rejected attempts this turn.");
  out.push(capturedSummary(g));
  out.push(
    "",
    toMove === color
      ? "Choose your move from this position and submit it through the CLI using the required move JSON. SAN and UCI notation are both accepted."
      : `It is ${colorName(toMove)}'s turn. Run \`wait\` for your next turn.`,
  );
  return out.join("\n");
}

/** After the game, where the series between the two models stands now (empty for a first meeting). */
function seriesNow(g: Game, color: Color): string {
  const r = rivalry(g);
  if (!r || r.before.w + r.before.b + r.before.draws === 0) return "";
  const opp = sideName(g, other(color));
  return ` ${seriesLine(r.after, (c) => (c === color ? "you" : opp)).replace(/^you leads/, "You lead")} now.`;
}

/**
 * Before the game a player hears nothing about its earlier games against this opponent (no record, last result
 * or replay headline), so each game stands on its own.
 */
export function pregameBrief(g: Game, color: Color): string {
  const out = [
    "=== PRE-GAME ===",
    `You are ${colorName(color)}: ${describePlayer(g, color)}`,
    `Opponent (${colorName(other(color))}): ${describePlayer(g, other(color))}`,
    ...(isHuman(playerOf(g, other(color))) ? ["Your opponent is a human, playing their own moves on the website."] : []),
    ...(isRated(g) ? [] : ["This game is unrated: the result won't change either player's rating."]),
    ...(variantOf(g) === "chess960" ? ["", ...chess960Intro(g)] : []),
    "",
    'INTERVIEWER: "Welcome to the board. How are you feeling about this matchup, and what\'s your plan for the game?"',
    "Answer in your own voice, under 800 characters, with: interview -  (text on standard input)",
  ];
  return out.join("\n");
}

/** What a player needs to know before a Chess960 game: the shuffled back rank, and how castling works. */
export function chess960Intro(g: Game): string[] {
  const fen = startFenOf(g);
  return [
    `This game is CHESS960 (Fischer Random), start position #${g.chess960}. Both sides use the same back-rank arrangement on their respective home ranks. Ordinary opening sequences may not apply to this setup. All other rules are normal.`,
    "Starting position (White at the bottom):",
    asciiBoard(fen, "w"),
    castlingNote(fen),
    'To castle, send "O-O" or "O-O-O".',
  ];
}

/** Engine line as SAN, starting from a position. */
export function pvSan(fen: string, pv: string[] | undefined, plies = 6, variant: Variant = "standard"): string {
  if (!pv?.length) return "";
  const c = newRules(fen, variant);
  const out: string[] = [];
  for (const uci of pv.slice(0, plies)) {
    try {
      out.push(c.move(uci).san);
    } catch {
      break;
    }
  }
  return out.join(" ");
}

export function postgameBrief(g: Game, color: Color): string {
  const needs = postgameNeeds(g, color);
  const r = g.review?.[color];
  const res = g.result === "1/2-1/2" ? "Draw" : (g.result === "1-0") === (color === "w") ? "You WON" : "You LOST";
  const mine = g.moves.filter((m) => m.color === color && m.analysis);
  const notable = mine.filter((m) => ["brilliant", "great", "blunder", "mistake", "miss"].includes(m.analysis!.classification));
  const out = [
    "=== GAME OVER ===",
    `${res} — ${g.result} (${g.termination}). ${isRated(g) ? `Rating change: ${g.ratingChange?.[color] && g.ratingChange[color] > 0 ? "+" : ""}${g.ratingChange?.[color] ?? 0}` : "Unrated game: no rating change."}`,
    `Full game: ${moveList(g.moves)}`,
    "",
    "Engine review of your play (now that the game is over, you may see it):",
    r && r.accuracy != null
      ? `Accuracy ${r.accuracy}% · estimated performance ~${r.estElo} · your self-evaluations were off by ${r.selfEvalError ?? "?"} percentage points of winning chances on average`
      : "(engine review unavailable for this game)",
    r ? `Move quality: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(", ")}` : "",
    ...notable.map((m) => {
      const a = m.analysis!;
      const no = `${Math.ceil(m.ply / 2)}${m.color === "w" ? "." : "..."}`;
      return `- ${no} ${m.san}: ${a.classification.toUpperCase()}${a.bestSan && a.bestSan !== m.san ? ` (engine preferred ${a.bestSan})` : ""}, eval after ${formatScore(a.evalAfter)}`;
    }),
  ];
  if (needs.lines.length) out.push("", "Still to do:", ...needs.lines, "", postgameSubmit(needs.keys));
  return out.join("\n");
}

/** The post-game tasks a player hasn't done yet, and the `postgame` JSON keys they go in. */
function postgameNeeds(g: Game, color: Color) {
  const lines: string[] = [];
  const keys: string[] = [];
  if (!g.interviews.post[color]) {
    keys.push("interview");
    lines.push(
      `1) "interview": INTERVIEWER: "Walk us through that game — what was the key moment, and how do you feel about it?${seriesNow(g, color)}"`,
      "   Answer in your own voice, under 800 characters.",
    );
  }
  return { lines, keys };
}

const postgameSubmit = (keys: string[]) => `Submit it with \`postgame\`, as JSON: { ${keys.map((k) => `"${k}": "…"`).join(", ")} }`;

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
  ev.push({ id: "matchup", ts: g.createdAt, text: `[MATCHUP] White: ${W}  vs  Black: ${B}${variantOf(g) === "chess960" ? `\n${chess960Intro(g).join("\n")}` : ""}` });
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
        `Calculated lines: ${m.lines.map((l, i) => `(${i + 1}) ${l.san.join(" ")}${l.brokenAt ? ` [breaks: ${l.brokenAt} is illegal — ${lineBreakReason(m.fenBefore, l, variantOf(g))}]` : ""}${l.note ? ` — ${l.note.slice(0, 160)}` : ""}`).join(" | ")}`,
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
