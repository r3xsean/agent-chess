/*
 * Brilliant and Great move detection.
 *
 * Adapted from WintrChess (https://github.com/WintrCat/wintrchess), files under
 * shared/src/lib/reporter/ (classification/brilliant.ts, classification/critical.ts,
 * utils/criticalMove.ts, utils/pieceSafety.ts, utils/dangerLevels.ts, utils/pieceTrapped.ts,
 * utils/attackers.ts, utils/defenders.ts, expectedPoints.ts).
 * Copyright (C) WintrCat. Licensed under the GNU General Public License v3.
 *
 * Modified for Agent Chess: ported to this project's Score type, lodash replaced with small
 * helpers, and a second-best move that still forces mate also counts as "winning anyway".
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE.
 */
import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import { looseChess } from "../shared/rules";
import type { Score } from "../shared/types";

const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: Infinity };

interface BoardPiece {
  square: Square;
  type: PieceSymbol;
  color: Color;
}
interface RawMove {
  piece: PieceSymbol;
  color: Color;
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
}
interface Evaluation {
  type: "centipawn" | "mate";
  value: number;
}

/** Everything the detectors need about one move. Scores are from White's point of view. */
export interface MoveContext {
  before: Chess;
  after: Chess;
  played: Move;
  /** Engine's best line in the position before the move. */
  bestBefore: Score;
  /** Engine's second-best line in the position before the move (missing when only one move was legal). */
  secondBefore?: Score;
  /** Engine's evaluation after the move. */
  evalAfter: Score;
}

/* ------------------------------ small helpers ------------------------------ */

const flip = (c: Color): Color => (c === "w" ? "b" : "w");

function setFenTurn(fen: string, color: Color) {
  const parts = fen.split(" ");
  if (parts[1] !== color) parts[3] = "-"; // en passant belongs to the old side to move
  parts[1] = color;
  return parts.join(" ");
}

function tryBoard(fen: string): Chess | null {
  try {
    return looseChess(fen);
  } catch {
    return null;
  }
}

const captureSquare = (m: Move): Square => (m.isEnPassant() ? ((m.to[0] + m.from[1]) as Square) : m.to);
const toRaw = (m: Move): RawMove => ({ piece: m.piece, color: m.color, from: m.from, to: m.to, promotion: m.promotion });
const rawToPiece = (m: RawMove): BoardPiece => ({ type: m.piece, color: m.color, square: m.from });
const sameRaw = (a: RawMove, b: RawMove) => a.piece === b.piece && a.color === b.color && a.from === b.from && a.to === b.to && a.promotion === b.promotion;
const boardPieces = (board: Chess) => board.board().flat().filter((p): p is BoardPiece => !!p);

function evaluation(s: Score): Evaluation {
  return s.mate !== undefined ? { type: "mate", value: s.mate } : { type: "centipawn", value: s.cp ?? 0 };
}
const subjective = (e: Evaluation, c: Color): Evaluation => ({ type: e.type, value: e.value * (c === "w" ? 1 : -1) });

/* ------------------------------ expected points ------------------------------ */

function expectedPoints(e: Evaluation, moveColour: Color) {
  if (e.type === "mate") return e.value === 0 ? Number(moveColour === "w") : Number(e.value > 0);
  return 1 / (1 + Math.exp(-0.0035 * e.value));
}

function expectedPointsLoss(previous: Evaluation, current: Evaluation, moveColour: Color) {
  return Math.max(0, (expectedPoints(previous, flip(moveColour)) - expectedPoints(current, moveColour)) * (moveColour === "w" ? 1 : -1));
}

/* ------------------------------ attackers & defenders ------------------------------ */

function directAttackingMoves(board: Chess, piece: BoardPiece): RawMove[] {
  // Set the turn to the attacker's side (the opposite of the piece).
  const attackerBoard = tryBoard(setFenTurn(board.fen(), flip(piece.color)));
  if (!attackerBoard) return [];
  const moves = attackerBoard
    .moves({ verbose: true })
    .filter((m) => captureSquare(m) === piece.square)
    .map(toRaw);
  const kingSquare = attackerBoard.attackers(piece.square).find((sq) => attackerBoard.get(sq)?.type === "k");
  if (kingSquare && !moves.some((m) => m.piece === "k")) moves.push({ piece: "k", color: flip(piece.color), from: kingSquare, to: piece.square });
  return moves;
}

/** Attacking moves on a piece; transitive includes pieces lined up behind the front attacker (batteries). */
function attackingMoves(board: Chess, piece: BoardPiece, transitive = true): RawMove[] {
  const attacks = directAttackingMoves(board, piece);
  if (!transitive) return attacks;
  const frontier = attacks.map((a) => ({ fen: board.fen(), square: a.from, type: a.piece }));
  while (frontier.length) {
    const front = frontier.pop()!;
    if (front.type === "k") continue; // a king can't lead a battery
    const b = tryBoard(front.fen);
    if (!b) continue;
    const oldAttacks = directAttackingMoves(b, piece).filter((a) => a.from !== front.square);
    b.remove(front.square);
    const newAttacks = directAttackingMoves(b, piece);
    // Revealed attackers: symmetric difference of the old (front piece excluded) and new lists.
    const revealed = [...oldAttacks.filter((a) => !newAttacks.some((n) => sameRaw(a, n))), ...newAttacks.filter((n) => !oldAttacks.some((a) => sameRaw(a, n)))];
    attacks.push(...revealed);
    frontier.push(...revealed.map((a) => ({ fen: b.fen(), square: a.from, type: a.piece })));
  }
  return attacks;
}

function defendingMoves(board: Chess, piece: BoardPiece, transitive = true): RawMove[] {
  // Where there are attackers, simulate each capture and take the smallest set of recapturers.
  let smallest: RawMove[] | undefined;
  for (const attack of attackingMoves(board, piece, false)) {
    const b = tryBoard(setFenTurn(board.fen(), flip(piece.color)));
    if (!b) continue;
    try {
      b.move(attack);
    } catch {
      continue;
    }
    const recapturers = attackingMoves(b, { type: attack.piece, color: attack.color, square: attack.to }, transitive);
    if (!smallest || recapturers.length < smallest.length) smallest = recapturers;
  }
  if (smallest) return smallest;
  // No attackers: flip the piece's colour and count who would attack it.
  const b = new Chess(board.fen());
  const flipped: BoardPiece = { ...piece, color: flip(piece.color) };
  b.put({ type: flipped.type, color: flipped.color }, piece.square);
  return attackingMoves(b, flipped, transitive);
}

/* ------------------------------ piece safety ------------------------------ */

export function isPieceSafe(board: Chess, piece: BoardPiece, playedMove?: Move): boolean {
  const directAttackers = attackingMoves(board, piece, false).map(rawToPiece);
  const attackers = attackingMoves(board, piece).map(rawToPiece);
  const defenders = defendingMoves(board, piece).map(rawToPiece);

  // Favourable "decimal" sacrifices (a rook for two minor pieces, etc.) are safe.
  if (
    playedMove?.captured &&
    piece.type === "r" &&
    VALUE[playedMove.captured] === VALUE.n &&
    attackers.length === 1 &&
    defenders.length > 0 &&
    VALUE[attackers[0].type] === VALUE.n
  )
    return true;

  // A piece with a direct attacker of lower value isn't safe.
  if (directAttackers.some((a) => VALUE[a.type] < VALUE[piece.type])) return false;

  // A piece without more attackers than defenders is safe.
  if (attackers.length <= defenders.length) return true;

  // A piece worth less than every direct attacker, with a defender worth less than all of them, is safe.
  const lowest = directAttackers.reduce<BoardPiece | undefined>((m, a) => (!m || VALUE[a.type] < VALUE[m.type] ? a : m), undefined);
  if (!lowest) return true;
  if (VALUE[piece.type] < VALUE[lowest.type] && defenders.some((d) => VALUE[d.type] < VALUE[lowest.type])) return true;

  // A piece defended by a pawn, at this point, is safe.
  return defenders.some((d) => d.type === "p");
}

function unsafePieces(board: Chess, colour: Color, playedMove?: Move): BoardPiece[] {
  const capturedValue = playedMove?.captured ? VALUE[playedMove.captured] : 0;
  return boardPieces(board).filter(
    (p) => p.color === colour && p.type !== "p" && p.type !== "k" && VALUE[p.type] > capturedValue && !isPieceSafe(board, p, playedMove),
  );
}

/* ------------------------------ danger levels ------------------------------ */

/** Attacks on the given colour's unsafe pieces worth at least as much as the threatened piece. */
function relativeUnsafePieceAttacks(board: Chess, threatened: BoardPiece, colour: Color, playedMove?: Move): RawMove[] {
  return unsafePieces(board, colour, playedMove)
    .filter((p) => p.square !== threatened.square && VALUE[p.type] >= VALUE[threatened.type])
    .flatMap((p) => attackingMoves(board, p, false));
}

const allowsMate = (board: Chess) => board.moves().some((san) => san.includes("#"));

/** Does acting on the threatened piece create a counter-threat bigger than the threat on it? */
function moveCreatesGreaterThreat(board: Chess, threatened: BoardPiece, acting: RawMove): boolean {
  const b = new Chess(board.fen());
  const previous = relativeUnsafePieceAttacks(b, threatened, acting.color);
  let baked: Move;
  try {
    baked = b.move(acting);
  } catch {
    return false;
  }
  const now = relativeUnsafePieceAttacks(b, threatened, acting.color, baked);
  if (now.some((a) => !previous.some((p) => sameRaw(a, p)))) return true;
  // A lower-value sacrifice that, if taken, allows mate.
  return VALUE[threatened.type] < VALUE.q && allowsMate(b);
}

/** After acting on the threatened piece, is a counter-threat at least as big left on the board? */
function moveLeavesGreaterThreat(board: Chess, threatened: BoardPiece, acting: RawMove): boolean {
  const b = new Chess(board.fen());
  try {
    b.move(acting);
  } catch {
    return false;
  }
  if (relativeUnsafePieceAttacks(b, threatened, acting.color).length > 0) return true;
  return VALUE[threatened.type] < VALUE.q && allowsMate(b);
}

function hasDangerLevels(board: Chess, threatened: BoardPiece, actingMoves: RawMove[], strategy: "creates" | "leaves" = "leaves") {
  return actingMoves.every((m) => (strategy === "creates" ? moveCreatesGreaterThreat(board, threatened, m) : moveLeavesGreaterThreat(board, threatened, m)));
}

/** A piece is trapped if it's unsafe where it stands and on every square it can move to. */
function isPieceTrapped(board: Chess, piece: BoardPiece, dangerLevels = true): boolean {
  const calibrated = tryBoard(setFenTurn(board.fen(), piece.color));
  if (!calibrated) return false;
  const standingSafe = isPieceSafe(calibrated, piece);
  const allMovesUnsafe = calibrated.moves({ square: piece.square, verbose: true }).every((m) => {
    if (m.captured === "k") return false;
    const escape = new Chess(calibrated.fen());
    if (dangerLevels && moveCreatesGreaterThreat(escape, piece, toRaw(m))) return true;
    const moved = escape.move(m);
    return !isPieceSafe(escape, { ...piece, square: moved.to }, moved);
  });
  return !standingSafe && allMovesUnsafe;
}

/* ------------------------------ classifications ------------------------------ */

/**
 * Could this move be critical to keeping an advantage? Easy-to-find or forced moves can't be.
 * Also the preliminary check for Great and Brilliant.
 */
function isCriticalCandidate(ctx: MoveContext): boolean {
  const mover = ctx.played.color;
  const after = subjective(evaluation(ctx.evalAfter), mover);
  // Still completely winning even without this move?
  if (ctx.secondBefore) {
    const second = subjective(evaluation(ctx.secondBefore), mover);
    if ((second.type === "centipawn" && second.value >= 700) || (second.type === "mate" && second.value > 0)) return false;
  } else if (after.type === "centipawn" && after.value >= 700) return false;
  // Moves in losing positions can't be critical.
  if (after.value < 0) return false;
  if (ctx.played.promotion === "q") return false;
  // Moves that must be played anyway to escape check.
  if (ctx.before.isCheck()) return false;
  return true;
}

/** Great: the only move that keeps the advantage (the second-best loses at least 0.10 expected points). */
export function isGreatMove(ctx: MoveContext): boolean {
  if (!isCriticalCandidate(ctx)) return false;
  const mover = ctx.played.color;
  const after = subjective(evaluation(ctx.evalAfter), mover);
  // Finding a forced mate isn't critical.
  if (after.type === "mate" && after.value > 0) return false;
  // Taking free material isn't critical.
  if (ctx.played.captured) {
    const victim: BoardPiece = { color: flip(mover), square: captureSquare(ctx.played), type: ctx.played.captured };
    if (!isPieceSafe(ctx.before, victim)) return false;
  }
  if (!ctx.secondBefore) return false;
  return expectedPointsLoss(evaluation(ctx.bestBefore), evaluation(ctx.secondBefore), mover) >= 0.1;
}

/** Brilliant: a sound piece sacrifice — something is left en prise and taking it doesn't simply win material back. */
export function isBrilliantMove(ctx: MoveContext): boolean {
  if (!isCriticalCandidate(ctx)) return false;
  if (ctx.played.promotion) return false;
  const mover = ctx.played.color;
  const previousUnsafe = unsafePieces(ctx.before, mover);
  const unsafe = unsafePieces(ctx.after, mover, ctx.played);

  // Moving a piece to safety (fewer unsafe pieces than before) isn't brilliant.
  if (!ctx.after.isCheck() && unsafe.length < previousUnsafe.length) return false;

  // Taking any of the unsafe pieces gives an equal or bigger counter-threat: not a real sacrifice.
  if (unsafe.every((p) => hasDangerLevels(ctx.after, p, attackingMoves(ctx.after, p, false)))) return false;

  // Giving up pieces that were lost anyway (trapped) doesn't count.
  const previousTrapped = previousUnsafe.filter((p) => isPieceTrapped(ctx.before, p));
  const trapped = unsafe.filter((p) => isPieceTrapped(ctx.after, p));
  const movedPieceTrapped = previousTrapped.some((p) => p.square === ctx.played.from);
  if (trapped.length === unsafe.length || movedPieceTrapped || trapped.length < previousTrapped.length) return false;

  return unsafe.length > 0;
}
