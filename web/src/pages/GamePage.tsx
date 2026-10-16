import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import type { Color, Game } from "../../../shared/types";
import { personalityById } from "../../../shared/personalities";
import { materialInfo } from "../../../shared/material";
import { lineBreakReason } from "../../../shared/explain";
import { useFetch, useStream, type Lobby, type Meta } from "../api";
import { SummonButton } from "../components/NewGame";
import { Board, type BoardProps } from "../components/Board";
import { EvalBar } from "../components/EvalBar";
import { PlayerBar } from "../components/PlayerBar";
import { MoveList } from "../components/MoveList";
import { ThinkingFeed } from "../components/ThinkingFeed";
import { Studio } from "../components/Studio";
import { Review, engineScoreAt } from "../components/Review";
import { useBroadcastAudio } from "../useBroadcastAudio";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
type Tab = "moves" | "thinking" | "studio" | "review";
interface CalcState {
  ply: number;
  line: number;
  step: number;
  playing: boolean;
}

function checkColor(fen: string): Color | false {
  const c = new Chess(fen);
  return c.inCheck() ? c.turn() : false;
}

function resultText(g: Game) {
  const name = (c: Color) => personalityById((c === "w" ? g.white : g.black).personality).name;
  if (g.termination === "aborted" && !g.result) return { title: "Game aborted", sub: "" };
  if (g.result === "1/2-1/2") return { title: "Draw", sub: `by ${g.termination}` };
  const winner: Color = g.result === "1-0" ? "w" : "b";
  return { title: `${name(winner)} won`, sub: `by ${g.termination}` };
}

export function GamePage({ id }: { id: string }) {
  const raw = useStream<Game>(`/api/games/${id}/stream`);
  // Moves the engine couldn't analyze are shown without a verdict rather than a made-up one.
  const game = useMemo(
    () => raw && { ...raw, moves: raw.moves.map((m) => (m.analysis?.unavailable ? { ...m, analysis: undefined } : m)) },
    [raw],
  );
  const lobby = useFetch<Lobby>("/api/lobby", [game?.result]);
  const meta = useFetch<Meta>("/api/meta");
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [orientation, setOrientation] = useState<Color>("w");
  const [tab, setTab] = useState<Tab>("thinking");
  const [calc, setCalc] = useState<CalcState | null>(null);
  const [showBest, setShowBest] = useState(true);
  const [now, setNow] = useState(Date.now());
  const audio = useBroadcastAudio(game);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (game?.phase === "finished" && game.review && tab === "thinking" && viewPly === null) setTab("review");
  }, [game?.phase]);

  const total = game?.moves.length ?? 0;
  const ply = viewPly === null ? total : Math.min(viewPly, total);
  const go = (p: number) => {
    setCalc(null);
    const clamped = Math.max(0, Math.min(total, p));
    setViewPly(clamped >= total ? null : clamped);
  };

  // keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") calc ? stepCalc(-1) : go(ply - 1);
      else if (e.key === "ArrowRight") calc ? stepCalc(1) : go(ply + 1);
      else if (e.key === "Escape") setCalc(null);
      else if (e.key === "f") setOrientation((o) => (o === "w" ? "b" : "w"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const calcLine = calc && game ? game.moves[calc.ply - 1]?.lines[calc.line] : null;
  const stepCalc = (d: number) =>
    setCalc((c) => (c && calcLine ? { ...c, playing: false, step: Math.max(0, Math.min(calcLine.san.length, c.step + d)) } : c));

  // calculation autoplay
  useEffect(() => {
    if (!calc?.playing || !calcLine) return;
    if (calc.step >= calcLine.san.length) {
      setCalc({ ...calc, playing: false });
      return;
    }
    const t = setTimeout(() => setCalc((c) => (c ? { ...c, step: c.step + 1 } : c)), calc.step === 0 ? 500 : 950);
    return () => clearTimeout(t);
  }, [calc?.playing, calc?.step, calcLine]);

  const view = useMemo((): BoardProps | null => {
    if (!game) return null;
    if (calc && calcLine) {
      const m = game.moves[calc.ply - 1];
      const c = new Chess(m.fenBefore);
      let last: [string, string] | undefined;
      for (const san of calcLine.san.slice(0, calc.step)) {
        const mv = c.move(san);
        last = [mv.from, mv.to];
      }
      const arrows: BoardProps["arrows"] = [];
      const nextSan = calcLine.san[calc.step];
      if (nextSan) {
        const mv = new Chess(c.fen()).move(nextSan);
        arrows.push({ from: mv.from, to: mv.to, brush: "blue" });
      }
      return { fen: c.fen(), orientation, lastMove: last, check: checkColor(c.fen()), arrows };
    }
    if (ply === 0) return { fen: game.moves[0]?.fenBefore ?? START_FEN, orientation };
    const m = game.moves[ply - 1];
    const a = m.analysis;
    const arrows: BoardProps["arrows"] = [];
    if (showBest && a?.bestUci && a.bestUci !== m.uci && !["book", "forced"].includes(a.classification)) {
      arrows.push({ from: a.bestUci.slice(0, 2), to: a.bestUci.slice(2, 4), brush: "green" });
    }
    return {
      fen: m.fenAfter,
      orientation,
      lastMove: [m.from, m.to],
      check: checkColor(m.fenAfter),
      arrows,
      badge: a ? { square: m.to, c: a.classification } : undefined,
    };
  }, [game, ply, calc, calcLine, orientation, showBest]);

  const material = useMemo(() => {
    if (!game) return null;
    const start = game.moves[0]?.fenBefore ?? START_FEN;
    if (calc && calcLine) return materialInfo(start, [...game.moves.slice(0, calc.ply - 1).map((m) => m.san), ...calcLine.san.slice(0, calc.step)]);
    return materialInfo(start, game.moves.slice(0, ply).map((m) => m.san));
  }, [game?.moves.length, ply, calc, calcLine]);

  if (!game || !view || !material) return <div className="empty">Loading game…</div>;

  const turn: Color = new Chess(game.moves[total - 1]?.fenAfter ?? START_FEN).turn();
  const playing = game.phase === "playing";
  const thinkMs = (c: Color) =>
    game.moves.filter((m) => m.color === c).reduce((a, m) => a + m.thinkMs, 0) + (playing && turn === c && game.turnStartedAt ? now - game.turnStartedAt : 0);
  const rating = (c: Color) => lobby?.players.find((p) => p.id === (c === "w" ? game.white : game.black).id)?.rating;
  const status = (c: Color) => {
    if (game.phase === "pregame") return game.interviews.pre[c] ? { text: "Ready", kind: "plain" as const } : { text: "In the studio", kind: "plain" as const };
    if (playing && turn === c) {
      const seen = game.seen[c];
      if (!seen || now - seen > 150_000) return { text: "Agent idle", kind: "idle" as const };
      return { text: "Thinking", kind: "thinking" as const };
    }
    if (game.phase === "postgame") return { text: "Post-game", kind: "plain" as const };
    return null;
  };
  const top: Color = orientation === "w" ? "b" : "w";
  const bottom: Color = orientation;
  const bar = (c: Color) => (
    <PlayerBar
      player={c === "w" ? game.white : game.black}
      color={c}
      material={material}
      rating={rating(c)}
      status={status(c)}
      clockMs={thinkMs(c)}
      active={playing && turn === c}
    />
  );
  const evalScore = calc ? undefined : engineScoreAt(game, ply);
  const isLive = viewPly === null && !calc;
  const calcMove = calc ? game.moves[calc.ply - 1] : null;
  const res = game.result || game.termination === "aborted" ? resultText(game) : null;

  return (
    <div className="game-page">
      <div className="board-col">
        <EvalBar score={evalScore} orientation={orientation} result={ply === total && !calc ? game.result : null} />
        <div className="board-stack">
          {bar(top)}
          <Board {...view} />
          {bar(bottom)}
        </div>
      </div>

      <div className="side-panel">
        <div className="tabs">
          {(
            [
              ["thinking", "🧠", "Thinking"],
              ["moves", "♟", "Moves"],
              ["studio", "🎙", "Studio"],
              ["review", "⭐", "Review"],
            ] as [Tab, string, string][]
          ).map(([k, ico, label]) => (
            <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
              <span className="t-ico">{ico}</span>
              {label}
            </button>
          ))}
        </div>
        {res && (
          <div className="result-banner">
            <h3>{res.title}</h3>
            <p>
              {res.sub}
              {game.review?.w.accuracy != null &&
                game.review.b.accuracy != null &&
                ` · Accuracy ${game.review.w.accuracy.toFixed(1)} – ${game.review.b.accuracy.toFixed(1)}`}
            </p>
          </div>
        )}
        {calc && calcLine && calcMove && (
          <div className="calc-banner">
            <div className="head">
              <span>
                🧠 {personalityById((calcMove.color === "w" ? game.white : game.black).personality).name}'s calculation · line {calc.line + 1} (move{" "}
                {Math.ceil(calcMove.ply / 2)})
              </span>
              <button className="icon-btn" onClick={() => setCalc(null)} title="Exit (Esc)">
                ✕
              </button>
            </div>
            <div className="calc-moves">
              {calcLine.san.map((s, i) => (
                <span key={i} className={i + 1 === calc.step ? "on" : i + 1 > calc.step ? "future" : ""} onClick={() => setCalc({ ...calc, step: i + 1, playing: false })}>
                  {(calcMove.ply + i) % 2 === 1 ? `${Math.ceil((calcMove.ply + i) / 2)}. ` : i === 0 ? `${Math.ceil((calcMove.ply + i) / 2)}… ` : ""}
                  {s}
                </span>
              ))}
              {calcLine.brokenAt && (
                <span className="broken" title="The line breaks here: this move is illegal in the calculated position">
                  ✕ {calcLine.brokenAt} — illegal: {lineBreakReason(calcMove.fenBefore, calcLine)}
                </span>
              )}
            </div>
            {calcLine.note && <div style={{ fontSize: 13, color: "var(--text-2)" }}>{calcLine.note}</div>}
            <div className="calc-controls">
              <button className="btn" onClick={() => setCalc({ ...calc, step: 0, playing: false })}>
                ⏮
              </button>
              <button className="btn" onClick={() => stepCalc(-1)}>
                ◀
              </button>
              <button
                className="btn green"
                onClick={() => setCalc({ ...calc, playing: !calc.playing, step: calc.step >= calcLine.san.length ? 0 : calc.step })}
              >
                {calc.playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <button className="btn" onClick={() => stepCalc(1)}>
                ▶
              </button>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
                {calc.step}/{calcLine.san.length}
              </span>
            </div>
          </div>
        )}
        {game.phase === "pregame" && !game.seen.w && !game.seen.b && (
          <div className="result-banner" style={{ textAlign: "left" }}>
            <h3 style={{ fontSize: 17 }}>Waiting for the players</h3>
            <p style={{ marginBottom: 10 }}>
              {game.summonRequestedAt
                ? `Summoned ${Math.max(0, Math.round((now - game.summonRequestedAt) / 1000))}s ago — the agents are on their way.`
                : "Nobody has joined this board yet."}
            </p>
            {meta?.summonAvailable && !game.summonRequestedAt && <SummonButton gameId={game.id} compact />}
          </div>
        )}
        <div className="panel-body">
          {tab === "moves" && <MoveList game={game} ply={ply} onSelect={go} />}
          {tab === "thinking" && (
            <ThinkingFeed game={game} ply={ply} calc={calc} onSelect={go} onPlayLine={(p, line) => setCalc({ ply: p, line, step: 0, playing: true })} />
          )}
          {tab === "studio" && <Studio game={game} audio={audio} />}
          {tab === "review" && <Review game={game} ply={ply} onSelect={go} ratings={{ w: rating("w"), b: rating("b") }} />}
        </div>
        <div className="panel-footer">
          <div className="nav-btns">
            <button className="btn" onClick={() => go(0)} title="Start">
              ⏮
            </button>
            <button className="btn" onClick={() => go(ply - 1)} title="Previous (←)">
              ◀
            </button>
            <button className="btn" onClick={() => go(ply + 1)} title="Next (→)">
              ▶
            </button>
            <button className="btn" onClick={() => go(total)} title="Latest">
              ⏭
            </button>
          </div>
          <button className="icon-btn" onClick={() => setOrientation((o) => (o === "w" ? "b" : "w"))} title="Flip board (f)">
            ⇅
          </button>
          <button className={`icon-btn`} style={{ color: showBest ? "var(--green)" : undefined }} onClick={() => setShowBest(!showBest)} title="Show engine's best-move arrow">
            ➚
          </button>
          {game.broadcaster?.enabled && (
            <button className="icon-btn" onClick={() => audio.setEnabled(!audio.enabled)} title={audio.enabled ? "Mute broadcaster" : "Unmute broadcaster"}>
              {audio.enabled ? "🔊" : "🔇"}
            </button>
          )}
          <a className="icon-btn" href={`/api/games/${game.id}/pgn`} title="Download PGN">
            ⤓
          </a>
          {game.phase !== "finished" && (
            <span className="live-dot" style={{ opacity: isLive ? 1 : 0.4, cursor: "pointer" }} onClick={() => go(total)}>
              ● LIVE
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
