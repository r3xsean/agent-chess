import type { Color, Game, PlayerRef } from "./types";
import { personalityById } from "./personalities";

/*
 * The model is the player; the personality is the style it plays in. So a player is
 * "Opus 5.5 as The Magician", and running text calls it by its model.
 */

/** "Opus 5.5 as The Magician". */
export const fullName = (p: PlayerRef) => `${p.modelLabel} as ${personalityById(p.personality).name}`;

/** What to call one side in running text: its model, or its personality when both sides are the same model. */
export function sideName(g: Pick<Game, "white" | "black">, c: Color): string {
  const me = c === "w" ? g.white : g.black;
  const opp = c === "w" ? g.black : g.white;
  return me.modelLabel === opp.modelLabel ? personalityById(me.personality).name : me.modelLabel;
}
