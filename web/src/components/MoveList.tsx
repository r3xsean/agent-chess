import { useEffect, useRef } from "react";
import type { Game, MoveRecord } from "../../../shared/types";
import { ClassIcon } from "./ClassIcon";
import { scrollIntoPanel } from "../scroll";

const SHOW_ICON = new Set(["brilliant", "great", "best", "book", "inaccuracy", "mistake", "miss", "blunder", "excellent", "good", "forced"]);

export function MoveList({
  game,
  ply,
  tryAt = null,
  onSelect,
  onSelectTry,
  hideVerdicts,
}: {
  game: Game;
  ply: number;
  /** Which illegal attempt from the position after `ply` moves is on the board, if any. */
  tryAt?: number | null;
  onSelect: (ply: number) => void;
  onSelectTry?: (ply: number, i: number) => void;
  hideVerdicts?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollIntoPanel(ref.current?.querySelector(".move-cell.on, .move-try.on"), "nearest", false);
  }, [ply, tryAt, game.moves.length]);

  const rows: [MoveRecord, MoveRecord | undefined][] = [];
  for (let i = 0; i < game.moves.length; i += 2) rows.push([game.moves[i], game.moves[i + 1]]);

  const cell = (m?: MoveRecord) =>
    m ? (
      <div className={`move-cell ${m.ply === ply && tryAt === null ? "on" : ""}`} onClick={() => onSelect(m.ply)}>
        {/* Illegal attempts come first: tried from the position before this move. */}
        {!hideVerdicts &&
          m.illegalAttempts.map((t, i) => (
            <span
              key={i}
              className={`move-try ${m.ply - 1 === ply && tryAt === i ? "on" : ""}`}
              title={`Tried ${t} (illegal)`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTry?.(m.ply - 1, i);
              }}
            >
              ✕{t}
            </span>
          ))}
        {!hideVerdicts && m.analysis && SHOW_ICON.has(m.analysis.classification) && <ClassIcon c={m.analysis.classification} />}
        {m.san}
      </div>
    ) : (
      <div />
    );

  return (
    <div ref={ref}>
      {(game.opening || game.options?.rated === false) && (
        <div className="opening-name">
          {game.opening && (
            <>
              <span className="chip">{game.opening.eco}</span>
              <b>{game.opening.name}</b>
            </>
          )}
          {game.options?.rated === false && <span className="chip" title="This game doesn't change anyone's rating">Unrated</span>}
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
