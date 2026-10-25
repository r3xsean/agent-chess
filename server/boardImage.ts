import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { looseChess } from "../shared/rules";
import type { Color, Game } from "../shared/types";
import { DATA, ROOT } from "./paths";
import { agentDir } from "./store";

/*
 * The board picture an experiment's seat is shown each turn (shared/seatSetup.ts): the position with White at
 * the bottom, coordinates round the edge, the last move tinted and a king in check ringed, and a check code
 * that changes every turn. A move is only taken with the code of the picture for that position, so a player can't
 * play without having looked at it.
 */

const SQ = 72;
const EDGE = 26;
const HEAD = 44;
const BOARD = SQ * 8;
const W = BOARD + EDGE * 2;
const H = HEAD + BOARD + EDGE * 2;
const LIGHT = "#f0d9b5";
const DARK = "#b58863";

const ROLE: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

/** The website's own pieces (chessground's cburnett set), each an <svg> 45 units square. */
let pieceSvgs: Map<string, string> | undefined;
function pieces() {
  if (pieceSvgs) return pieceSvgs;
  const css = readFileSync(path.join(ROOT, "node_modules", "chessground", "assets", "chessground.cburnett.css"), "utf8");
  pieceSvgs = new Map();
  for (const m of css.matchAll(/piece\.(\w+)\.(white|black)\s*\{\s*background-image:\s*url\('data:image\/svg\+xml;base64,([^']+)'\)/g))
    pieceSvgs.set(`${m[2][0]}${m[1]}`, Buffer.from(m[3], "base64").toString("utf8"));
  return pieceSvgs;
}

/** No letters that read as another (0/O, 1/I/L, 5/S, 2/Z, 8/B). */
const CODE_CHARS = "ACDEFHJKMNPRTVWXY3479";

/** A secret the codes are made from, kept with the games so they stay the same across a restart. */
let secret: string | undefined;
function codeSecret() {
  if (secret) return secret;
  const f = path.join(DATA, "board-code-secret.txt");
  if (existsSync(f)) secret = readFileSync(f, "utf8").trim();
  if (!secret) {
    secret = randomBytes(24).toString("hex");
    writeFileSync(f, secret);
  }
  return secret;
}

/** The check code on the picture of this position: the same each time it's shown, a new one every move. */
export function boardCode(g: Game, c: Color, ply = g.moves.length) {
  const h = createHmac("sha256", codeSecret()).update(`${g.id}|${c}|${ply}`).digest();
  return Array.from(h.subarray(0, 3), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

/** Where a seat's picture of the current position is written (one file per position, so no viewer shows a stale one). */
export const boardImagePath = (g: Game, c: Color) => path.join(agentDir(g.id, c), `board-${String(g.moves.length).padStart(3, "0")}.png`);

const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The picture as SVG: `fen` from `orientation`'s side, `last` move tinted, the side to move's king ringed when in check. */
export function boardSvg(fen: string, orientation: Color, code: string, last?: { from: string; to: string }) {
  const c = looseChess(fen);
  const rows = c.board();
  const files = "abcdefgh";
  // Screen column/row of a square, White or Black at the bottom.
  const at = (sq: string) => {
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]) - 1;
    return orientation === "w" ? { x: f, y: 7 - r } : { x: 7 - f, y: r };
  };
  const ox = EDGE;
  const oy = HEAD + EDGE;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#2b2926"/>`,
    `<text x="${W / 2}" y="30" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="bold" fill="#ffffff">Check code: ${esc(code)}</text>`,
  ];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) out.push(`<rect x="${ox + x * SQ}" y="${oy + y * SQ}" width="${SQ}" height="${SQ}" fill="${(x + y) % 2 ? DARK : LIGHT}"/>`);
  if (last)
    for (const sq of [last.from, last.to]) {
      const p = at(sq);
      out.push(`<rect x="${ox + p.x * SQ}" y="${oy + p.y * SQ}" width="${SQ}" height="${SQ}" fill="#cdd26a" fill-opacity="0.75"/>`);
    }
  if (c.inCheck()) {
    const king = rows.flat().find((s) => s && s.type === "k" && s.color === c.turn());
    if (king) {
      const p = at(king.square);
      out.push(`<circle cx="${ox + p.x * SQ + SQ / 2}" cy="${oy + p.y * SQ + SQ / 2}" r="${SQ * 0.46}" fill="#e02020" fill-opacity="0.55"/>`);
    }
  }
  const set = pieces();
  const scale = SQ / 45;
  for (const s of rows.flat()) {
    if (!s) continue;
    const svg = set.get(`${s.color}${ROLE[s.type]}`);
    if (!svg) continue;
    const p = at(s.square);
    out.push(`<g transform="translate(${ox + p.x * SQ} ${oy + p.y * SQ}) scale(${scale})">${svg.replace(/<\?xml[^>]*>/, "")}</g>`);
  }
  // Coordinates on all four sides.
  const label = (x: number, y: number, t: string) =>
    `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="bold" fill="#e8e6e3">${t}</text>`;
  for (let i = 0; i < 8; i++) {
    const file = orientation === "w" ? files[i] : files[7 - i];
    const rank = orientation === "w" ? String(8 - i) : String(i + 1);
    out.push(label(ox + i * SQ + SQ / 2, oy - EDGE / 2, file), label(ox + i * SQ + SQ / 2, oy + BOARD + EDGE / 2, file));
    out.push(label(EDGE / 2, oy + i * SQ + SQ / 2, rank), label(ox + BOARD + EDGE / 2, oy + i * SQ + SQ / 2, rank));
  }
  out.push("</svg>");
  return out.join("");
}

export const renderPng = (svg: string) => new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();

/**
 * The picture of the current position for a seat, written once per position (the earlier ones removed): its
 * path. White at the bottom for both colours, like the text diagram, so a seat shown both never has to turn one
 * round to match the other; the last move tinted.
 */
export function writeBoardImage(g: Game, c: Color): string {
  const file = boardImagePath(g, c);
  if (existsSync(file)) return file;
  const dir = path.dirname(file);
  for (const f of readdirSync(dir)) if (/^board-\d+\.png$/.test(f)) rmSync(path.join(dir, f), { force: true });
  const lastMove = g.moves[g.moves.length - 1];
  const fen = lastMove?.fenAfter ?? g.startFen ?? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  writeFileSync(file, renderPng(boardSvg(fen, "w", boardCode(g, c), lastMove && { from: lastMove.from, to: lastMove.to })));
  return file;
}
