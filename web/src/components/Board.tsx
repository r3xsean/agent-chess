import { useEffect, useRef } from "react";
import { Chess } from "chess.js";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import type { Classification, Color } from "../../../shared/types";
import { ClassIcon } from "./ClassIcon";

export interface BoardProps {
  fen: string;
  orientation: Color;
  lastMove?: [string, string];
  check?: Color | false;
  arrows?: { from: string; to: string; brush: "green" | "blue" | "red" | "yellow" | "paleGrey" }[];
  badge?: { square: string; c: Classification };
  /** When set, the viewer can play legal moves for the side to move (analysis board). */
  onUserMove?: (from: string, to: string) => void;
  children?: React.ReactNode;
}

function legalDests(c: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const m of c.moves({ verbose: true })) {
    const list = dests.get(m.from as Key) ?? [];
    list.push(m.to as Key);
    dests.set(m.from as Key, list);
  }
  return dests;
}

const sqPos = (sq: string, orientation: Color) => {
  const f = sq.charCodeAt(0) - 97;
  const r = Number(sq[1]) - 1;
  return orientation === "w" ? { left: f * 12.5, top: (7 - r) * 12.5 } : { left: (7 - f) * 12.5, top: r * 12.5 };
};

export function Board({ fen, orientation, lastMove, check, arrows, badge, onUserMove, children }: BoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const cg = useRef<Api | null>(null);
  const onMoveRef = useRef(onUserMove);
  onMoveRef.current = onUserMove;

  useEffect(() => {
    cg.current = Chessground(el.current!, {
      coordinates: true,
      animation: { enabled: true, duration: 220 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: false, visible: true },
      premovable: { enabled: false },
      movable: { free: false, showDests: true, events: { after: (from, to) => onMoveRef.current?.(from, to) } },
    });
    return () => cg.current?.destroy();
  }, []);

  const canMove = !!onUserMove;
  useEffect(() => {
    const shapes: DrawShape[] = (arrows ?? []).map((a) => ({ orig: a.from as Key, dest: a.to as Key, brush: a.brush }));
    const c = new Chess(fen);
    const turnColor = c.turn() === "w" ? "white" : "black";
    cg.current?.set({
      fen,
      orientation: orientation === "w" ? "white" : "black",
      turnColor,
      lastMove: lastMove as Key[] | undefined,
      check: check ? (check === "w" ? "white" : "black") : false,
      movable: canMove ? { color: turnColor, dests: legalDests(c) } : { color: undefined, dests: new Map() },
    });
    // Chessground skips SVG redraws while pieces animate, so arrows set together with the fen
    // lag behind fast arrow-key navigation. Setting them separately redraws them on the next frame.
    cg.current?.setAutoShapes(shapes);
  }, [fen, orientation, lastMove?.[0], lastMove?.[1], check, JSON.stringify(arrows), canMove]);

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
