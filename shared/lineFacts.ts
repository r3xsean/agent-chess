import type { Color } from "./types";
import type { RulesMove } from "./rules";
import { boardOf, type Piece } from "./thoughtMarks";

/*
 * What a move in an engine line does, in plain chess terms, for the director's brief: the check, what it
 * takes, what it hits afterwards (a fork when it hits two things worth hitting), and the defender a capture
 * removes. Worked out here so the narrator explains the chess that's really on the board.
 */

const NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const sq = (f: number, r: number) => `${"abcdefgh"[f]}${r + 1}`;
const fr = (s: string) => [s.charCodeAt(0) - 97, Number(s[1]) - 1];

/** The squares a piece on `from` attacks on this board (pawns: their captures only). */
export function attacksFrom(board: Map<string, Piece>, from: string): string[] {
  const pc = board.get(from);
  if (!pc) return [];
  const [f, r] = fr(from);
  const out: string[] = [];
  const on = (x: number, y: number) => x >= 0 && x < 8 && y >= 0 && y < 8;
  const jump = (ds: number[][]) => ds.forEach(([dx, dy]) => on(f + dx, r + dy) && out.push(sq(f + dx, r + dy)));
  const ray = (ds: number[][]) =>
    ds.forEach(([dx, dy]) => {
      for (let x = f + dx, y = r + dy; on(x, y); x += dx, y += dy) {
        out.push(sq(x, y));
        if (board.has(sq(x, y))) break;
      }
    });
  const diag = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const line = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (pc.type === "p") jump(pc.color === "w" ? [[1, 1], [-1, 1]] : [[1, -1], [-1, -1]]);
  else if (pc.type === "n") jump([[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]);
  else if (pc.type === "k") jump([...diag, ...line]);
  else if (pc.type === "b") ray(diag);
  else if (pc.type === "r") ray(line);
  else if (pc.type === "q") ray([...diag, ...line]);
  return out;
}

/** Whether a side attacks a square on this board. */
function attacked(board: Map<string, Piece>, target: string, by: Color): boolean {
  for (const [s, pc] of board) if (pc.color === by && attacksFrom(board, s).includes(target)) return true;
  return false;
}

const other = (c: Color): Color => (c === "w" ? "b" : "w");

/** What one move of a line does, as a short phrase ("check; takes the pawn on f5; hits the queen on h4 and the rook on e3: a fork"), or "" for a quiet move. */
export function moveFacts(mv: RulesMove): string {
  const before = boardOf(mv.before);
  const after = boardOf(mv.after);
  const me = mv.color;
  const them = other(me);
  const out: string[] = [];
  if (mv.san.endsWith("#")) out.push("checkmate");
  else if (mv.san.includes("+")) out.push("check");
  if (mv.captured) out.push(`takes the ${NAME[mv.captured]} on ${mv.to}${attacked(after, mv.to, them) ? "" : ", and nothing can take back"}`);
  if (mv.promotion) out.push(`promotes to a ${NAME[mv.promotion]}`);
  // What the moved piece hits now: the king (check), anything worth more than it, or anything left loose.
  const mine = after.get(mv.to);
  if (mine) {
    const hits = attacksFrom(after, mv.to).flatMap((s) => {
      const pc = after.get(s);
      if (!pc || pc.color !== them || pc.type === "k") return [];
      return VALUE[pc.type] > VALUE[mine.type] || !attacked(after, s, them) ? [`the ${NAME[pc.type]} on ${s}`] : [];
    });
    const checks = mv.san.includes("+") && attacksFrom(after, mv.to).some((s) => after.get(s)?.type === "k" && after.get(s)?.color === them);
    // A fork is two real targets at once: the king, or pieces (a loose pawn is a hit, not half a fork).
    const big = attacksFrom(after, mv.to).filter((s) => {
      const pc = after.get(s);
      return pc?.color === them && pc.type !== "k" && pc.type !== "p" && (VALUE[pc.type] > VALUE[mine.type] || !attacked(after, s, them));
    }).length;
    if (hits.length) out.push(`hits ${hits.join(" and ")}${big + (checks ? 1 : 0) >= 2 ? ": a fork" : ""}`);
  }
  // A capture that took away a defender: what the taken piece guarded that's now attacked and unguarded.
  if (mv.captured) {
    const was = before.get(mv.to);
    if (was) {
      const guarded = attacksFrom(before, mv.to).filter((s) => before.get(s)?.color === them && before.get(s)?.type !== "k");
      const loose = guarded.filter((s) => after.get(s)?.color === them && attacked(after, s, me) && !attacked(after, s, them));
      if (loose.length) out.push(`removes the defender of ${loose.map((s) => `the ${NAME[after.get(s)!.type]} on ${s}`).join(" and ")}`);
    }
  }
  return out.join("; ");
}
