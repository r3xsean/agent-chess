import type { Color, Game, PlayerRef } from "./types";
import { makerOf } from "./models";

/*
 * The model is the player, and running text calls it by its model.
 * A human player is just their name (stored as modelLabel, with provider "human").
 */

export const isHuman = (p: Pick<PlayerRef, "provider">) => p.provider === "human";

/** The side a human plays in this game, if any. */
export function humanSide(g: Pick<Game, "white" | "black">): Color | null {
  return isHuman(g.white) ? "w" : isHuman(g.black) ? "b" : null;
}

/** The model's name, or a human's. */
export const fullName = (p: PlayerRef) => p.modelLabel;

/**
 * Colours that tell the two sides' self-eval lines apart: the maker's colour (Claude vs OpenAI vs human),
 * or when both share it, a fixed contrasting pair.
 */
export function selfEvalColors(g: Pick<Game, "white" | "black">): Record<Color, string> {
  const maker = { w: makerOf(g.white.provider).color, b: makerOf(g.black.provider).color };
  return maker.w !== maker.b ? maker : { w: "#5fb6ff", b: "#ff9f43" };
}

/** What to call one side in running text: its model; when both sides are the same model, the model and its effort. */
export function sideName(g: Pick<Game, "white" | "black">, c: Color): string {
  const mine = baseSideName(g, c);
  // Still the same (e.g. a human who named themselves after the model they're playing): say which side.
  return mine === baseSideName(g, c === "w" ? "b" : "w") ? `${mine} (${c === "w" ? "White" : "Black"})` : mine;
}

function baseSideName(g: Pick<Game, "white" | "black">, c: Color): string {
  const me = c === "w" ? g.white : g.black;
  const opp = c === "w" ? g.black : g.white;
  if (isHuman(me) || me.modelLabel !== opp.modelLabel) return me.modelLabel;
  return `${me.modelLabel} (${me.effort})`;
}
