import { useEffect, useRef } from "react";
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
  children?: React.ReactNode;
}

const sqPos = (sq: string, orientation: Color) => {
  const f = sq.charCodeAt(0) - 97;
  const r = Number(sq[1]) - 1;
  return orientation === "w" ? { left: f * 12.5, top: (7 - r) * 12.5 } : { left: (7 - f) * 12.5, top: r * 12.5 };
};

export function Board({ fen, orientation, lastMove, check, arrows, badge, children }: BoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const cg = useRef<Api | null>(null);

  useEffect(() => {
    cg.current = Chessground(el.current!, {
      viewOnly: true,
      coordinates: true,
      animation: { enabled: true, duration: 220 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: false, visible: true },
    });
    return () => cg.current?.destroy();
  }, []);

  useEffect(() => {
    const shapes: DrawShape[] = (arrows ?? []).map((a) => ({ orig: a.from as Key, dest: a.to as Key, brush: a.brush }));
    cg.current?.set({
      fen,
      orientation: orientation === "w" ? "white" : "black",
      lastMove: lastMove as Key[] | undefined,
      check: check ? (check === "w" ? "white" : "black") : false,
      drawable: { autoShapes: shapes },
    });
  }, [fen, orientation, lastMove?.[0], lastMove?.[1], check, JSON.stringify(arrows)]);

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
