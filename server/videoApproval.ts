import { createHash } from "node:crypto";
import type { Game } from "../shared/types";

/** Approve the exact plan: any later edit invalidates approval without relying on every writer to clear it. */
export const videoRevision = (g: Game) => g.video ? createHash("sha256").update(JSON.stringify(g.video)).digest("hex") : "";
export const videoApproved = (g: Game) => !!g.video && g.videoApproval?.revision === videoRevision(g);
