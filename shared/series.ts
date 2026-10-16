import type { Color, Rivalry } from "./types";

/** "Astra leads the series 3–1, with 1 draw" (by this game's names for the two sides); "" before a first meeting. */
export function seriesLine(score: Rivalry["before"], name: (c: Color) => string): string {
  const played = score.w + score.b + score.draws;
  if (!played) return "";
  const draws = score.draws ? `, with ${score.draws} draw${score.draws > 1 ? "s" : ""}` : "";
  if (score.w === score.b) return `The series is level at ${score.w}–${score.b}${draws}`;
  const lead: Color = score.w > score.b ? "w" : "b";
  const trail: Color = lead === "w" ? "b" : "w";
  return `${name(lead)} leads the series ${score[lead]}–${score[trail]}${draws}`;
}
