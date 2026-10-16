import type { Color, Game, PlayerRef } from "./types";
import { personalityById } from "./personalities";
import { makerOf } from "./models";

/*
 * The model is the player; the personality is the style it plays in. So a player is
 * "Opus 5.5 as The Magician", and running text calls it by its model.
 * A human player is just their name (stored as modelLabel, with provider "human").
 */

export const isHuman = (p: Pick<PlayerRef, "provider">) => p.provider === "human";

/** The side a human plays in this game, if any. */
export function humanSide(g: Pick<Game, "white" | "black">): Color | null {
  return isHuman(g.white) ? "w" : isHuman(g.black) ? "b" : null;
}

/** "Opus 5.5 as The Magician" (or a human's name). */
export const fullName = (p: PlayerRef) => (isHuman(p) ? p.modelLabel : `${p.modelLabel} as ${personalityById(p.personality).name}`);

/**
 * Colours that tell the two sides' self-eval lines apart: the maker's colour (Claude vs OpenAI vs human),
 * or when both share it, the personality's colour, or failing that a fixed contrasting pair.
 */
export function selfEvalColors(g: Pick<Game, "white" | "black">): Record<Color, string> {
  const maker = { w: makerOf(g.white.provider).color, b: makerOf(g.black.provider).color };
  if (maker.w !== maker.b) return maker;
  const persona = { w: personalityById(g.white.personality).color, b: personalityById(g.black.personality).color };
  if (persona.w !== persona.b) return persona;
  return { w: "#5fb6ff", b: "#ff9f43" };
}

/** What to call one side in running text: its model, or its personality when both sides are the same model. */
export function sideName(g: Pick<Game, "white" | "black">, c: Color): string {
  const me = c === "w" ? g.white : g.black;
  const opp = c === "w" ? g.black : g.white;
  if (isHuman(me)) return me.modelLabel;
  return me.modelLabel === opp.modelLabel ? personalityById(me.personality).name : me.modelLabel;
}
