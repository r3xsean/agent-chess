import { Chess, type Move } from "chess.js";
import type { Classification, Color, Game, MoveAnalysis, MoveRecord, PositionAnalysis, Score, SideReview } from "../shared/types";
import { moveAccuracy, scoreToCp, scoreToPawns, winPercentFor, winPercentWhite } from "../shared/evalmath";
import { isTheory } from "./openings";

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Score for a position that is already over (no engine call needed). */
export function terminalScore(fen: string): Score | null {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { mate: 0, cp: c.turn() === "w" ? -10000 : 10000 };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { cp: 0 };
  return null;
}

/**
 * True when the move leaves material en prise: after it, the opponent can capture a
 * non-pawn piece and come out at least two points ahead (net of anything we just took).
 */
export function isSacrifice(fenBefore: string, uci: string): boolean {
  const c = new Chess(fenBefore);
  let mv: Move;
  try {
    mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch {
    return false;
  }
  if (c.isCheckmate()) return false;
  const me = mv.color;
  const gained = mv.captured ? VALUE[mv.captured] : 0;
  let worst = 0;
  for (const om of c.moves({ verbose: true })) {
    if (!om.captured || om.captured === "p") continue;
    const victim = VALUE[om.captured];
    const after = new Chess(c.fen());
    after.move(om);
    // Defended = we have a *legal* recapture (a pinned piece doesn't count).
    const defended = after.turn() === me && after.moves({ verbose: true }).some((r) => r.to === om.to);
    const loss = defended ? victim - (om.piece === "k" ? 0 : VALUE[om.piece]) : victim;
    worst = Math.max(worst, loss);
  }
  return worst - gained >= 2;
}

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
): MoveAnalysis {
  const mover = m.color;
  const playedBest = before.bestUci === m.uci;
  const winBefore = winPercentFor(before.score, mover);
  const winAfterRaw = winPercentFor(afterScore, mover);
  const drop = playedBest ? 0 : Math.max(0, winBefore - winAfterRaw);
  const cpLoss = playedBest ? 0 : Math.max(0, moverCp(before.score, mover) - moverCp(afterScore, mover));
  const accuracy = moveAccuracy(winBefore, winBefore - drop);

  const legalCount = new Chess(m.fenBefore).moves().length;
  let classification: Classification;

  if (legalCount === 1) {
    classification = "forced";
  } else if (allBookSoFar && isTheory(m.fenAfter)) {
    classification = "book";
  } else if (drop <= 2) {
    const secondWin = before.second ? winPercentFor(before.second, mover) : null;
    const isRecapture = !!prev && prev.to === m.to && prev.san.includes("x") && m.san.includes("x");
    if (winBefore < 97 && winAfterRaw > 40 && isSacrifice(m.fenBefore, m.uci)) {
      classification = "brilliant";
    } else if (
      playedBest &&
      !isRecapture &&
      secondWin !== null &&
      winBefore - secondWin >= 12 &&
      winBefore < 97 &&
      winAfterRaw > 30
    ) {
      classification = "great";
    } else {
      classification = playedBest ? "best" : "excellent";
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
