import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = path.join(ROOT, "data");
/** One spelling per file, so `\\?\C:\…`, short names, junctions and case all compare equal. */
const canon = (p: string) => {
  let r = path.resolve(p.replace(/^\\\\\?\\(?!UNC\\)/i, ""));
  try {
    r = realpathSync.native(r);
  } catch {}
  return process.platform === "win32" ? r.toLowerCase() : r;
};
const same = (a: string, b: string) => canon(a) === canon(b);
// The live games and ratings are the server's (and the research tools', which read them). Anything else that
// loads server code (a test, a snippet trying something out) gets an empty temp data dir unless it names one,
// and a test can't name the live one.
const entry = process.argv[1] ?? "";
const live = !!entry && (same(entry, path.join(ROOT, "server", "index.ts")) || same(path.dirname(canon(entry)), path.join(ROOT, "research", "tools")));
const test = !!entry && same(path.dirname(canon(entry)), path.join(ROOT, "scripts")) && /^(test-|smoke)/i.test(path.basename(entry));
if (test && process.env.AGENT_CHESS_DATA && same(process.env.AGENT_CHESS_DATA, LIVE)) throw new Error(`A test can't use the live data dir (${LIVE}).`);
const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-chess-test-"));
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
};
export const DATA = process.env.AGENT_CHESS_DATA ?? (live ? LIVE : scratch());
export const PORT = Number(process.env.PORT ?? 5170);
export const CLI = path.join(ROOT, "cli", "chess.mjs");

/** The read-only public site: shows games pushed from the local server, takes viewers' predictions, plays nothing. */
export const PUBLIC_MODE = process.env.PUBLIC_MODE === "1";
