import type { ShownLine } from "../../../shared/engineLine";
import type { RulesMove } from "../../../shared/rules";
import type { MoveRecord } from "../../../shared/types";
import { LINE_SLIDE, type LineStep, type Scene } from "./timeline";

/** Reverse the original forward animation, including captures, en passant and castling. */
export function rewindFrame(moves: RulesMove[], range: [number, number], t: number) {
  const done = Math.max(0, (t - range[0]) / (range[1] - range[0])) * moves.length;
  const count = Math.max(0, moves.length - Math.floor(done));
  const move = moves[count - 1];
  return { count, move, progress: move ? 1 - (done - Math.floor(done)) : 0 };
}

/**
 * The board of a line with branches at time t (see LineStep): which path is on it (`seg`), how many of its
 * moves (`count`), and the move in motion, sliding in (or, winding back, sliding out) `progress` of the way.
 * `paths[seg + 1]` is path seg's moves from the line's start. `landed`: when the newest move settled.
 */
export function trackAt(steps: LineStep[], paths: RulesMove[][], t: number) {
  let seg = -1;
  let count = 0;
  let moving: { move: RulesMove; progress: number } | undefined;
  let landed = -1;
  for (const st of steps) {
    if (st.at > t) break;
    const path = paths[st.seg + 1] ?? [];
    if ("end" in st) {
      seg = st.seg;
      if (t >= st.end) {
        count = st.to;
        moving = undefined;
        continue;
      }
      const frame = rewindFrame(path.slice(st.to, st.from), [st.at, st.end], t);
      count = st.to + frame.count;
      moving = frame.move && { move: frame.move, progress: frame.progress };
      landed = -1;
      continue;
    }
    seg = st.seg;
    count = st.k;
    if (st.hold) {
      moving = undefined;
      landed = -1;
      continue;
    }
    const p = (t - st.at) / LINE_SLIDE;
    moving = p < 1 && path[st.k - 1] ? { move: path[st.k - 1], progress: p } : undefined;
    landed = st.at + LINE_SLIDE;
  }
  const path = paths[seg + 1] ?? [];
  return { seg, count, path: path.slice(0, count), moving, landed };
}

/** Deterministic transition frames, shared by preview and frame-by-frame export. `onBoard`: what the final wind-back takes off (the line, or the branch left on the board). */
export function lineTransition(s: Extract<Scene, { kind: "line" }>, m: MoveRecord, line: ShownLine, t: number, onBoard: RulesMove[] = line.moves) {
  if (t < s.enterAt) return { phase: "hold" as const, fen: s.first ? m.fenBefore : m.fenAfter, count: 0 };
  if (!s.punish && t < s.readyAt) {
    return { phase: "enter" as const, fen: m.fenAfter, move: m, progress: 1 - (t - s.enterAt) / (s.readyAt - s.enterAt), count: 0 };
  }
  if (t < s.back[0]) return undefined;
  if (t < s.back[1]) {
    const frame = rewindFrame(onBoard, s.back, t);
    return { phase: "rewind" as const, fen: frame.move?.after ?? line.fen, ...frame };
  }
  if (t < s.restoreEnd) {
    return { phase: "restore" as const, fen: m.fenAfter, move: m, progress: (t - s.back[1]) / (s.restoreEnd - s.back[1]), count: 0 };
  }
  return { phase: "done" as const, fen: s.first ? m.fenBefore : m.fenAfter, count: 0 };
}
