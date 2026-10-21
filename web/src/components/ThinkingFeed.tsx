import { Fragment, memo, useEffect, useMemo, useRef } from "react";
import type { CalcLine, Color, Game, IllegalTry, MoveRecord } from "../../../shared/types";
import { selfEvalColors, sideName } from "../../../shared/naming";
import { sideLooks } from "../../../shared/looks";
import { beliefs, engineAfter, selfScore, standing, type Belief } from "../../../shared/belief";
import { PlayerAvatar } from "./PlayerName";
import { formatScore } from "../../../shared/evalmath";
import { explainIllegal, lineBreakReason, triesOf } from "../../../shared/explain";
import { START_FEN, variantOf } from "../../../shared/rules";
import { CLASS_META, ClassIcon } from "./ClassIcon";
import { scrollIntoPanel } from "../scroll";

export interface CalcRef {
  /** The move the line was calculated for (its position is the one before it). */
  ply: number;
  line: number;
  /** A line sent with this illegal attempt (from the same position) instead of with the move. */
  try?: number;
}

const moveNo = (m: MoveRecord) => `${Math.ceil(m.ply / 2)}${m.color === "w" ? "." : "..."}`;

/**
 * What the mover believed against what was true, on one scale from their side: lost on the left,
 * winning on the right. Far apart, the gap is shaded and labelled.
 */
function BeliefMeter({ game, m, b }: { game: Game; m: MoveRecord; b: Belief }) {
  const color = selfEvalColors(game)[m.color];
  const engine = engineAfter(game, m);
  const lo = Math.min(b.self, b.engine);
  return (
    <div className={`belief ${b.state ? "off" : ""}`} style={{ ["--c" as string]: color }}>
      <div className="belief-track" title="Lost ← → winning, from the mover's side">
        {b.state && <div className="belief-span" style={{ left: `${lo}%`, width: `${Math.abs(b.self - b.engine)}%` }} />}
        <div className="belief-dot engine" style={{ left: `${b.engine}%` }} />
        <div className="belief-dot self" style={{ left: `${b.self}%` }} />
      </div>
      <div className="belief-text">
        <span className="who">
          💭 Thinks <b>{formatScore(selfScore(m))}</b> ({standing(b.self)})
        </span>
        <span className="eng">
          Engine <b>{formatScore(engine)}</b> ({standing(b.engine)})
        </span>
        {b.state && <span className="tag off">{b.state === "over" ? "Misjudging: far too optimistic" : "Misjudging: far too pessimistic"}</span>}
        {b.change === "realizes" && <span className="tag real">💡 Sees it now</span>}
      </div>
    </div>
  );
}

const Thought = memo(function Thought({
  game,
  m,
  belief,
  on,
  selectedLine,
  onSelect,
  onPlayLine,
}: {
  game: Game;
  m: MoveRecord;
  belief: Belief | null;
  on: boolean;
  selectedLine: number | null;
  onSelect: (ply: number) => void;
  onPlayLine: (ply: number, i: number, attempt?: number) => void;
}) {
  const player = m.color === "w" ? game.white : game.black;
  const a = m.analysis;
  const self = m.selfEval;
  return (
    <div className={`thought ${on ? "on" : ""}`} onClick={() => onSelect(m.ply)} data-ply={m.ply}>
      <PlayerAvatar player={player} look={sideLooks(game)[m.color]} size={36} />
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
        {belief && <BeliefMeter game={game} m={m} b={belief} />}
        <div className="evals">
          {!belief && (self !== null || m.selfEvalRaw) && (
            <span className="eval-chip" title="The player's own evaluation (White's point of view)">
              Self-eval {self !== null ? (self > 0 ? "+" : "") + self.toFixed(1) : m.selfEvalRaw}
            </span>
          )}
          {!belief && a && (
            <span className={`eval-chip engine ${formatScore(a.evalAfter).startsWith("-") ? "neg" : ""}`} title="Stockfish after this move">
              Engine {formatScore(a.evalAfter)}
            </span>
          )}
          {a?.bestSan && a.bestSan !== m.san && a.classification !== "book" && <span className="eval-chip">Best was {a.bestSan}</span>}
          {m.offeredDraw && <span className="eval-chip">🤝 Offered a draw</span>}
        </div>
        <Lines game={game} fen={m.fenBefore} lines={m.lines} selectedLine={selectedLine} onPlay={(i) => onPlayLine(m.ply, i)} />
      </div>
    </div>
  );
});

/** A turn's calculation lines, each playable on the board. */
function Lines({ game, fen, lines, selectedLine, onPlay }: { game: Game; fen: string; lines: CalcLine[]; selectedLine: number | null; onPlay: (i: number) => void }) {
  const variant = variantOf(game);
  // SSE snapshots replace arrays even when only a clock/seat changed. The chess work depends
  // on the actual line, never on selection, autoplay steps, or the snapshot's object identity.
  const lineKey = JSON.stringify(lines.map(l => [l.san, l.brokenAt]));
  const reasons = useMemo(() => lines.map(l => lineBreakReason(fen, l, variant)), [fen, variant, lineKey]);
  if (!lines.length) return null;
  return (
    <div className="lines">
      {lines.map((l, i) => (
        <button
          key={i}
          className={`line-chip ${selectedLine === i ? "on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onPlay(i);
          }}
          title="Play this calculation on the board"
        >
          <span className="play">▶</span>
          <span>
            <span className="lm">{l.san.join(" ") || "—"}</span>
            {l.brokenAt && (
              <span className="lb">
                {" "}
                ✕ {l.brokenAt} <span className="lbr">({reasons[i]})</span>
              </span>
            )}
            {l.note && <span className="ln">{l.note}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * An illegal attempt as a turn of its own, before the move that followed it: the thinking that went
 * with it, and why it was rejected.
 */
const TryCard = memo(function TryCard({
  game,
  ply,
  color,
  fen,
  move,
  t,
  on,
  selectedLine,
  onSelect,
  onPlayLine,
  index,
}: {
  game: Game;
  /** The position it was tried in: after this many moves. */
  ply: number;
  color: Color;
  fen: string;
  move: string;
  t?: IllegalTry;
  on: boolean;
  selectedLine: number | null;
  onSelect?: (ply: number, i: number) => void;
  onPlayLine: (ply: number, i: number, attempt?: number) => void;
  index: number;
}) {
  const player = color === "w" ? game.white : game.black;
  const no = `${Math.ceil((ply + 1) / 2)}${color === "w" ? "." : "..."}`;
  const reason = useMemo(() => explainIllegal(fen, move), [fen, move]);
  return (
    <div className={`thought try ${on ? "on" : ""}`} onClick={() => onSelect?.(ply, index)} data-try={`${ply}:${index}`}>
      <PlayerAvatar player={player} look={sideLooks(game)[color]} size={36} />
      <div className="thought-body">
        <div className="thought-head">
          <span className="try-move">
            {no} {move}
          </span>
          <span className="try-tag">❌ Illegal</span>
          <span style={{ color: "var(--muted)", fontWeight: 500, fontSize: 12 }}>
            {sideName(game, color)}
            {t ? ` · ${Math.round(t.thinkMs / 1000)}s` : ""}
          </span>
        </div>
        {t?.commentary && <div className="bubble">{t.commentary}</div>}
        <div className="evals">
          {t && (t.selfEval !== null || t.selfEvalRaw) && (
            <span className="eval-chip" title="The player's own evaluation (White's point of view)">
              Self-eval {t.selfEval !== null ? (t.selfEval > 0 ? "+" : "") + t.selfEval.toFixed(1) : t.selfEvalRaw}
            </span>
          )}
        </div>
        <div className="illegal-try">Rejected: {reason}</div>
        {t && <Lines game={game} fen={fen} lines={t.lines} selectedLine={selectedLine} onPlay={(i) => onPlayLine(ply + 1, i, index)} />}
      </div>
    </div>
  );
});

export const ThinkingFeed = memo(function ThinkingFeed(props: {
  game: Game;
  ply: number;
  /** Which illegal attempt from the position after `ply` moves is on the board, if any. */
  tryAt?: number | null;
  calc: CalcRef | null;
  onSelect: (ply: number) => void;
  onSelectTry?: (ply: number, i: number) => void;
  /** `attempt`: a line sent with that illegal attempt, rather than with the move. */
  onPlayLine: (ply: number, line: number, attempt?: number) => void;
}) {
  const tryAt = props.tryAt ?? null;
  const ref = useRef<HTMLDivElement>(null);
  // Keep the selected card in view immediately, matching the move list. Repeated smooth
  // scrolls chase an obsolete target while the viewer holds an arrow key.
  const opened = useRef(false);
  const g = props.game;
  const liveFen = g.moves[g.moves.length - 1]?.fenAfter ?? g.startFen ?? START_FEN;
  const liveTurn = liveFen.split(" ")[1] as Color;
  const pending = g.pendingIllegal?.[liveTurn]?.length ?? 0;
  const setPlies = g.moves.filter((m) => m.supplied).length;
  useEffect(() => {
    // On the latest position, the newest attempt in progress is where the thinking is.
    const sel =
      tryAt !== null
        ? `.thought[data-try="${props.ply}:${tryAt}"]`
        : props.ply === g.moves.length && pending
          ? `.thought[data-try="${props.ply}:${pending - 1}"]`
          : `.thought[data-ply="${props.ply > 0 && props.ply <= setPlies ? setPlies : props.ply}"]`;
    const target = ref.current?.querySelector(sel) ?? (props.ply === 0 ? ref.current?.firstElementChild : null);
    scrollIntoPanel(target, opened.current ? "nearest" : "center", false);
    opened.current = true;
  }, [props.ply, tryAt, g.moves.length, pending, setPlies]);
  const pre = g.phase === "pregame";
  const belief = useMemo(() => beliefs(g), [g]);
  // The attempts from the position after `ply` moves, as cards of their own (the live position's too).
  const tries = (ply: number, color: Color, fen: string, attempts: string[], details: IllegalTry[] | undefined) =>
    triesOf(attempts, details).map((t, j) => (
      <TryCard
        key={`try-${ply}-${j}`}
        game={g}
        ply={ply}
        color={color}
        fen={fen}
        move={attempts[j]}
        t={t}
        index={j}
        on={props.ply === ply && tryAt === j}
        selectedLine={props.calc?.ply === ply + 1 && props.calc.try === j ? props.calc.line : null}
        onSelect={props.onSelectTry}
        onPlayLine={props.onPlayLine}
      />
    ));
  // A set opening's moves were played by the arena, so there's no thinking behind them: one card says so.
  const supplied = g.moves.slice(0, setPlies);
  return (
    <div ref={ref}>
      {supplied.length > 0 && (
        <div className={`thought set-opening ${props.ply > 0 && props.ply <= supplied.length && tryAt === null ? "on" : ""}`} data-ply={supplied.length} onClick={() => props.onSelect(supplied.length)}>
          <div className="thought-body">
            <div className="thought-head">
              <span>♟ Set opening{g.setOpening ? `: ${g.setOpening.name}` : ""}</span>
            </div>
            <div className="bubble">
              The arena played {supplied.map((m) => (m.color === "w" ? `${moveNo(m)}${m.san}` : m.san)).join(" ")} before either player had a turn. Neither of them chose these moves.
            </div>
          </div>
        </div>
      )}
      {g.moves.length === supplied.length && !g.pendingIllegal?.[liveTurn]?.length && (
        <div className="empty">{pre ? "The players are in the pre-game studio. Their thinking will appear here move by move." : "Waiting for the first move…"}</div>
      )}
      {g.moves.map((m, i) => m.supplied ? null : (
        <Fragment key={m.ply}>
          {tries(m.ply - 1, m.color, m.fenBefore, m.illegalAttempts, m.tries)}
          <Thought
            game={g}
            m={m}
            belief={belief[i]}
            on={m.ply === props.ply && tryAt === null}
            selectedLine={props.calc?.ply === m.ply && props.calc.try === undefined ? props.calc.line : null}
            onSelect={props.onSelect}
            onPlayLine={props.onPlayLine}
          />
        </Fragment>
      ))}
      {tries(g.moves.length, liveTurn, liveFen, g.pendingIllegal?.[liveTurn] ?? [], g.pendingTries?.[liveTurn])}
    </div>
  );
});
