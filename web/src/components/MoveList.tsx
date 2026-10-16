import { useEffect, useRef } from "react";
import type { Game, MoveRecord } from "../../../shared/types";
import { ClassIcon } from "./ClassIcon";

const SHOW_ICON = new Set(["brilliant", "great", "best", "book", "inaccuracy", "mistake", "miss", "blunder", "excellent", "good", "forced"]);

export function MoveList({ game, ply, onSelect, hideVerdicts }: { game: Game; ply: number; onSelect: (ply: number) => void; hideVerdicts?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector(".move-cell.on")?.scrollIntoView({ block: "nearest" });
  }, [ply, game.moves.length]);

  const rows: [MoveRecord, MoveRecord | undefined][] = [];
  for (let i = 0; i < game.moves.length; i += 2) rows.push([game.moves[i], game.moves[i + 1]]);

  const cell = (m?: MoveRecord) =>
    m ? (
      <div className={`move-cell ${m.ply === ply ? "on" : ""}`} onClick={() => onSelect(m.ply)}>
        {!hideVerdicts && m.analysis && SHOW_ICON.has(m.analysis.classification) && <ClassIcon c={m.analysis.classification} />}
        {m.san}
      </div>
    ) : (
      <div />
    );

  return (
    <div ref={ref}>
      {game.opening && (
        <div className="opening-name">
          <span className="chip">{game.opening.eco}</span>
          <b>{game.opening.name}</b>
        </div>
      )}
      {rows.length === 0 && <div className="empty">No moves yet.</div>}
      {rows.map(([w, b], i) => (
        <div className="move-row" key={i}>
          <div className="no">{i + 1}.</div>
          {cell(w)}
          {cell(b)}
        </div>
      ))}
      {game.result && (
        <div className="move-row">
          <div />
          <div className="move-cell" style={{ color: "white", fontWeight: 800 }}>
            {game.result}
          </div>
        </div>
      )}
    </div>
  );
}
