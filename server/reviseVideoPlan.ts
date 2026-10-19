import type { Game, VideoPlan } from "../shared/types";
import { ActionError } from "./game";
import { validatePlan } from "./director";

export function reviseVideoPlan(g: Game, raw: any): VideoPlan {
  const base = g.video;
  if (!base) throw new ActionError("Create a plan with direct first.");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ActionError("revise needs a JSON object.");
  const allowed = ["moments", "removeMoments", "asides", "hook", "interviewLines", "interviewDelivery", "quiet"];
  if (Object.keys(raw).some(k => !allowed.includes(k))) throw new ActionError(`revise accepts: ${allowed.join(", ")}.`);
  if (raw.moments !== undefined && !Array.isArray(raw.moments)) throw new ActionError("moments must be a list.");
  if (raw.removeMoments !== undefined && !Array.isArray(raw.removeMoments)) throw new ActionError("removeMoments must be a list of plies.");
  const remove = new Set(raw.removeMoments ?? []);
  for (const ply of remove) if (!base.moments.some(m => m.ply === ply)) throw new ActionError(`No moment at ply ${ply}.`);
  const moments = base.moments.filter(m => !remove.has(m.ply));
  const seen = new Set<number>();
  for (const update of raw.moments ?? []) {
    if (!update || seen.has(update.ply) || remove.has(update.ply)) throw new ActionError("Each revised ply must appear only once and cannot also be removed.");
    seen.add(update.ply);
    if (update.line?.beats !== undefined) throw new ActionError("Hand narration changes to request-narration.");
    const i = moments.findIndex(m => m.ply === update.ply);
    if (i < 0) moments.push(update);
    else moments[i] = { ...moments[i], ...update };
  }
  const { removeMoments: _, ...patch } = raw;
  return { ...base, ...validatePlan(g, { ...base, ...patch, moments }, base) };
}

