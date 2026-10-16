import type { Move } from "chess.js";
import type { Classification, Color, Game, MoveAnalysis, MoveRecord, PositionAnalysis, Score, SideReview } from "../shared/types";
import { moveAccuracy, scoreToCp, scoreToPawns, winPercentFor, winPercentWhite } from "../shared/evalmath";
import { isTheory } from "./openings";
import { isBrilliantMove, isGreatMove, type MoveContext } from "./wintr";
import { looseChess, newRules, type Variant } from "../shared/rules";

/** Score for a position that is already over (no engine call needed). */
export function terminalScore(fen: string): Score | null {
  const c = looseChess(fen);
  if (c.isCheckmate()) return { mate: 0, cp: c.turn() === "w" ? -10000 : 10000 };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { cp: 0 };
  return null;
}

/** Bump when classification rules change: stored games are re-classified at startup. */
export const CLASSIFIER_VERSION = 2;

const moverCp = (s: Score, color: Color) => {
  const cp = Math.max(-1000, Math.min(1000, scoreToCp(s)));
  return color === "w" ? cp : -cp;
};

export function classifyMove(
  m: MoveRecord,
  before: PositionAnalysis,
  afterScore: Score,
  prev: MoveRecord | undefined,
  allBookSoFar: boolean,
  variant: Variant = "standard",
): MoveAnalysis {
  const mover = m.color;
  const playedBest = before.bestUci === m.uci;
  const winBefore = winPercentFor(before.score, mover);
  const winAfterRaw = winPercentFor(afterScore, mover);
  const drop = playedBest ? 0 : Math.max(0, winBefore - winAfterRaw);
  const cpLoss = playedBest ? 0 : Math.max(0, moverCp(before.score, mover) - moverCp(afterScore, mover));
  const accuracy = moveAccuracy(winBefore, winBefore - drop);

  const legalCount = newRules(m.fenBefore, variant).moves().length;
  let classification: Classification;

  // The brilliancy checks inspect the position with chess.js. A Chess960 castle can't be replayed there,
  // and is never a sacrifice anyway, so it simply skips them.
  const board = looseChess(m.fenBefore);
  let played: Move | null = null;
  try {
    played = board.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
    if (board.fen().split(" ")[0] !== m.fenAfter.split(" ")[0]) played = null;
  } catch {}

  if (legalCount === 1) {
    classification = "forced";
  } else if (variant === "standard" && allBookSoFar && isTheory(m.fenAfter)) {
    classification = "book";
  } else if (played && board.isCheckmate()) {
    classification = "best"; // delivering mate is simply best
  } else if (drop <= 2) {
    classification = playedBest ? "best" : "excellent";
    // Great and Brilliant follow WintrChess's rules (see wintr.ts).
    if (played) {
      const ctx: MoveContext = { before: looseChess(m.fenBefore), after: board, played, bestBefore: before.score, secondBefore: before.second, evalAfter: afterScore };
      if (playedBest && isGreatMove(ctx)) classification = "great";
      if ((playedBest || drop < 1) && isBrilliantMove(ctx)) classification = "brilliant";
    }
  } else {
    const prevDrop = prev?.analysis && !prev.analysis.unavailable ? prev.analysis.winBefore - prev.analysis.winAfter : 0;
    if (drop > 10 && prevDrop >= 10 && winAfterRaw >= 30) classification = "miss";
    else if (drop > 20) classification = "blunder";
    else if (drop > 10) classification = "mistake";
    else if (drop > 5) classification = "inaccuracy";
    else classification = "good";
  }

  return {
    classification,
    winBefore,
    winAfter: winBefore - drop,
    accuracy,
    cpLoss,
    bestSan: before.bestSan,
    bestUci: before.bestUci,
    evalAfter: afterScore,
  };
}

/** Lichess-style game accuracy: mean of volatility-weighted mean and harmonic mean. */
function gameAccuracy(game: Game, color: Color): number | null {
  const wins = [winPercentWhite(game.analysis[game.moves[0]?.fenBefore]?.score ?? { cp: 20 })];
  for (const m of game.moves) wins.push(m.analysis && !m.analysis.unavailable ? (m.color === "w" ? m.analysis.winAfter : 100 - m.analysis.winAfter) : wins[wins.length - 1]);
  const windowSize = Math.max(2, Math.min(8, Math.floor(game.moves.length / 10)));
  const weights: number[] = [];
  for (let i = 0; i < game.moves.length; i++) {
    const start = Math.max(0, Math.min(i, wins.length - windowSize));
    const w = wins.slice(start, start + windowSize);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length);
    weights.push(Math.max(0.5, Math.min(12, sd)));
  }
  let wsum = 0;
  let wacc = 0;
  const accs: number[] = [];
  game.moves.forEach((m, i) => {
    if (m.color !== color || !m.analysis || m.analysis.unavailable) return;
    wsum += weights[i];
    wacc += weights[i] * m.analysis.accuracy;
    accs.push(Math.max(m.analysis.accuracy, 0.5));
  });
  if (!accs.length) return null;
  const weighted = wacc / wsum;
  const harmonic = accs.length / accs.reduce((a, b) => a + 1 / b, 0);
  return Math.round(((weighted + harmonic) / 2) * 10) / 10;
}

export function reviewSide(game: Game, color: Color): SideReview {
  const mine = game.moves.filter((m) => m.color === color && m.analysis && !m.analysis.unavailable);
  const counts: SideReview["counts"] = {};
  for (const m of mine) counts[m.analysis!.classification] = (counts[m.analysis!.classification] ?? 0) + 1;
  const scored = mine.filter((m) => m.analysis!.classification !== "book");
  const acpl = scored.length ? scored.reduce((a, m) => a + Math.min(m.analysis!.cpLoss, 1000), 0) / scored.length : 0;
  const estElo = scored.length ? Math.round(Math.max(100, Math.min(3200, 3100 * Math.exp(-0.01 * acpl))) / 25) * 25 : null;
  const withSelf = mine.filter((m) => m.selfEval !== null);
  const selfEvalError = withSelf.length
    ? Math.round((withSelf.reduce((a, m) => a + Math.abs(Math.max(-10, Math.min(10, m.selfEval!)) - scoreToPawns(m.analysis!.evalAfter)), 0) / withSelf.length) * 100) / 100
    : null;
  return { accuracy: gameAccuracy(game, color), estElo, counts, selfEvalError };
}
