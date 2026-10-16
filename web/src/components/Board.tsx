import { useEffect, useRef } from "react";
import { newRules, type Rules, type Variant } from "../../../shared/rules";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { DrawShape } from "chessground/draw";
import type { Key, Pieces } from "chessground/types";
import { read as readFen, write as writeFen } from "chessground/fen";
import type { Classification, Color } from "../../../shared/types";
import { ClassIcon } from "./ClassIcon";

export interface BoardProps {
  fen: string;
  orientation: Color;
  lastMove?: [string, string];
  check?: Color | false;
  arrows?: { from: string; to: string; brush: "green" | "blue" | "red" | "yellow" | "paleGrey" }[];
  badge?: { square: string; c: Classification };
  /** When set, the viewer can play legal moves for the side to move (analysis board). Premoves come with their promotion piece. */
  onUserMove?: (from: string, to: string, promotion?: string) => void;
  /** You're playing this side: while the opponent thinks you can queue premoves, played one per turn. */
  premoveColor?: Color;
  /** Chess960: castling is played by dropping the king on its rook. */
  variant?: Variant;
  children?: React.ReactNode;
}

function legalDests(c: Rules, variant: Variant): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const m of c.moves()) {
    // In Chess960 a castle's target is its rook (king-takes-rook), so it can't be mistaken for a king step.
    const to = (variant === "chess960" ? m.uci.slice(2, 4) : m.to) as Key;
    const list = dests.get(m.from as Key) ?? [];
    if (!list.includes(to)) list.push(to);
    dests.set(m.from as Key, list);
  }
  return dests;
}

type Premove = [Key, Key, string?];

/** A position with one premove shown as played: castling brings its rook along, a pawn on the last rank queens. */
function withPremove(pieces: Pieces, [orig, dest, promo]: Premove): Pieces {
  const out = new Map(pieces);
  const p = out.get(orig);
  if (!p) return out;
  // Chess960 castling, premoved as king-onto-rook: the king lands on g/c, the rook on f/d.
  const onRook = p.role === "king" && out.get(dest)?.role === "rook" && out.get(dest)?.color === p.color;
  if (onRook) {
    const rook = out.get(dest)!;
    const kingside = dest[0] > orig[0];
    out.delete(orig);
    out.delete(dest);
    out.set(`${kingside ? "g" : "c"}${orig[1]}` as Key, p);
    out.set(`${kingside ? "f" : "d"}${orig[1]}` as Key, rook);
    return out;
  }
  out.delete(orig);
  out.set(dest, promo ? { role: "queen", color: p.color, promoted: true } : p);
  if (p.role === "king" && Math.abs(orig.charCodeAt(0) - dest.charCodeAt(0)) === 2) {
    const kingside = dest[0] === "g";
    const from = `${kingside ? "h" : "a"}${orig[1]}` as Key;
    const rook = out.get(from);
    if (rook) {
      out.delete(from);
      out.set(`${kingside ? "f" : "d"}${orig[1]}` as Key, rook);
    }
  }
  return out;
}

/*
 * Arrows: the engine's (best move, calculations) and the viewer's own, drawn with right-click.
 * Chessground draws right-click arrows with its "green"/"red"/"blue"/"yellow" brushes (plain,
 * Shift, Alt, both), so those become the viewer's colours and the engine gets brushes of its own.
 */
const BRUSHES = {
  green: { key: "ua", color: "#ff9f1a", opacity: 0.85, lineWidth: 10 },
  red: { key: "ur", color: "#e8463c", opacity: 0.85, lineWidth: 10 },
  blue: { key: "up", color: "#b25fe0", opacity: 0.85, lineWidth: 10 },
  yellow: { key: "uy", color: "#ffe14d", opacity: 0.85, lineWidth: 10 },
  engineGreen: { key: "eg", color: "#15781B", opacity: 1, lineWidth: 10 },
  engineBlue: { key: "eb", color: "#003088", opacity: 1, lineWidth: 10 },
  engineRed: { key: "er", color: "#882020", opacity: 1, lineWidth: 10 },
  engineYellow: { key: "ey", color: "#e68f00", opacity: 1, lineWidth: 10 },
  enginePaleGrey: { key: "epg", color: "#4a4a4a", opacity: 0.35, lineWidth: 15 },
};
const ENGINE_BRUSH: Record<NonNullable<BoardProps["arrows"]>[number]["brush"], string> = {
  green: "engineGreen",
  blue: "engineBlue",
  red: "engineRed",
  yellow: "engineYellow",
  paleGrey: "enginePaleGrey",
};

const sqPos = (sq: string, orientation: Color) => {
  const f = sq.charCodeAt(0) - 97;
  const r = Number(sq[1]) - 1;
  return orientation === "w" ? { left: f * 12.5, top: (7 - r) * 12.5 } : { left: (7 - f) * 12.5, top: r * 12.5 };
};

export function Board({ fen, orientation, lastMove, check, arrows, badge, onUserMove, premoveColor, variant = "standard", children }: BoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const cg = useRef<Api | null>(null);
  const onMoveRef = useRef(onUserMove);
  onMoveRef.current = onUserMove;
  const variantRef = useRef(variant);
  variantRef.current = variant;

  /*
   * Premoves work like chess.com: queue as many as you like, each shown on the board as already
   * played (so the next one starts from there, even with the same piece). When it's your turn the
   * first one plays if it's legal; an illegal one cancels the whole queue. Right-click, or click an
   * empty square, to cancel them all.
   */
  const realFen = useRef(fen);
  const queue = useRef<Premove[]>([]);
  /** The real position a premove was last played from, so it's only played once. */
  const playedFrom = useRef<string | null>(null);

  const shownPieces = () => queue.current.reduce(withPremove, readFen(realFen.current));
  const premoveSquares = () => new Map(queue.current.flatMap(([o, d]) => [[o, "current-premove"] as const, [d, "current-premove"] as const]));
  /** Setting a fen wipes the viewer's arrows; keep them while the real position stays the same. */
  const userShapes = () => [...(cg.current?.state.drawable.shapes ?? [])];
  const redrawQueue = () => cg.current?.set({ fen: writeFen(shownPieces()), highlight: { custom: premoveSquares() }, drawable: { shapes: userShapes() } });
  const cancelPremoves = () => {
    if (!queue.current.length) return false;
    queue.current = [];
    redrawQueue();
    return true;
  };

  /** Chessground hands over a premove (worked out from the board as shown); it joins the queue instead. */
  const onPremoveSet = (orig: Key, dest: Key) => {
    const api = cg.current!;
    api.state.premovable.current = undefined;
    const piece = api.state.pieces.get(orig);
    if (!piece) return;
    // A king dropped on its own rook means castling.
    const target = api.state.pieces.get(dest);
    const onRook = piece.role === "king" && target?.role === "rook" && target.color === piece.color;
    // Chess960 keeps king-onto-rook (a king step to g1 could be a real move there); standard chess plays it as Kg1/Kc1.
    const to = (onRook && variantRef.current !== "chess960" ? `${dest[0] < orig[0] ? "c" : "g"}${orig[1]}` : dest) as Key;
    const promo = piece.role === "pawn" && (to[1] === "8" || to[1] === "1") ? "q" : undefined;
    queue.current.push([orig, to, promo]);
    redrawQueue();
  };

  useEffect(() => {
    cg.current = Chessground(el.current!, {
      coordinates: true,
      animation: { enabled: true, duration: 220 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: true, visible: true, eraseOnClick: true, brushes: BRUSHES },
      disableContextMenu: true,
      premovable: { enabled: false, events: { set: (o, d) => onPremoveSet(o, d) } },
      movable: { free: false, showDests: true, events: { after: (from, to) => onMoveRef.current?.(from, to) } },
      events: {
        // Clicking an empty square (or an enemy piece) with nothing selected cancels your premoves.
        select: (key) => {
          const s = cg.current?.state;
          if (!s || s.selected || !queue.current.length) return;
          if (s.pieces.get(key)?.color !== s.movable.color) cancelPremoves();
        },
      },
    });
    // With premoves queued, a right-click cancels them (instead of starting an arrow).
    const onRightDown = (e: MouseEvent) => {
      if (e.button === 2 && cancelPremoves()) e.stopPropagation();
    };
    el.current!.addEventListener("mousedown", onRightDown, true);
    return () => {
      el.current?.removeEventListener("mousedown", onRightDown, true);
      cg.current?.destroy();
    };
  }, []);

  const canMove = !!onUserMove;
  useEffect(() => {
    const shapes: DrawShape[] = (arrows ?? []).map((a) => ({ orig: a.from as Key, dest: a.to as Key, brush: ENGINE_BRUSH[a.brush] }));
    const c = newRules(fen, variant);
    const premover = canMove && premoveColor ? premoveColor : undefined;
    if (!premover) queue.current = [];

    // Your turn with premoves queued: play the first one now (or drop them all if it's no longer legal).
    let played: Premove | null = null;
    let last = lastMove;
    let inCheck = check;
    if (premover && c.turn() === premover && queue.current.length && playedFrom.current !== fen) {
      playedFrom.current = fen;
      const next = queue.current.shift()!;
      try {
        c.move({ from: next[0], to: next[1], promotion: next[2] });
        played = next;
        last = [next[0], next[1]];
        inCheck = c.inCheck() ? c.turn() : false;
      } catch {
        queue.current = [];
      }
    }
    const samePosition = realFen.current === c.fen();
    realFen.current = c.fen();

    const turnColor = c.turn() === "w" ? "white" : "black";
    const mine = premover && (premover === "w" ? "white" : "black");
    // Your pieces stay movable on the opponent's turn: chessground turns those moves into premoves.
    const movable: Config["movable"] = mine ? { color: mine, dests: legalDests(c, variant) } : canMove ? { color: turnColor, dests: legalDests(c, variant) } : { color: undefined, dests: new Map() };
    cg.current?.set({
      // While the opponent thinks, the board shows your premoves as played.
      fen: queue.current.length ? writeFen(shownPieces()) : realFen.current,
      orientation: orientation === "w" ? "white" : "black",
      turnColor,
      lastMove: last as Key[] | undefined,
      check: inCheck ? (inCheck === "w" ? "white" : "black") : false,
      movable,
      premovable: { enabled: !!mine },
      highlight: { custom: premoveSquares() },
      // Your arrows stay until the position changes (or you left-click the board).
      drawable: { shapes: samePosition ? userShapes() : [] },
    });
    if (played) onMoveRef.current?.(played[0], played[1], played[2]);
    // Chessground skips SVG redraws while pieces animate, so arrows set together with the fen
    // lag behind fast arrow-key navigation. Setting them separately redraws them on the next frame.
    cg.current?.setAutoShapes(shapes);
  }, [fen, orientation, lastMove?.[0], lastMove?.[1], check, JSON.stringify(arrows), canMove, premoveColor, variant]);

  return (
    <div className="board-size">
      <div ref={el} className="cg-wrap" />
      <div className="board-overlay">
        {badge && (
          <div key={badge.square + badge.c + fen} className="square-badge" style={{ left: `${sqPos(badge.square, orientation).left}%`, top: `${sqPos(badge.square, orientation).top}%` }}>
            <ClassIcon c={badge.c} />
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
