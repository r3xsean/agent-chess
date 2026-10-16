import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import type { Classification, Color, Game, MoveAnalysis, PositionAnalysis } from "../../../shared/types";
import { ClassIcon, CLASS_META } from "../components/ClassIcon";
import { formatScore, scoreToCp } from "../../../shared/evalmath";
import { sideName } from "../../../shared/naming";
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
/** The viewer's own analysis: moves played on the board from some position of the game. */
interface ExploreState {
  baseFen: string;
  /** Game moves (and calculation moves) leading to baseFen — for the captured-material display. */
  preSans: string[];
  /** The game ply the analysis branched from (null when it branched off an agent's calculation). */
  basePly: number | null;
  moves: string[];
  step: number;
}

function checkColor(fen: string): Color | false {
  const c = new Chess(fen);
  return c.inCheck() ? c.turn() : false;
}

/** Move-number prefixes for a SAN sequence starting at `fen` ("12. ", "12… ", ""). */
function movePrefixes(fen: string, count: number): string[] {
  const [, side, , , , full] = fen.split(" ");
  let no = Number(full) || 1;
  let white = side === "w";
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(white ? `${no}. ` : i === 0 ? `${no}… ` : "");
    if (!white) no++;
    white = !white;
  }
  return out;
}

const VERDICT: Record<Classification, string> = {
  brilliant: "brilliant!!",
  great: "a great move!",
  best: "the best move",
  excellent: "excellent",
  good: "good",
  book: "a book move",
  forced: "forced",
  inaccuracy: "an inaccuracy",
  mistake: "a mistake",
  miss: "a miss",
  blunder: "a blunder",
};

function pvToSan(fen: string, pv: string[], max = 10): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, max)) {
    try {
      out.push(c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  return out;
}

function resultText(g: Game) {
  const name = (c: Color) => sideName(g, c);
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
  const [explore, setExplore] = useState<ExploreState | null>(null);
  const [exploreAn, setExploreAn] = useState<Record<string, PositionAnalysis>>({});
  /** Ratings of the viewer's moves, keyed by `${fenBefore}|${san}`. */
  const [exploreCls, setExploreCls] = useState<Record<string, MoveAnalysis>>({});
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
    setExplore(null);
    const clamped = Math.max(0, Math.min(total, p));
    setViewPly(clamped >= total ? null : clamped);
  };
  const stepExplore = (d: number) => setExplore((x) => (x ? { ...x, step: Math.max(0, Math.min(x.moves.length, x.step + d)) } : x));

  // keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") explore ? stepExplore(-1) : calc ? stepCalc(-1) : go(ply - 1);
      else if (e.key === "ArrowRight") explore ? stepExplore(1) : calc ? stepCalc(1) : go(ply + 1);
      else if (e.key === "Escape") (setCalc(null), setExplore(null));
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

  // Every position and move of the viewer's line, worked out once.
  const exploreLine = useMemo(() => {
    if (!explore) return null;
    const c = new Chess(explore.baseFen);
    const fens = [c.fen()];
    const moves = explore.moves.map((san) => {
      const mv = c.move(san);
      fens.push(c.fen());
      return { san: mv.san, from: mv.from, to: mv.to, uci: mv.from + mv.to + (mv.promotion ?? ""), key: `${mv.before}|${mv.san}` };
    });
    return { fens, moves };
  }, [explore?.baseFen, explore?.moves.join(" ")]);

  const view = useMemo((): BoardProps | null => {
    if (!game) return null;
    if (explore && exploreLine) {
      const fen = exploreLine.fens[explore.step];
      const last = exploreLine.moves[explore.step - 1];
      return { fen, orientation, lastMove: last ? [last.from, last.to] : undefined, check: checkColor(fen) };
    }
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
  }, [game, ply, calc, calcLine, explore, exploreLine, orientation, showBest]);

  const material = useMemo(() => {
    if (!game) return null;
    const start = game.moves[0]?.fenBefore ?? START_FEN;
    if (explore) return materialInfo(start, [...explore.preSans, ...explore.moves.slice(0, explore.step)]);
    if (calc && calcLine) return materialInfo(start, [...game.moves.slice(0, calc.ply - 1).map((m) => m.san), ...calcLine.san.slice(0, calc.step)]);
    return materialInfo(start, game.moves.slice(0, ply).map((m) => m.san));
  }, [game?.moves.length, ply, calc, calcLine, explore]);

  // Engine analysis of the viewer's own positions, plus a rating for the move that reached each one.
  const exploreFen = explore && view ? view.fen : null;
  const gameAn = exploreFen ? game?.analysis[exploreFen] : undefined;
  const exploreA = exploreFen ? (gameAn && !gameAn.failed && gameAn.depth > 0 ? gameAn : exploreAn[exploreFen]) : undefined;
  const lastExplored = explore && exploreLine && explore.step > 0 ? exploreLine.moves[explore.step - 1] : null;
  const lastCls = lastExplored ? exploreCls[lastExplored.key] : undefined;
  useEffect(() => {
    if (!exploreFen || !game || !explore || !exploreLine || (exploreA && (!lastExplored || lastCls))) return;
    let move: unknown;
    if (lastExplored) {
      const i = explore.step - 1;
      // "Book" needs every move so far to be book, like in the game review.
      const baseBook = explore.basePly !== null && game.moves.slice(0, explore.basePly).every((m) => m.analysis?.classification === "book");
      const bookSoFar = baseBook && exploreLine.moves.slice(0, i).every((m) => exploreCls[m.key]?.classification === "book");
      const prevMine = i > 0 ? exploreLine.moves[i - 1] : null;
      const prevGame = i === 0 && explore.basePly ? game.moves[explore.basePly - 1] : null;
      const prevA = prevMine ? exploreCls[prevMine.key] : prevGame?.analysis;
      const prev = prevMine ?? prevGame;
      move = {
        fenBefore: exploreLine.fens[i],
        uci: lastExplored.uci,
        bookSoFar,
        prev: prev && { to: prev.to, san: prev.san, winBefore: prevA?.winBefore, winAfter: prevA?.winAfter },
      };
    }
    const key = lastExplored?.key;
    let cancelled = false;
    let tries = 0;
    const run = () =>
      fetch("/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fen: exploreFen, move }) })
        .then((r) => r.json())
        .then((a) => {
          if (cancelled) return;
          // Another viewer's request took the engine; ask again.
          if (a.superseded) return void (tries++ < 5 && setTimeout(run, 400));
          if (a.error || a.failed) return;
          const { move: cls, ...pos } = a;
          setExploreAn((m) => ({ ...m, [exploreFen]: pos }));
          if (cls && key) setExploreCls((m) => ({ ...m, [key]: cls }));
        })
        .catch(() => {});
    const t = setTimeout(run, 120); // don't ask about every position while stepping fast
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [exploreFen, !!exploreA, lastExplored?.key, !!lastCls]);

  if (!game || !view || !material) return <div className="empty">Loading game…</div>;

  /** A move the viewer played on the board: extends their analysis (or starts one from the shown position). */
  const onUserMove = (from: string, to: string) => {
    let san: string;
    try {
      san = new Chess(view.fen).move({ from, to, promotion: "q" }).san;
    } catch {
      return;
    }
    if (explore) {
      if (explore.moves[explore.step] === san) return stepExplore(1); // same as the next move already in the line
      setExplore({ ...explore, moves: [...explore.moves.slice(0, explore.step), san], step: explore.step + 1 });
      return;
    }
    if (!calc && ply < total && game.moves[ply].san === san) return go(ply + 1); // the move the game actually went on with
    const preSans =
      calc && calcLine ? [...game.moves.slice(0, calc.ply - 1).map((m) => m.san), ...calcLine.san.slice(0, calc.step)] : game.moves.slice(0, ply).map((m) => m.san);
    setExplore({ baseFen: view.fen, preSans, basePly: calc ? null : ply, moves: [san], step: 1 });
    setCalc(null);
  };
  // Like the game view: the rating badge on the moved piece, and the engine's better move when there was one.
  const exploreBestUci = lastCls ? lastCls.bestUci : undefined;
  const boardView: BoardProps = explore
    ? {
        ...view,
        arrows:
          showBest && lastExplored && lastCls && exploreBestUci && exploreBestUci !== lastExplored.uci && !["book", "forced"].includes(lastCls.classification)
            ? [{ from: exploreBestUci.slice(0, 2), to: exploreBestUci.slice(2, 4), brush: "green" }]
            : [],
        badge: lastExplored && lastCls ? { square: lastExplored.to, c: lastCls.classification } : undefined,
      }
    : view;

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
  const evalScore = explore ? exploreA?.score : calc ? undefined : engineScoreAt(game, ply);
  const isLive = viewPly === null && !calc && !explore;
  const explorePrefixes = explore ? movePrefixes(explore.baseFen, explore.moves.length) : [];
  const exploreBest = exploreFen && exploreA?.pv.length ? pvToSan(exploreFen, exploreA.pv) : [];
  const calcMove = calc ? game.moves[calc.ply - 1] : null;
  const res = game.result || game.termination === "aborted" ? resultText(game) : null;

  return (
    <div className="game-page">
      <div className="board-col">
        <EvalBar score={evalScore} orientation={orientation} result={ply === total && !calc && !explore ? game.result : null} />
        <div className="board-stack">
          {bar(top)}
          <Board {...boardView} onUserMove={onUserMove} />
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
                🧠 {sideName(game, calcMove.color)}'s calculation · line {calc.line + 1} (move{" "}
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
        {explore && (
          <div className="calc-banner">
            <div className="head">
              <span>🔍 Your analysis · from move {movePrefixes(explore.baseFen, 1)[0].replace(/[.… ]+$/, "")}</span>
              <button className="icon-btn" onClick={() => setExplore(null)} title="Back to the game (Esc)">
                ✕
              </button>
            </div>
            <div className="calc-moves">
              {explore.moves.map((s, i) => {
                const cls = exploreLine && exploreCls[exploreLine.moves[i].key];
                return (
                  <span key={i} className={i + 1 === explore.step ? "on" : i + 1 > explore.step ? "future" : ""} onClick={() => setExplore({ ...explore, step: i + 1 })}>
                    {explorePrefixes[i]}
                    {s}
                    {cls && <ClassIcon c={cls.classification} size={14} />}
                  </span>
                );
              })}
            </div>
            {lastExplored && lastCls && (
              <div className="explore-verdict" style={{ color: CLASS_META[lastCls.classification].color }}>
                <ClassIcon c={lastCls.classification} size={18} />
                <span>
                  {lastExplored.san} is {VERDICT[lastCls.classification]}
                  {lastCls.bestSan && lastCls.bestUci !== lastExplored.uci && !["book", "forced"].includes(lastCls.classification) && (
                    <span className="muted"> · best was {lastCls.bestSan}</span>
                  )}
                </span>
              </div>
            )}
            <div className="explore-engine">
              {exploreA ? (
                <>
                  <span className={`eval-chip engine ${scoreToCp(exploreA.score) < 0 ? "neg" : ""}`}>{formatScore(exploreA.score)}</span>
                  {exploreBest.length > 0 ? (
                    <span className="explore-pv" title={`Stockfish, depth ${exploreA.depth}`}>
                      {movePrefixes(exploreFen!, exploreBest.length).map((p, i) => p + exploreBest[i]).join(" ")}
                    </span>
                  ) : (
                    <span className="explore-pv">Game over</span>
                  )}
                </>
              ) : (
                <span className="explore-pv">Engine thinking…</span>
              )}
            </div>
            <div className="calc-controls">
              <button className="btn" onClick={() => setExplore({ ...explore, step: 0 })} title="Start of your line">
                ⏮
              </button>
              <button className="btn" onClick={() => stepExplore(-1)} title="Back (←)">
                ◀
              </button>
              <button className="btn" onClick={() => stepExplore(1)} title="Forward (→)">
                ▶
              </button>
              <button className="btn green" onClick={() => setExplore(null)} title="Esc">
                Back to game
              </button>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
                {explore.step}/{explore.moves.length}
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
            <ThinkingFeed game={game} ply={ply} calc={calc} onSelect={go} onPlayLine={(p, line) => (setExplore(null), setCalc({ ply: p, line, step: 0, playing: true }))} />
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
          {game.phase === "finished" && (
            <a className="icon-btn" href={`#/video/${game.id}`} title="Video replay (YouTube / TikTok)">
              🎬
            </a>
          )}
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
