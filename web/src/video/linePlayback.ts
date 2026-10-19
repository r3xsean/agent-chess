import type { ShownLine } from "../../../shared/engineLine";
import type { RulesMove } from "../../../shared/rules";
import type { MoveRecord } from "../../../shared/types";
import type { Scene } from "./timeline";

/** Reverse the original forward animation, including captures, en passant and castling. */
export function rewindFrame(moves: RulesMove[], range: [number, number], t: number) {
  const done = Math.max(0, (t - range[0]) / (range[1] - range[0])) * moves.length;
  const count = Math.max(0, moves.length - Math.floor(done));
  const move = moves[count - 1];
  return { count, move, progress: move ? 1 - (done - Math.floor(done)) : 0 };
}

/** Deterministic transition frames, shared by preview and frame-by-frame export. */
export function lineTransition(s: Extract<Scene, { kind: "line" }>, m: MoveRecord, line: ShownLine, t: number) {
  if (t < s.enterAt) return { phase: "hold" as const, fen: s.first ? m.fenBefore : m.fenAfter, count: 0 };
  if (!s.punish && t < s.readyAt) {
    return { phase: "enter" as const, fen: m.fenAfter, move: m, progress: 1 - (t - s.enterAt) / (s.readyAt - s.enterAt), count: 0 };
  }
  if (t < s.back[0]) return undefined;
  if (t < s.back[1]) {
    const frame = rewindFrame(line.moves, s.back, t);
    return { phase: "rewind" as const, fen: frame.move?.after ?? line.fen, ...frame };
  }
  if (t < s.restoreEnd) {
    return { phase: "restore" as const, fen: m.fenAfter, move: m, progress: (t - s.back[1]) / (s.restoreEnd - s.back[1]), count: 0 };
  }
  return { phase: "done" as const, fen: s.first ? m.fenBefore : m.fenAfter, count: 0 };
}
