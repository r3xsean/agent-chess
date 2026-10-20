import { Chess as ChessJs } from "chess.js";
import { Chess as Pos } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { castlingSide } from "chessops/chess";
import { makeSquare, makeUci, parseSquare } from "chessops/util";
import type { Move as OpsMove, NormalMove, Role } from "chessops/types";
import type { Color } from "./types";

/*
 * The rules of the game being played. Standard games run on chess.js, as they always have.
 * Chess960 games run on chessops (lichess's rules library), because chess.js only knows the
 * standard castling squares. Both sit behind the same small, chess.js-shaped interface.
 *
 * In Chess960, UCI castling is "king takes own rook" (e.g. f1h1) — the same convention Stockfish
 * uses with UCI_Chess960 — and SAN is the usual O-O / O-O-O.
 */

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type Variant = "standard" | "chess960";

export interface RulesMove {
  color: Color;
  from: string;
  /** Where the moving piece lands. For castling, the king's destination (g- or c-file). */
  to: string;
  san: string;
  /** Engine notation: castling is king-to-rook in Chess960, king-to-destination in standard chess. */
  uci: string;
  piece: string;
  captured?: string;
  promotion?: string;
  before: string;
  after: string;
}

export interface Rules {
  fen(): string;
  turn(): Color;
  inCheck(): boolean;
  isCheckmate(): boolean;
  isStalemate(): boolean;
  isInsufficientMaterial(): boolean;
  isThreefoldRepetition(): boolean;
  isDrawByFiftyMoves(): boolean;
  /** Plays SAN (lenient) or UCI; throws on an illegal move, like chess.js. */
  move(input: string | { from: string; to: string; promotion?: string }): RulesMove;
  /** Every legal move. */
  moves(): RulesMove[];
}

const ROLE_CHAR: Record<Role, string> = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };
const CHAR_ROLE: Record<string, Role> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

/* ------------------------------ standard: chess.js ------------------------------ */

class StandardRules implements Rules {
  private c: ChessJs;
  constructor(fen: string) {
    this.c = new ChessJs(fen);
  }
  fen = () => this.c.fen();
  turn = () => this.c.turn();
  inCheck = () => this.c.inCheck();
  isCheckmate = () => this.c.isCheckmate();
  isStalemate = () => this.c.isStalemate();
  isInsufficientMaterial = () => this.c.isInsufficientMaterial();
  isThreefoldRepetition = () => this.c.isThreefoldRepetition();
  isDrawByFiftyMoves = () => this.c.isDrawByFiftyMoves();
  private wrap(m: ReturnType<ChessJs["move"]>): RulesMove {
    return {
      color: m.color,
      from: m.from,
      to: m.to,
      san: m.san,
      uci: m.from + m.to + (m.promotion ?? ""),
      piece: m.piece,
      captured: m.captured,
      promotion: m.promotion,
      before: m.before,
      after: m.after,
    };
  }
  move(input: string | { from: string; to: string; promotion?: string }) {
    if (typeof input === "string") {
      if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(input)) {
        const t = input.toLowerCase();
        return this.wrap(this.c.move({ from: t.slice(0, 2), to: t.slice(2, 4), promotion: t[4] }));
      }
      return this.wrap(this.c.move(input, { strict: false }));
    }
    return this.wrap(this.c.move(input));
  }
  moves() {
    return this.c.moves({ verbose: true }).map((m) => this.wrap(m));
  }
}

/* ------------------------------ Chess960: chessops ------------------------------ */

/** Position key for repetition: board, side, castling and en passant (move counters left out). */
const repKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

class Chess960Rules implements Rules {
  private pos: Pos;
  private seen: string[];
  constructor(fen: string) {
    const setup = parseFen(fen).unwrap();
    this.pos = Pos.fromSetup(setup).unwrap();
    this.seen = [repKey(this.fen())];
  }
  fen = () => makeFen(this.pos.toSetup());
  turn = (): Color => (this.pos.turn === "white" ? "w" : "b");
  inCheck = () => this.pos.isCheck();
  isCheckmate = () => this.pos.isCheckmate();
  isStalemate = () => this.pos.isStalemate();
  isInsufficientMaterial = () => this.pos.isInsufficientMaterial();
  isThreefoldRepetition = () => {
    const now = this.seen[this.seen.length - 1];
    return this.seen.filter((k) => k === now).length >= 3;
  };
  isDrawByFiftyMoves = () => this.pos.halfmoves >= 100 && !this.pos.isCheckmate();

  /** Describes a legal move without playing it. */
  private describe(m: NormalMove): RulesMove {
    const before = this.fen();
    const piece = this.pos.board.get(m.from)!;
    const side = castlingSide(this.pos, m);
    const target = this.pos.board.get(m.to);
    let captured: string | undefined;
    if (!side) {
      if (target && target.color !== piece.color) captured = ROLE_CHAR[target.role];
      else if (piece.role === "pawn" && m.to === this.pos.epSquare) captured = "p";
    }
    const san = makeSan(this.pos, m);
    const next = this.pos.clone();
    next.play(m);
    const rank = piece.color === "white" ? "1" : "8";
    return {
      color: piece.color === "white" ? "w" : "b",
      from: makeSquare(m.from),
      to: side ? `${side === "h" ? "g" : "c"}${rank}` : makeSquare(m.to),
      san,
      uci: makeUci(m),
      piece: ROLE_CHAR[piece.role],
      captured,
      promotion: m.promotion ? ROLE_CHAR[m.promotion] : undefined,
      before,
      after: makeFen(next.toSetup()),
    };
  }

  private play(m: NormalMove): RulesMove {
    const rec = this.describe(m);
    this.pos.play(m);
    this.seen.push(repKey(this.fen()));
    return rec;
  }

  /** UCI or from/to: king-to-rook castling, or the king's destination square when that isn't a plain king move. */
  private fromCoords(from: string, to: string, promotion?: string): NormalMove | undefined {
    const f = parseSquare(from);
    const t = parseSquare(to);
    if (f === undefined || t === undefined) return undefined;
    const piece = this.pos.board.get(f);
    if (!piece) return undefined;
    if (piece.role !== "king") {
      // Like chess.js: a promotion piece only matters for a pawn reaching the last rank, where it defaults to a queen.
      const promoting = piece.role === "pawn" && (t >> 3 === 7 || t >> 3 === 0);
      const m: NormalMove = { from: f, to: t, promotion: promoting ? (CHAR_ROLE[promotion?.toLowerCase() ?? "q"] ?? "queen") : undefined };
      return this.pos.isLegal(m) ? m : undefined;
    }
    // A king: an exact destination first (a step, or king-onto-rook castling — already in engine form). Not
    // isLegal(), which quietly reads e1g1 as castling and would record it in the wrong notation.
    if (this.pos.dests(f).has(t)) return { from: f, to: t };
    // "Castle to g1": find the castling move that puts the king there.
    for (const s of ["a", "h"] as const) {
      const rook = this.pos.castles.rook[piece.color][s];
      if (rook === undefined) continue;
      const castle: NormalMove = { from: f, to: rook };
      const kingTo = parseSquare(`${s === "h" ? "g" : "c"}${piece.color === "white" ? "1" : "8"}`);
      if (kingTo === t && this.pos.isLegal(castle)) return castle;
    }
    return undefined;
  }

  move(input: string | { from: string; to: string; promotion?: string }): RulesMove {
    let m: OpsMove | undefined;
    if (typeof input === "string") {
      const t = input.trim();
      if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(t)) m = this.fromCoords(t.slice(0, 2).toLowerCase(), t.slice(2, 4).toLowerCase(), t[4]);
      else m = parseSan(this.pos, t.replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O"));
    } else m = this.fromCoords(input.from, input.to, input.promotion);
    if (!m || !("from" in m) || !this.pos.isLegal(m)) throw new Error(`Invalid move: ${typeof input === "string" ? input : JSON.stringify(input)}`);
    return this.play(m);
  }

  moves(): RulesMove[] {
    const out: RulesMove[] = [];
    for (const [from, dests] of this.pos.allDests()) {
      for (const to of dests) {
        const piece = this.pos.board.get(from)!;
        const promoting = piece.role === "pawn" && (to >> 3 === 7 || to >> 3 === 0);
        if (promoting) for (const p of ["queen", "rook", "bishop", "knight"] as Role[]) out.push(this.describe({ from, to, promotion: p }));
        else out.push(this.describe({ from, to }));
      }
    }
    return out;
  }
}

/** The rules for a position of a game in this variant. */
export const newRules = (fen: string, variant: Variant = "standard"): Rules => (variant === "chess960" ? new Chess960Rules(fen) : new StandardRules(fen));

/** A game's variant (old games have none: standard). */
export const variantOf = (g: { variant?: Variant } | null | undefined): Variant => g?.variant ?? "standard";
/** Every variant: each has its own ratings and leaderboard, so a Chess960 result never moves a standard rating. */
export const VARIANTS: Variant[] = ["standard", "chess960"];
export const VARIANT_NAME: Record<Variant, string> = { standard: "Standard", chess960: "Chess960" };
/** What a rating is called where it's shown: "Chess960 rating" for Chess960, plain "rating" otherwise. */
export const ratingName = (v: Variant) => (v === "chess960" ? "Chess960 rating" : "rating");

/**
 * A chess.js board for any position, for the helpers that inspect positions (material, attackers,
 * brilliancy checks, board drawing). Castling rights chess.js can't represent — a Chess960 rook or
 * king off its standard square — are dropped, which changes nothing those helpers look at.
 */
export function looseChess(fen: string): ChessJs {
  const parts = fen.split(" ");
  if (parts.length >= 3 && parts[2] !== "-") {
    const rows = parts[0].split("/");
    const at = (sq: string) => {
      const row = rows[8 - Number(sq[1])] ?? "";
      let file = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) file += Number(ch);
        else {
          if (file === sq.charCodeAt(0) - 97) return ch;
          file++;
        }
      }
      return "";
    };
    const keep: string[] = [];
    const ok = (king: string, ksq: string, rook: string, rsq: string) => at(ksq) === king && at(rsq) === rook;
    for (const ch of parts[2]) {
      if ((ch === "K" || ch === "H") && ok("K", "e1", "R", "h1")) keep.push("K");
      else if ((ch === "Q" || ch === "A") && ok("K", "e1", "R", "a1")) keep.push("Q");
      else if ((ch === "k" || ch === "h") && ok("k", "e8", "r", "h8")) keep.push("k");
      else if ((ch === "q" || ch === "a") && ok("k", "e8", "r", "a8")) keep.push("q");
    }
    const order = "KQkq";
    parts[2] = [...new Set(keep)].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join("") || "-";
  }
  return new ChessJs(parts.join(" "));
}

/* ------------------------------ Chess960 starting positions ------------------------------ */

/**
 * Starting position number n (0–959) in the standard Scharnagl numbering; 518 is the normal setup.
 * Castling rights are written as K/Q/k/q (X-FEN), which Stockfish and chessops both read.
 */
export function chess960Fen(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 959) throw new Error("Chess960 positions are numbered 0–959.");
  const rank: (string | null)[] = Array(8).fill(null);
  const free = () => rank.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  let x = n;
  rank[2 * (x % 4) + 1] = "B"; // light-squared bishop: b, d, f or h
  x = Math.floor(x / 4);
  rank[2 * (x % 4)] = "B"; // dark-squared bishop: a, c, e or g
  x = Math.floor(x / 4);
  rank[free()[x % 6]] = "Q";
  x = Math.floor(x / 6);
  const KNIGHTS = [
    [0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4],
  ][x];
  const f = free();
  rank[f[KNIGHTS[0]]] = "N";
  rank[f[KNIGHTS[1]]] = "N";
  const [r1, k, r2] = free();
  rank[r1] = "R";
  rank[k] = "K";
  rank[r2] = "R";
  const white = rank.join("");
  return `${white.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${white} w KQkq - 0 1`;
}

export const randomChess960 = () => Math.floor(Math.random() * 960);

/** Who castles where, in words, for agent briefings. */
export function castlingNote(startFen: string): string {
  const back = startFen.split("/")[7].split(" ")[0];
  const files = "abcdefgh";
  const k = back.indexOf("K");
  const rooks = [...back].map((p, i) => (p === "R" ? files[i] : "")).filter(Boolean);
  return `Starting setup: king on ${files[k]}1/${files[k]}8, rooks on the ${rooks.join(" and ")} files. O-O puts the king on g1 and the ${rooks[1]}-rook on f1; O-O-O puts the king on c1 and the ${rooks[0]}-rook on d1 (same files for Black on rank 8). Castling requires the corresponding castling right: neither the king nor that rook may have moved. Both paths to their destination squares, including the destinations, must be empty except for the participating king and rook. The king may not start in check, cross an attacked square, or end in check. The king or rook may already occupy its destination square.`;
}
