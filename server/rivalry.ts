import type { Color, Game, Rivalry } from "../shared/types";
import { games } from "./store";

/*
 * The series between two models, whatever personality or effort they played in: viewers follow
 * "Sonnet vs Astra", not one persona against another. Counted from the games that finished before
 * this one started, plus (once it's over) this game itself.
 */

const other = (c: Color): Color => (c === "w" ? "b" : "w");

/** Which of this game's colours won game x (by model), or null for a draw; undefined if x isn't between them. */
function winnerIn(g: Game, x: Game): Color | null | undefined {
  const wModel = g.white.model;
  const bModel = g.black.model;
  const sameSides = x.white.model === wModel && x.black.model === bModel;
  const swapped = x.white.model === bModel && x.black.model === wModel;
  if (!sameSides && !swapped) return undefined;
  if (x.result === "1/2-1/2") return null;
  const xWinner: Color = x.result === "1-0" ? "w" : "b";
  return sameSides ? xWinner : other(xWinner);
}

export function rivalry(g: Game): Rivalry | null {
  // A mirror match has no series to speak of; and every human shares the model "human", so a series
  // counted by model would lump different people together.
  if (g.white.model === g.black.model || g.white.provider === "human" || g.black.provider === "human") return null;
  const earlier = [...games.values()]
    .filter((x) => x.id !== g.id && x.result && x.endedAt && x.endedAt < g.createdAt)
    .sort((a, b) => a.endedAt! - b.endedAt!);
  const before = { w: 0, b: 0, draws: 0 };
  let last: Rivalry["last"];
  for (const x of earlier) {
    const win = winnerIn(g, x);
    if (win === undefined) continue;
    if (win === null) before.draws++;
    else before[win]++;
    // The replay's headline, when the director planned one; else how it ended.
    const headline = x.video?.hook?.caption ?? x.video?.moments.find((m) => m.importance === 3)?.why;
    // "White resigned" means nothing once colours have swapped between games: name the model instead.
    const termination = (x.termination ?? "").replace(/\b(White|Black)\b/, (side) => (side === "White" ? x.white.modelLabel : x.black.modelLabel));
    last = { gameId: x.id, endedAt: x.endedAt!, winner: win, termination, headline };
  }
  const after = { ...before };
  if (g.result) {
    const win = winnerIn(g, g);
    if (win === null) after.draws++;
    else if (win) after[win]++;
  }
  return { before, after, last };
}

export { seriesLine } from "../shared/series";
