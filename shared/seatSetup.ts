import type { Color, Game, SeatSetup, Tournament } from "./types";

/*
 * How a player is shown the board: an experiment's toggles, set per seat when the game is made. "text" is the
 * briefing as always (FEN, piece list, diagram); "added" also gives a picture of the board each turn; "image"
 * gives only the picture. `reread`: every move must come with the player's own list of every piece and its
 * square, checked against the board before the move is.
 */

export const NORMAL_SETUP: SeatSetup = { view: "text", reread: false };

export const BOARD_VIEWS = ["text", "added", "image"] as const;

export const seatSetup = (g: Pick<Game, "options">, c: Color): SeatSetup => g.options?.seats?.[c] ?? NORMAL_SETUP;

export const isNormalSetup = (s: SeatSetup) => s.view === "text" && !s.reread;

/** A game where either seat plays under an experiment's toggles. */
export const isExperiment = (g: Pick<Game, "options">) => !isNormalSetup(seatSetup(g, "w")) || !isNormalSetup(seatSetup(g, "b"));

const VIEW_LABEL: Record<SeatSetup["view"], string> = { text: "Text", added: "Text + image", image: "Image only" };

/** "Text + image + re-read", "Text": the name of a toggle combination, everywhere it's shown. */
export const setupLabel = (s: SeatSetup) => `${VIEW_LABEL[s.view]}${s.reread ? " + re-read" : ""}`;

/** A stable key per combination, for grouping. */
export const setupKey = (s: SeatSetup) => `${s.view}${s.reread ? "+reread" : ""}`;

/** Each colour's toggles in a tournament pairing: everyone's, or in a split, `a` on the pairing's `aSide` and `b` on the other. */
export function pairingSetups(t: Pick<Tournament, "setups">, p: Tournament["pairings"][number]): Record<Color, SeatSetup> | undefined {
  if (!t.setups) return undefined;
  const { a, b } = t.setups;
  if (!b) return { w: a, b: a };
  return (p.aSide ?? "w") === "w" ? { w: a, b } : { w: b, b: a };
}

/** A setup sent by the website, or the normal one for anything else. */
export function parseSetup(v: unknown): SeatSetup {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const view = BOARD_VIEWS.includes(o.view as never) ? (o.view as SeatSetup["view"]) : "text";
  return { view, reread: o.reread === true };
}
