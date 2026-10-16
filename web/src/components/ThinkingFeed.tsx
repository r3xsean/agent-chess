import { useEffect, useRef } from "react";
import type { Game, MoveRecord } from "../../../shared/types";
import { sideName } from "../../../shared/naming";
import { PlayerAvatar } from "./PlayerName";
import { formatScore } from "../../../shared/evalmath";
import { explainIllegal, lineBreakReason } from "../../../shared/explain";
import { variantOf } from "../../../shared/rules";
import { Avatar } from "./PlayerBar";
import { CLASS_META, ClassIcon } from "./ClassIcon";

export interface CalcRef {
  ply: number;
  line: number;
}

const moveNo = (m: MoveRecord) => `${Math.ceil(m.ply / 2)}${m.color === "w" ? "." : "..."}`;

function Thought({ game, m, on, calc, onSelect, onPlayLine }: { game: Game; m: MoveRecord; on: boolean; calc: CalcRef | null; onSelect: () => void; onPlayLine: (i: number) => void }) {
  const player = m.color === "w" ? game.white : game.black;
  const a = m.analysis;
  const self = m.selfEval;
  return (
    <div className={`thought ${on ? "on" : ""}`} onClick={onSelect} data-ply={m.ply}>
      <PlayerAvatar player={player} size={36} />
      <div className="thought-body">
        <div className="thought-head">
          <span>
            {moveNo(m)} {m.san}
          </span>
          {a && (
            <>
              <ClassIcon c={a.classification} />
              <span className="class-label" style={{ color: CLASS_META[a.classification].color }}>
                {CLASS_META[a.classification].label}
              </span>
            </>
          )}
          <span style={{ color: "var(--muted)", fontWeight: 500, fontSize: 12 }}>
            {sideName(game, m.color)} · {Math.round(m.thinkMs / 1000)}s
          </span>
        </div>
        {/* A human's moves come without commentary or self-evaluation. */}
        {m.commentary && <div className="bubble">{m.commentary}</div>}
        <div className="evals">
          {(self !== null || m.selfEvalRaw) && (
            <span className="eval-chip" title="The player's own evaluation (White's point of view)">
              Self-eval {self !== null ? (self > 0 ? "+" : "") + self.toFixed(1) : m.selfEvalRaw}
            </span>
          )}
          {a && (
            <span className={`eval-chip engine ${formatScore(a.evalAfter).startsWith("-") ? "neg" : ""}`} title="Stockfish after this move">
              Engine {formatScore(a.evalAfter)}
            </span>
          )}
          {a?.bestSan && a.bestSan !== m.san && a.classification !== "book" && <span className="eval-chip">Best was {a.bestSan}</span>}
          {m.offeredDraw && <span className="eval-chip">🤝 Offered a draw</span>}
        </div>
        {m.illegalAttempts.map((t, i) => (
          <div className="illegal" key={i}>
            ❌ Tried {t} — illegal: {explainIllegal(m.fenBefore, t)}
          </div>
        ))}
        {m.lines.length > 0 && (
          <div className="lines">
            {m.lines.map((l, i) => (
              <button
                key={i}
                className={`line-chip ${calc && calc.ply === m.ply && calc.line === i ? "on" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onPlayLine(i);
                }}
                title="Play this calculation on the board"
              >
                <span className="play">▶</span>
                <span>
                  <span className="lm">{l.san.join(" ") || "—"}</span>
                  {l.brokenAt && (
                    <span className="lb">
                      {" "}
                      ✕ {l.brokenAt} <span className="lbr">({lineBreakReason(m.fenBefore, l, variantOf(game))})</span>
                    </span>
                  )}
                  {l.note && <span className="ln">{l.note}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThinkingFeed(props: { game: Game; ply: number; calc: CalcRef | null; onSelect: (ply: number) => void; onPlayLine: (ply: number, line: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Opening the tab jumps straight to the current move; after that, following the game scrolls smoothly.
  const opened = useRef(false);
  useEffect(() => {
    const el = ref.current?.querySelector(`.thought[data-ply="${props.ply}"]`);
    el?.scrollIntoView(opened.current ? { block: "nearest", behavior: "smooth" } : { block: "center", behavior: "instant" });
    opened.current = true;
  }, [props.ply, props.game.moves.length]);
  const pre = props.game.phase === "pregame";
  return (
    <div ref={ref}>
      {props.game.moves.length === 0 && (
        <div className="empty">{pre ? "The players are in the pre-game studio. Their thinking will appear here move by move." : "Waiting for the first move…"}</div>
      )}
      {props.game.moves.map((m) => (
        <Thought
          key={m.ply}
          game={props.game}
          m={m}
          on={m.ply === props.ply}
          calc={props.calc}
          onSelect={() => props.onSelect(m.ply)}
          onPlayLine={(i) => props.onPlayLine(m.ply, i)}
        />
      ))}
    </div>
  );
}
