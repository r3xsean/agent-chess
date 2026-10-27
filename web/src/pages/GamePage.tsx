import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentThinkMs } from "../../../shared/thinkingClock";
import { looseChess, newRules, START_FEN, variantOf, type Variant } from "../../../shared/rules";
import type { Classification, Color, Game, MoveAnalysis, PositionAnalysis } from "../../../shared/types";
import { ClassIcon, CLASS_META } from "../components/ClassIcon";
import { formatScore, scoreToCp, winPercentFor, winPercentWhite } from "../../../shared/evalmath";
import { humanSide, selfEvalColors, sideName } from "../../../shared/naming";
import { sideLooks } from "../../../shared/looks";
import { beliefs, judge, selfScore, standing } from "../../../shared/belief";
import { seatKey } from "../seat";
import { gameMaterialTimeline, materialTimeline } from "../../../shared/material";
import { explainIllegal, illegalMovePath, lineBreakReason, triesOf } from "../../../shared/explain";
import { api, useFetch, useMeta, useStream, type Leaderboards } from "../api";
import { CrowdPanel, useCrowd } from "../components/Crowd";
import { crowdApi, useViewer } from "../viewer";
import { RematchButton, SummonButton } from "../components/GameActions";
import { Board, type BoardProps } from "../components/Board";
import { EvalBar } from "../components/EvalBar";
import { PlayerBar } from "../components/PlayerBar";
import { PauseNotice } from "../components/PauseNotice";
import { ExperimentNote } from "../components/SetupChip";
import { isExperiment, seatSetup } from "../../../shared/seatSetup";
import { MoveList } from "../components/MoveList";
import { ThinkingFeed } from "../components/ThinkingFeed";
import { Interviews } from "../components/Interviews";
import { Review, engineScoreAt } from "../components/Review";
import { WhyCard, movePrefixes } from "../components/WhyCard";
import { explainMove, type EngineLine } from "../../../shared/why";
import { playMoveSound, playSfx, STING, useSfxToggle } from "../sfx";

type Tab = "moves" | "thinking" | "interviews" | "review" | "predict";
interface CalcState {
  ply: number;
  line: number;
  /** A line from this illegal attempt (tried in the same position) instead of from the move. */
  try?: number;
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
  /** Set while it's an engine line from the verdict card, not the viewer's own moves. */
  label?: string;
  /** Playing itself out, like an agent's calculation. */
  playing?: boolean;
}

function checkColor(fen: string): Color | false {
  const c = looseChess(fen);
  return c.inCheck() ? c.turn() : false;
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

function pvToSan(fen: string, pv: string[], variant: Variant, max = 10): string[] {
  const c = newRules(fen, variant);
  const out: string[] = [];
  for (const uci of pv.slice(0, max)) {
    try {
      out.push(c.move(uci).san);
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
  const variant = variantOf(game);
  const startFen = game?.startFen ?? START_FEN;
  const lobby = useFetch<Leaderboards>("/api/ratings", [game?.result]);
  const meta = useMeta();
  // Predictions live on the public mirror when there is one (so everyone shares a crowd), else here.
  const crowdBase = meta ? meta.crowdBase : null;
  const [viewer, setViewer] = useViewer(crowdBase);
  const crowd = useCrowd(crowdBase, id, viewer);
  const [guessing, setGuessing] = useState(false);
  const [engineOff, setEngineOff] = useState(false);
  const [viewPly, setViewPly] = useState<number | null>(null);
  /** On an illegal attempt made from the position after `ply` moves: which one (else the position itself). */
  const [viewTry, setViewTry] = useState<number | null>(null);
  const [orientation, setOrientation] = useState<Color>("w");
  const [tabState, setTab] = useState<Tab | null>(null);
  const [calc, setCalc] = useState<CalcState | null>(null);
  const [explore, setExplore] = useState<ExploreState | null>(null);
  const [exploreAn, setExploreAn] = useState<Record<string, PositionAnalysis>>({});
  /** Ratings of the viewer's moves, keyed by `${fenBefore}|${san}`. */
  const [exploreCls, setExploreCls] = useState<Record<string, MoveAnalysis>>({});
  const [showBest, setShowBest] = useState(true);
  const [now, setNow] = useState(Date.now());
  // Playing an agent yourself: this browser holds your seat's key.
  const human = game ? humanSide(game) : null;
  const myKey = useMemo(() => seatKey(id), [id]);
  const mine: Color | null = human && myKey ? human : null;
  // While you play, the engine and the agent's thinking stay hidden; all of it unlocks at the end.
  const hidden = !!mine && !!game && !game.result && game.termination !== "aborted";
  // The tab a game opens on, picked as soon as it arrives (before anything is drawn, so a finished game never
  // draws its whole thinking feed only to switch to the review): your own game on its moves, a reviewed
  // finished one on its review, any other on the thinking.
  if (game && tabState === null) setTab(hidden ? "moves" : game.phase === "finished" && game.review ? "review" : "thinking");
  const tab: Tab = tabState ?? "thinking";
  const sfx = useSfxToggle();
  const [offerDraw, setOfferDraw] = useState(false);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);
  const [playErr, setPlayErr] = useState("");
  /** Bumped to put the board back when a move of yours doesn't go through. */
  const [boardNonce, setBoardNonce] = useState(0);
  /** An illegal attempt that just came in live, shown on the board for a moment (from the position it was tried in). */
  const [flash, setFlash] = useState<{ fen: string; move: NonNullable<BoardProps["illegal"]> } | null>(null);

  // The clock only moves what's shown before and during play (thinking time, "Agent idle", "Summoned … ago"):
  // after that, nothing ticks, so a finished game's page sits still.
  const ticking = game?.phase === "pregame" || game?.phase === "playing";
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  useEffect(() => {
    if (game?.phase === "finished" && game.review && (tab === "thinking" || (mine && tab === "moves")) && viewPly === null) setTab("review");
  }, [game?.phase]);
  // Your own game opens from your side of the board, on the move list.
  const seated = useRef(false);
  useEffect(() => {
    if (!game || seated.current) return;
    seated.current = true;
    if (mine) setOrientation(mine);
    if (hidden) setTab("moves");
  }, [game]);

  const total = game?.moves.length ?? 0;
  const ply = viewPly === null ? total : Math.min(viewPly, total);
  // Event handlers can receive several presses before React commits. Advance from the
  // latest requested cursor so bursts don't drop moves or get stuck on an illegal try.
  const cursor = useRef({ ply, tryAt: viewTry });
  cursor.current = { ply, tryAt: viewTry };
  const go = useCallback((p: number) => {
    setCalc(null);
    setExplore(null);
    setViewTry(null);
    const clamped = Math.max(0, Math.min(total, p));
    cursor.current = { ply: clamped, tryAt: null };
    setViewPly(clamped >= total ? null : clamped);
  }, [total]);
  // Illegal attempts are steps of their own, between the position they were tried in and the move played
  // from it (the live position's attempts so far, too). Not while you play: they're part of the agent's thinking.
  const fenAt = (p: number) => (p ? game!.moves[p - 1].fenAfter : (game?.moves[0]?.fenBefore ?? startFen));
  const triesAt = (p: number): string[] =>
    !game || hidden || p < 0 ? [] : p < total ? game.moves[p].illegalAttempts : (game.pendingIllegal?.[fenAt(p).split(" ")[1] as Color] ?? []);
  const tryIdx = viewTry !== null && !calc && !explore && viewTry < triesAt(ply).length ? viewTry : null;
  /** Shows attempt j from the position after p moves (pinned there, even on the live position). */
  const showTry = useCallback((p: number, j: number) => {
    setCalc(null);
    setExplore(null);
    setViewPly(p);
    setViewTry(j);
    cursor.current = { ply: p, tryAt: j };
  }, []);
  const playLine = useCallback((p: number, line: number, attempt?: number) => {
    setExplore(null);
    setViewTry(null);
    setCalc({ ply: p, line, try: attempt, step: 0, playing: true });
  }, []);
  const startGuessing = useCallback((on: boolean) => {
    setGuessing(on);
    if (on) go(total);
  }, [go, total]);
  const step = (d: 1 | -1) => {
    const { ply, tryAt } = cursor.current;
    const tryIdx = tryAt !== null && tryAt < triesAt(ply).length ? tryAt : null;
    if (d > 0) {
      const next = tryIdx === null ? 0 : tryIdx + 1;
      if (next < triesAt(ply).length) return showTry(ply, next);
      // The last attempt on the latest position stays put (⏭ goes back to following the game).
      return ply < total ? go(ply + 1) : undefined;
    }
    if (tryIdx !== null) return tryIdx > 0 ? showTry(ply, tryIdx - 1) : go(ply);
    const back = triesAt(ply - 1);
    return back.length ? showTry(ply - 1, back.length - 1) : go(ply - 1);
  };
  const stepExplore = (d: number) => setExplore((x) => (x ? { ...x, playing: false, step: Math.max(0, Math.min(x.moves.length, x.step + d)) } : x));

  // keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])") || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.preventDefault();
      if (e.key === "ArrowLeft") explore ? stepExplore(-1) : calc ? stepCalc(-1) : step(-1);
      else if (e.key === "ArrowRight") explore ? stepExplore(1) : calc ? stepCalc(1) : step(1);
      else if (e.key === "Escape") (setCalc(null), setExplore(null));
      else if (e.key === "f") setOrientation((o) => (o === "w" ? "b" : "w"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Where the calculation on the board comes from: a move's lines, or an illegal attempt's (same position).
  const calcSrc = useMemo(() => {
    if (!calc || !game) return null;
    if (calc.try === undefined) return game.moves[calc.ply - 1] ?? null;
    const p = calc.ply - 1;
    const fen = fenAt(p);
    const color = fen.split(" ")[1] as Color;
    const m = game.moves[p];
    const t = (m ? triesOf(m.illegalAttempts, m.tries) : triesOf(game.pendingIllegal?.[color] ?? [], game.pendingTries?.[color]))[calc.try];
    return t ? { fenBefore: fen, lines: t.lines, color, ply: calc.ply } : null;
  }, [calc?.ply, calc?.try, game]);
  const calcLine = calc && calcSrc ? calcSrc.lines[calc.line] : null;
  // A line that breaks on an illegal move gets one more step: that move, played on the board anyway.
  const calcEnd = calcLine ? calcLine.san.length + (calcLine.brokenAt ? 1 : 0) : 0;
  const calcBroken = !!calc && !!calcLine && calc.step > calcLine.san.length;
  const stepCalc = (d: number) =>
    setCalc((c) => (c && calcLine ? { ...c, playing: false, step: Math.max(0, Math.min(calcEnd, c.step + d)) } : c));

  // calculation autoplay
  useEffect(() => {
    if (!calc?.playing || !calcLine) return;
    if (calc.step >= calcEnd) {
      setCalc({ ...calc, playing: false });
      return;
    }
    const t = setTimeout(() => setCalc((c) => (c ? { ...c, step: c.step + 1 } : c)), calc.step === 0 ? 500 : 950);
    return () => clearTimeout(t);
  }, [calc?.playing, calc?.step, calcLine]);

  // engine-line autoplay, at the same pace
  useEffect(() => {
    if (!explore?.playing) return;
    if (explore.step >= explore.moves.length) {
      setExplore({ ...explore, playing: false });
      return;
    }
    const t = setTimeout(() => setExplore((x) => (x?.playing ? { ...x, step: x.step + 1 } : x)), explore.step === 0 ? 500 : 950);
    return () => clearTimeout(t);
  }, [explore?.playing, explore?.step, explore?.moves.length]);

  // Every position and move of the viewer's line, worked out once.
  const exploreLine = useMemo(() => {
    if (!explore) return null;
    const c = newRules(explore.baseFen, variant);
    const fens = [c.fen()];
    const moves = explore.moves.map((san) => {
      const mv = c.move(san);
      fens.push(c.fen());
      return { san: mv.san, from: mv.from, to: mv.to, uci: mv.uci, key: `${mv.before}|${mv.san}` };
    });
    return { fens, moves };
  }, [explore?.baseFen, explore?.moves.join(" ")]);

  // The engine's case for the verdict on the move being viewed (recomputed as analysis arrives).
  const why = useMemo(() => (game && ply > 0 ? explainMove(game, ply - 1) : null), [game, ply]);

  const view = useMemo((): BoardProps | null => {
    if (!game) return null;
    if (explore && exploreLine) {
      const fen = exploreLine.fens[explore.step];
      const last = exploreLine.moves[explore.step - 1];
      return { fen, orientation, lastMove: last ? [last.from, last.to] : undefined, check: checkColor(fen) };
    }
    if (calc && calcLine && calcSrc) {
      const c = newRules(calcSrc.fenBefore, variant);
      let last: [string, string] | undefined;
      for (const san of calcLine.san.slice(0, calc.step)) {
        const mv = c.move(san);
        last = [mv.from, mv.to];
      }
      const arrows: BoardProps["arrows"] = [];
      const nextSan = calcLine.san[calc.step];
      const broken = calcLine.brokenAt && calc.step >= calcLine.san.length ? illegalMovePath(c.fen(), calcLine.brokenAt) : null;
      if (nextSan) {
        const mv = newRules(c.fen(), variant).move(nextSan);
        arrows.push({ from: mv.from, to: mv.to, brush: "blue" });
      } else if (broken && !calcBroken) arrows.push({ from: broken.from, to: broken.to, brush: "red" });
      return { fen: c.fen(), orientation, lastMove: last, check: checkColor(c.fen()), arrows, illegal: calcBroken && broken ? broken : undefined };
    }
    if (tryIdx !== null) {
      const fen = fenAt(ply);
      const prev = game.moves[ply - 1];
      return { fen, orientation, lastMove: prev && [prev.from, prev.to], check: checkColor(fen), illegal: illegalMovePath(fen, triesAt(ply)[tryIdx]) ?? undefined };
    }
    if (ply === 0) return { fen: game.moves[0]?.fenBefore ?? startFen, orientation };
    const m = game.moves[ply - 1];
    const a = m.analysis;
    const arrows: BoardProps["arrows"] = [];
    if (showBest && !hidden && a?.bestUci && a.bestUci !== m.uci && !["book", "forced"].includes(a.classification)) {
      arrows.push({ from: a.bestUci.slice(0, 2), to: a.bestUci.slice(2, 4), brush: "green" });
    }
    // After a move that went wrong, the reply that punishes it.
    if (showBest && !hidden && why?.kind === "bad" && why.after?.from && why.after.to) arrows.push({ from: why.after.from, to: why.after.to, brush: "red" });
    return {
      fen: m.fenAfter,
      orientation,
      lastMove: [m.from, m.to],
      check: checkColor(m.fenAfter),
      arrows,
      badge: a && !hidden ? { square: m.to, c: a.classification } : undefined,
    };
  }, [game, ply, tryIdx, calc, calcLine, explore, exploreLine, orientation, showBest, hidden, why]);

  // ---- sound effects ----
  // The move that put the board where it is, from whichever line is on screen.
  const shownMove = useMemo((): { san: string; before: string } | null => {
    if (!game) return null;
    if (explore && exploreLine) {
      const mv = exploreLine.moves[explore.step - 1];
      return mv ? { san: mv.san, before: exploreLine.fens[explore.step - 1] } : null;
    }
    if (calc && calcLine && calcSrc) {
      if (!calc.step || calcBroken) return null;
      const c = newRules(calcSrc.fenBefore, variant);
      for (const san of calcLine.san.slice(0, calc.step - 1)) c.move(san);
      const before = c.fen();
      return { san: c.move(calcLine.san[calc.step - 1]).san, before };
    }
    const m = game.moves[ply - 1];
    return m ? { san: m.san, before: m.fenBefore } : null;
  }, [view?.fen]);
  // A board sound when the position moves on by one move (live, arrow keys, lines, your own moves).
  const lastBoard = useRef<{ fen: string; before?: string } | null>(null);
  useEffect(() => {
    const fen = view?.fen;
    if (!fen) return;
    const prev = lastBoard.current;
    lastBoard.current = { fen, before: shownMove?.before };
    if (!prev || prev.fen === fen) return;
    if (shownMove && shownMove.before === prev.fen) playMoveSound(shownMove.san);
    else if (prev.before === fen) playSfx("move", 0.35);
  }, [view?.fen]);
  // A sting for the verdicts that matter: when you step onto the move, or when its verdict arrives live.
  const stingAt = explore ? 1000 + explore.step : calc ? -1 : ply;
  const stingCls = explore && exploreLine ? exploreCls[exploreLine.moves[explore.step - 1]?.key]?.classification : !calc ? game?.moves[ply - 1]?.analysis?.classification : undefined;
  const lastSting = useRef<{ at: number; cls?: string } | null>(null);
  useEffect(() => {
    const prev = lastSting.current;
    lastSting.current = { at: stingAt, cls: stingCls };
    const sting = !hidden && stingCls && STING[stingCls];
    if (!prev || !sting) return;
    if (stingAt === prev.at + 1 || (stingAt === prev.at && !prev.cls)) {
      const timer = setTimeout(() => playSfx(sting[0], sting[1]), 150);
      return () => clearTimeout(timer);
    }
  }, [stingAt, stingCls]);
  // The game's own events, as they happen.
  const liveEvents = useRef<{ illegal: number; draw: Color | null; result: string | null } | null>(null);
  useEffect(() => {
    if (!game) return;
    const illegal = game.moves.reduce((n, m) => n + m.illegalAttempts.length, 0) + (game.pendingIllegal?.w?.length ?? 0) + (game.pendingIllegal?.b?.length ?? 0);
    const prev = liveEvents.current;
    liveEvents.current = { illegal, draw: game.drawOffer, result: game.result };
    if (!prev) return;
    if (illegal > prev.illegal && !hidden) {
      playSfx("illegal", 0.7);
      // Watching live: the attempt is played on the board for a moment, then taken back.
      const fen = game.moves[game.moves.length - 1]?.fenAfter ?? startFen;
      const attempt = game.pendingIllegal?.[fen.split(" ")[1] as Color]?.at(-1);
      const move = attempt && illegalMovePath(fen, attempt);
      if (move && viewPly === null && !calc && !explore) setFlash({ fen, move });
    }
    if (game.drawOffer && !prev.draw) playSfx("draw", 0.7);
    if (game.result && !prev.result) {
      if (/resign/i.test(game.termination ?? "")) playSfx("resign", 0.8);
      if (game.result !== "1/2-1/2") setTimeout(() => playSfx("victory", 0.7), 700);
    }
  }, [game]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(t);
  }, [flash]);
  useEffect(() => {
    if (calcBroken) playSfx("illegal", 0.7);
  }, [calcBroken, calc?.ply, calc?.line]);
  useEffect(() => {
    if (tryIdx !== null) playSfx("illegal", 0.7);
  }, [tryIdx, ply]);
  const materialStart = game?.moves[0]?.fenBefore ?? startFen;
  const materialSans = explore ? [...explore.preSans, ...explore.moves]
    : calc && calcLine ? [...(game?.moves.slice(0, calc.ply - 1).map(m => m.san) ?? []), ...calcLine.san]
    : game?.moves.map(m => m.san) ?? [];
  const materialKey = materialSans.join(" ");
  // The game's own moves are read off the positions they record; a line off the game is replayed.
  const offGame = !!explore || !!(calc && calcLine);
  const materials = useMemo(
    () => (offGame || !game ? materialTimeline(materialStart, materialSans, variant) : gameMaterialTimeline(materialStart, game.moves)),
    [materialStart, materialKey, variant, offGame],
  );
  const materialPly = explore ? explore.preSans.length + explore.step
    : calc && calcLine ? calc.ply - 1 + Math.min(calc.step, calcLine.san.length) : ply;
  const material = materials[materialPly];
  // What each player believed after every move, against the engine (recomputed as analysis arrives).
  const beliefList = useMemo(() => (game ? beliefs(game) : []), [game]);

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
      fetch("/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fen: exploreFen, move, variant }) })
        .then((r) => r.json())
        .then((a) => {
          if (cancelled) return;
          // Another viewer's request took the engine; ask again.
          if (a.superseded) return void (tries++ < 5 && setTimeout(run, 400));
          if (a.offline) return void setEngineOff(true);
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

  // A Chess960 game shows its players' Chess960 ratings: the two are rated apart.
  const rating = (c: Color) => (variantOf(game) === "chess960" ? lobby?.players960 : lobby?.players)?.find((p) => p.id === (c === "w" ? game?.white : game?.black)?.id)?.rating;
  const [rw, rb] = [rating("w"), rating("b")];
  const ratings = useMemo(() => ({ w: rw, b: rb }), [rw, rb]);

  if (!game || !view || !material) return <div className="empty">Loading game…</div>;

  const turn: Color = ((game.moves[total - 1]?.fenAfter ?? startFen).split(" ")[1] as Color) ?? "w";
  const playing = game.phase === "playing";
  const isLive = viewPly === null && !calc && !explore;
  const agentSide: Color | null = human ? (human === "w" ? "b" : "w") : null;
  const myTurn = !!mine && playing && turn === mine;

  /** Your actions in your own game: a move, resigning, accepting a draw. */
  const act = async (body: Record<string, unknown>) => {
    setPlayErr("");
    try {
      await api(`/api/games/${game.id}/play`, { key: myKey, ...body });
    } catch (e) {
      setPlayErr(e instanceof Error ? e.message : String(e));
      setBoardNonce((n) => n + 1);
    }
  };
  const playMove = (uci: string) => {
    act({ action: "move", move: uci, offerDraw });
    setOfferDraw(false);
  };

  /** A move the viewer played on the board: extends their analysis (or starts one from the shown position). */
  const onUserMove = (from: string, to: string, promotion?: string) => {
    // Guessing the next move: the move becomes your prediction, and the board goes back to the game.
    if (guessing) {
      setGuessing(false);
      setBoardNonce((n) => n + 1);
      // The move this guess was for has already been played (or the desk hasn't caught up): drop it.
      if (!isLive || !viewer || crowdBase === null || crowd?.move.ply !== total + 1) return;
      crowdApi(crowdBase, `/api/games/${game.id}/predict`, { viewer: viewer.id, kind: "move", pick: from + to + (promotion ?? (newRules(view.fen, variant).moves().some((m) => m.from === from && m.promotion) ? "q" : "")) }).catch(
        (e) => setPlayErr(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    if (myTurn && isLive) {
      // A premove already knows its promotion piece (a queen, as on chess.com).
      if (promotion) return playMove(from + to + promotion);
      // Your move in your own game: ask which piece a pawn becomes, then send it.
      const promotes = newRules(view.fen, variant).moves().some((m) => m.from === from && m.to === to && m.promotion);
      return promotes ? setPromo({ from, to }) : playMove(from + to);
    }
    if (hidden) return; // no analysis board (and its engine) during your own game
    let san: string;
    try {
      san = newRules(view.fen, variant).move({ from, to, promotion: "q" }).san;
    } catch {
      return;
    }
    if (explore) {
      if (explore.moves[explore.step] === san) return stepExplore(1); // same as the next move already in the line
      // A different move turns an engine line into the viewer's own analysis.
      setExplore({ ...explore, moves: [...explore.moves.slice(0, explore.step), san], step: explore.step + 1, label: undefined, playing: false });
      return;
    }
    if (!calc && ply < total && game.moves[ply].san === san) return go(ply + 1); // the move the game actually went on with
    const preSans =
      calc && calcLine ? [...game.moves.slice(0, calc.ply - 1).map((m) => m.san), ...calcLine.san.slice(0, calc.step)] : game.moves.slice(0, ply).map((m) => m.san);
    setExplore({ baseFen: view.fen, preSans, basePly: calc ? null : ply, moves: [san], step: 1 });
    setCalc(null);
  };
  /** An engine line from the verdict card, on the board to step through (from the game position after basePly moves). */
  const playEngineLine = (line: EngineLine, basePly: number, label: string) => {
    setCalc(null);
    setExplore({ baseFen: line.fen, preSans: game.moves.slice(0, basePly).map((m) => m.san), basePly, moves: line.san, step: 0, label, playing: true });
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
  // A live attempt stays on the board only while the board still shows the position it was tried in.
  const illegalShown = view.illegal ?? (flash && isLive && flash.fen === view.fen ? flash.move : undefined);

  const thinkMs = (c: Color) =>
    game.moves.filter((m) => m.color === c).reduce((a, m) => a + m.thinkMs, 0) + (playing && turn === c ? currentThinkMs(game, now) : 0);
  const status = (c: Color) => {
    if (game.clockPause) return { text: "⏸ Paused", kind: "idle" as const };
    if (game.phase === "pregame") return game.interviews.pre[c] || c === human ? { text: "Ready", kind: "plain" as const } : { text: "In the interview", kind: "plain" as const };
    if (playing && turn === c && c === human) return { text: c === mine ? "Your move" : "Thinking", kind: "thinking" as const };
    if (playing && turn === c) {
      const seen = game.seen[c];
      if (!seen || now - seen > 150_000) return { text: "Agent idle", kind: "idle" as const };
      return { text: "Thinking", kind: "thinking" as const };
    }
    if (game.phase === "postgame") return { text: "Post-game", kind: "plain" as const };
    return null;
  };
  // Each player's latest own evaluation, set against the engine's view of the position on the board (the
  // same score the bar shows, so the mark, the shading and the pill always agree). Not while you play
  // (it would leak the engine), nor on a line off the game, where nobody's belief applies.
  const evalScore = explore ? exploreA?.score : calc ? undefined : engineScoreAt(game, ply);
  const selfColors = selfEvalColors(game);
  const latestBelief = (c: Color) => {
    if (hidden || explore || calc || !evalScore) return null;
    for (let i = ply - 1; i >= 0; i--) {
      const m = game.moves[i];
      if (m.color !== c) continue;
      const own = selfScore(m);
      if (!own) return null;
      const self = winPercentFor(own, c);
      const engine = winPercentFor(evalScore, c);
      // "Sees it now": it just came back in line with the engine, on the move it just played.
      const realizes = i === ply - 1 && beliefList[i]?.change === "realizes";
      return { m, own, self, engine, state: judge(self, engine), realizes };
    }
    return null;
  };
  const beliefPill = (c: Color): Parameters<typeof PlayerBar>[0]["belief"] => {
    const x = latestBelief(c);
    if (!x) return null;
    const own = formatScore(x.own);
    const title = `${sideName(game, c)}'s own evaluation after ${x.m.san}: ${own} (thinks it's ${standing(x.self)}). Engine, now: ${standing(x.engine)}.`;
    if (x.state) return { text: `💭 thinks: ${standing(x.self)} · engine: ${standing(x.engine)}`, kind: "off", color: selfColors[c], title };
    if (x.realizes) return { text: `💡 sees it now: ${standing(x.self)}`, kind: "real", color: selfColors[c], title };
    return { text: `💭 thinks ${own}`, kind: "plain", color: selfColors[c], title };
  };
  const beliefMarks = (["w", "b"] as Color[]).flatMap((c) => {
    const x = latestBelief(c);
    if (!x) return [];
    return [{ key: c, white: winPercentWhite(x.own), color: selfColors[c], misjudged: !!x.state, title: `${sideName(game, c)} thinks ${formatScore(x.own)}` }];
  });
  const top: Color = orientation === "w" ? "b" : "w";
  const bottom: Color = orientation;
  const bar = (c: Color) => (
    <PlayerBar
      player={c === "w" ? game.white : game.black}
      look={sideLooks(game)[c]}
      color={c}
      material={material}
      rating={rating(c)}
      variant={variantOf(game)}
      status={status(c)}
      belief={beliefPill(c)}
      clockMs={thinkMs(c)}
      active={playing && turn === c && !game.clockPause}
      setup={isExperiment(game) ? seatSetup(game, c) : undefined}
    />
  );
  const agentName = agentSide ? sideName(game, agentSide) : "";
  const hiddenNote = (what: string) => (
    <div className="empty">
      🙈 {what} hidden while you play — everything unlocks when the game ends, with the full engine review.
    </div>
  );
  const explorePrefixes = explore ? movePrefixes(explore.baseFen, explore.moves.length) : [];
  const exploreBest = exploreFen && exploreA?.pv.length ? pvToSan(exploreFen, exploreA.pv, variant) : [];
  const calcMove = calc ? calcSrc : null;
  const res = game.result || game.termination === "aborted" ? resultText(game) : null;

  return (
    <div className="game-page">
      <div className="board-col">
        <EvalBar score={evalScore} orientation={orientation} result={ply === total && !calc && !explore ? game.result : null} hidden={hidden} marks={beliefMarks} />
        <div className="board-stack">
          {bar(top)}
          <Board
            key={boardNonce}
            {...boardView}
            illegal={illegalShown}
            onUserMove={hidden && !(mine && playing && isLive) ? undefined : onUserMove}
            premoveColor={mine && playing && isLive ? mine : undefined}
            variant={variant}
          >
            {promo && mine && (
              <div className="promo-pick cg-wrap">
                {["queen", "rook", "bishop", "knight"].map((p) => (
                  <button
                    key={p}
                    title={p}
                    onClick={() => {
                      setPromo(null);
                      playMove(promo.from + promo.to + (p === "knight" ? "n" : p[0]));
                    }}
                  >
                    <piece className={`${p} ${mine === "w" ? "white" : "black"}`} />
                  </button>
                ))}
                <button
                  className="promo-cancel"
                  title="Cancel"
                  onClick={() => {
                    setPromo(null);
                    setBoardNonce((n) => n + 1);
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </Board>
          {bar(bottom)}
        </div>
      </div>

      <div className="side-panel">
        {game.clockPause && <PauseNotice pause={game.clockPause} game={game} />}
        {isExperiment(game) && <ExperimentNote game={game} />}
        <div className="tabs">
          {(
            [
              ["thinking", "🧠", "Thinking"],
              ["moves", "♟", "Moves"],
              ["interviews", "🎤", "Interviews"],
              ["review", "⭐", "Review"],
              ...(hidden || mine ? [] : [["predict", "🔮", "Predict"]]),
            ] as [Tab, string, string][]
          ).map(([k, ico, label]) => (
            <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
              <span className="t-ico">{ico}</span>
              {label}
              {k === "predict" && crowd?.open.result && !crowd.result.mine && <i className="tab-dot" title="Result calls are open" />}
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
            {/* A set opening is fairest played both ways round: one click sets up the other half of the pair. */}
            {game.result && game.setOpening && meta && !meta.publicMode && (
              <div className="row-actions" style={{ justifyContent: "center", marginTop: 8 }}>
                <RematchButton gameId={game.id} />
              </div>
            )}
          </div>
        )}
        {tryIdx !== null && (
          <div className="calc-banner try-banner">
            <div className="head">
              <span>
                ❌ {sideName(game, fenAt(ply).split(" ")[1] as Color)} tried <b>{triesAt(ply)[tryIdx]}</b>
                {triesAt(ply).length > 1 && <span className="muted"> · attempt {tryIdx + 1} of {triesAt(ply).length}</span>}
              </span>
              <button className="icon-btn" onClick={() => go(ply)} title="Back to the position">
                ✕
              </button>
            </div>
            <div className="try-why">Illegal: {explainIllegal(fenAt(ply), triesAt(ply)[tryIdx])}</div>
          </div>
        )}
        {!hidden && !calc && !explore && tryIdx === null && ply > 0 && (
          <WhyCard game={game} ply={ply} why={why} pending={raw?.moves[ply - 1]?.analysis?.unavailable ? "none" : "pending"} onPlay={playEngineLine} />
        )}
        {calc && calcLine && calcMove && (
          <div className="calc-banner">
            <div className="head">
              <span>
                🧠 {sideName(game, calcMove.color)}'s calculation · line {calc.line + 1} (move{" "}
                {Math.ceil(calcMove.ply / 2)}){calc.try !== undefined && <span className="muted"> · sent with the illegal {triesAt(calc.ply - 1)[calc.try]}</span>}
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
                <span
                  className={`broken ${calcBroken ? "on" : ""}`}
                  title="The line breaks here: this move is illegal in the calculated position"
                  onClick={() => setCalc({ ...calc, step: calcEnd, playing: false })}
                >
                  ✕ {calcLine.brokenAt} — illegal: {lineBreakReason(calcMove.fenBefore, calcLine, variant)}
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
                onClick={() => setCalc({ ...calc, playing: !calc.playing, step: calc.step >= calcEnd ? 0 : calc.step })}
              >
                {calc.playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <button className="btn" onClick={() => stepCalc(1)}>
                ▶
              </button>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
                {calc.step}/{calcEnd}
              </span>
            </div>
          </div>
        )}
        {explore && (
          <div className="calc-banner">
            <div className="head">
              <span>{explore.label ? `⚙️ ${explore.label}` : `🔍 Your analysis · from move ${movePrefixes(explore.baseFen, 1)[0].replace(/[.… ]+$/, "")}`}</span>
              <button className="icon-btn" onClick={() => setExplore(null)} title="Back to the game (Esc)">
                ✕
              </button>
            </div>
            <div className="calc-moves">
              {explore.moves.map((s, i) => {
                const cls = exploreLine && exploreCls[exploreLine.moves[i].key];
                return (
                  <span key={i} className={i + 1 === explore.step ? "on" : i + 1 > explore.step ? "future" : ""} onClick={() => setExplore({ ...explore, step: i + 1, playing: false })}>
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
                <span className="explore-pv">{engineOff ? "The engine is off on the public site — positions from the game still show their analysis." : "Engine thinking…"}</span>
              )}
            </div>
            <div className="calc-controls">
              <button className="btn" onClick={() => setExplore({ ...explore, step: 0, playing: false })} title="Start of the line">
                ⏮
              </button>
              <button className="btn" onClick={() => stepExplore(-1)} title="Back (←)">
                ◀
              </button>
              {explore.label && (
                <button
                  className="btn green"
                  onClick={() => setExplore({ ...explore, playing: !explore.playing, step: explore.step >= explore.moves.length ? 0 : explore.step })}
                >
                  {explore.playing ? "⏸ Pause" : "▶ Play"}
                </button>
              )}
              <button className="btn" onClick={() => stepExplore(1)} title="Forward (→)">
                ▶
              </button>
              <button className={`btn ${explore.label ? "" : "green"}`} onClick={() => setExplore(null)} title="Back to the game (Esc)">
                {explore.label ? "Back" : "Back to game"}
              </button>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
                {explore.step}/{explore.moves.length}
              </span>
            </div>
          </div>
        )}
        {mine && (game.phase === "pregame" || playing) && (
          <div className="play-panel">
            {game.phase === "pregame" ? (
              <div className="play-status">
                You're {mine === "w" ? "White" : "Black"} against {agentName}. The game starts once they've answered their pre-game interview.
              </div>
            ) : (
              <>
                <div className={`play-status ${myTurn ? "go" : ""}`}>
                  {myTurn ? "♟ Your move — drag a piece on the board" : `${agentName} is thinking… (you can premove)`}
                  {myTurn && !isLive && (
                    <button className="btn" onClick={() => go(total)}>
                      Back to the game ↩
                    </button>
                  )}
                </div>
                {myTurn && game.drawOffer === agentSide && (
                  <div className="play-offer">
                    🤝 {agentName} offers a draw.
                    <button className="btn green" onClick={() => act({ action: "accept-draw" })}>
                      Accept
                    </button>
                    <span className="muted">or play a move to decline</span>
                  </div>
                )}
                <div className="play-actions">
                  <button className={`btn ${offerDraw ? "green" : ""}`} disabled={!myTurn} onClick={() => setOfferDraw(!offerDraw)} title="Your offer goes with your next move">
                    🤝 {offerDraw ? "Offering a draw with your move" : "Offer draw"}
                  </button>
                  <button className="btn" onClick={() => confirm("Resign this game?") && act({ action: "resign" })}>
                    🏳️ Resign
                  </button>
                </div>
              </>
            )}
            {playErr && <div className="play-err">{playErr}</div>}
          </div>
        )}
        {game.phase === "pregame" && (["w", "b"] as Color[]).every((c) => c === human || !game.seen[c]) && (
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
          {tab === "moves" && (
            <>
              <MoveList game={game} ply={ply} tryAt={tryIdx} onSelect={go} onSelectTry={showTry} hideVerdicts={hidden} />
              {/* On a small phone the footer has no room for the PGN button, so it lives here. */}
              <a className="btn pgn-inline" href={`/api/games/${game.id}/pgn`}>
                ⤓ Download PGN
              </a>
            </>
          )}
          {tab === "thinking" &&
            (hidden ? (
              hiddenNote(`${agentName}'s thinking is`)
            ) : (
              <ThinkingFeed
                game={game}
                // Playing an attempt's calculation keeps that attempt's card selected.
                ply={calc?.try !== undefined ? calc.ply - 1 : ply}
                tryAt={calc?.try !== undefined ? calc.try : tryIdx}
                calc={calc} onSelect={go} onSelectTry={showTry} onPlayLine={playLine} />
            ))}
          {tab === "interviews" && <Interviews game={game} />}
          {tab === "review" && (hidden ? hiddenNote("The engine review is") : <Review game={game} ply={ply} onSelect={go} ratings={ratings} />)}
          {tab === "predict" && crowdBase !== null && (
            <CrowdPanel
              game={game}
              base={crowdBase}
              viewer={viewer}
              setViewer={setViewer}
              crowd={crowd}
              guessing={guessing}
              setGuessing={startGuessing}
            />
          )}
        </div>
        <div className="panel-footer">
          <div className="nav-btns">
            <button className="btn" onClick={() => go(0)} title="Start">
              ⏮
            </button>
            <button className="btn" onClick={() => step(-1)} title="Previous (←)">
              ◀
            </button>
            <button className="btn" onClick={() => step(1)} title="Next (→)">
              ▶
            </button>
            <button className="btn" onClick={() => go(total)} title="Latest">
              ⏭
            </button>
          </div>
          <button className="icon-btn" onClick={() => setOrientation((o) => (o === "w" ? "b" : "w"))} title="Flip board (f)">
            ⇅
          </button>
          {!hidden && (
            <button className={`icon-btn`} style={{ color: showBest ? "var(--green)" : undefined }} onClick={() => setShowBest(!showBest)} title="Show the engine's arrows (best move, and the reply that punishes a bad one)">
              ➚
            </button>
          )}
          <button className="icon-btn" onClick={sfx.toggle} title={sfx.on ? "Mute sound effects" : "Unmute sound effects"}>
            {sfx.on ? "🔔" : "🔕"}
          </button>
          <a className="icon-btn pgn-btn" href={`/api/games/${game.id}/pgn`} title="Download PGN">
            ⤓
          </a>
          {game.phase === "finished" && (
            <a className="icon-btn" href={`#/video/${game.id}`} title="Video replay (YouTube / TikTok)">
              🎬
            </a>
          )}
          {game.phase !== "finished" && (
            <span className="live-dot" style={{ opacity: isLive ? 1 : 0.4, cursor: "pointer", ...(game.clockPause ? { color: "var(--pause-color)" } : {}) }} onClick={() => go(total)}>
              {game.clockPause ? "⏸ PAUSED" : "● LIVE"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
