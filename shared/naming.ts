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

/** "Opus 5.5 as The Magician", plain "Opus 5.5" with no personality, or a human's name. */
export const fullName = (p: PlayerRef) => {
  const persona = personalityById(p.personality);
  return isHuman(p) || persona.plain ? p.modelLabel : `${p.modelLabel} as ${persona.name}`;
};

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

/**
 * What to call one side in running text: its model; when both sides are the same model, its personality
 * (a model with no personality keeps its model name); when even that matches, the model and its effort.
 */
export function sideName(g: Pick<Game, "white" | "black">, c: Color): string {
  const mine = baseSideName(g, c);
  // Still the same (e.g. a human who named themselves after the model they're playing): say which side.
  return mine === baseSideName(g, c === "w" ? "b" : "w") ? `${mine} (${c === "w" ? "White" : "Black"})` : mine;
}

function baseSideName(g: Pick<Game, "white" | "black">, c: Color): string {
  const me = c === "w" ? g.white : g.black;
  const opp = c === "w" ? g.black : g.white;
  if (isHuman(me) || me.modelLabel !== opp.modelLabel) return me.modelLabel;
  if (me.personality === opp.personality) return `${me.modelLabel} (${me.effort})`;
  const persona = personalityById(me.personality);
  return persona.plain ? me.modelLabel : persona.name;
}
