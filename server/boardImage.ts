import { readFileSync } from "node:fs";
import path from "node:path";
import { looseChess } from "../shared/rules";
import { Resvg } from "@resvg/resvg-js";
import type { Color } from "../shared/types";
import { ROOT } from "./paths";

const LIGHT = "#ebecd0";
const DARK = "#739552";
const HL_LIGHT = "#f5f682";
const HL_DARK = "#b9ca43";

const NAMES: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
let pieces: Record<string, string> | null = null;

/** Pull the cburnett piece SVGs (base64) out of chessground's stylesheet. */
function loadPieces() {
  if (pieces) return pieces;
  const css = readFileSync(path.join(ROOT, "node_modules", "chessground", "assets", "chessground.cburnett.css"), "utf8");
  pieces = {};
  const re = /piece\.(\w+)\.(white|black)\s*\{\s*background-image:\s*url\('data:image\/svg\+xml;base64,([^']+)'\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) pieces[`${m[2][0]}${m[1]}`] = m[3];
  return pieces;
}

/** Render the board as a human sees it on screen: orientation, last move, check. */
export function renderBoardPng(fen: string, orientation: Color, lastMove?: { from: string; to: string }): Buffer {
  const p = loadPieces();
  const c = looseChess(fen);
  const S = 80;
  const M = 24;
  const size = S * 8 + M * 2;
  const files = "abcdefgh";
  let checkSq: string | null = null;
  if (c.inCheck()) {
    for (const row of c.board()) for (const sq of row) if (sq && sq.type === "k" && sq.color === c.turn()) checkSq = sq.square;
  }
  const parts: string[] = [`<rect width="${size}" height="${size}" fill="#302e2b"/>`];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const file = orientation === "w" ? f : 7 - f;
      const rank = orientation === "w" ? 7 - r : r;
      const sq = files[file] + (rank + 1);
      const light = (file + rank) % 2 === 1;
      const hl = lastMove && (lastMove.from === sq || lastMove.to === sq);
      const fill = hl ? (light ? HL_LIGHT : HL_DARK) : light ? LIGHT : DARK;
      const x = M + f * S;
      const y = M + r * S;
      parts.push(`<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="${fill}"/>`);
      if (sq === checkSq) {
        parts.push(`<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="url(#check)"/>`);
      }
      const piece = c.get(sq as never);
      if (piece) {
        const key = `${piece.color}${NAMES[piece.type]}`;
        parts.push(`<image x="${x}" y="${y}" width="${S}" height="${S}" href="data:image/svg+xml;base64,${p[key]}"/>`);
      }
    }
  }
  for (let i = 0; i < 8; i++) {
    const fileLabel = files[orientation === "w" ? i : 7 - i];
    const rankLabel = String(orientation === "w" ? 8 - i : i + 1);
    parts.push(
      `<text x="${M + i * S + S / 2}" y="${size - 6}" font-size="16" font-family="Arial" font-weight="bold" fill="#d0cfcc" text-anchor="middle">${fileLabel}</text>`,
      `<text x="${M / 2}" y="${M + i * S + S / 2 + 6}" font-size="16" font-family="Arial" font-weight="bold" fill="#d0cfcc" text-anchor="middle">${rankLabel}</text>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
<defs><radialGradient id="check"><stop offset="0%" stop-color="#ff0000" stop-opacity="1"/><stop offset="25%" stop-color="#e70000" stop-opacity="1"/><stop offset="90%" stop-color="#a90000" stop-opacity="0"/></radialGradient></defs>
${parts.join("\n")}</svg>`;
  return new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
}
