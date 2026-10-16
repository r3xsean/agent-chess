import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = process.env.AGENT_CHESS_DATA ?? path.join(ROOT, "data");
export const PORT = Number(process.env.PORT ?? 5170);
export const CLI = path.join(ROOT, "cli", "chess.mjs");

/** The read-only public site: shows games pushed from the local server, takes viewers' predictions, plays nothing. */
export const PUBLIC_MODE = process.env.PUBLIC_MODE === "1";
