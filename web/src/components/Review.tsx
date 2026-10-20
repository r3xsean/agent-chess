import type { Color, Game, Score } from "../../../shared/types";
import { winPercentWhite } from "../../../shared/evalmath";
import { engineAfter } from "../../../shared/belief";
import { selfEvalColors, sideName } from "../../../shared/naming";
import { sideLooks } from "../../../shared/looks";
import { PlayerAvatar } from "./PlayerName";
import { CLASS_META, CLASS_ORDER, ClassIcon } from "./ClassIcon";

/** Engine score for a ply, or undefined while pending / if the engine failed (never a made-up 0.00). */
export function engineScoreAt(game: Game, ply: number): Score | undefined {
  const pos = (fen: string | undefined) => {
    const a = fen ? game.analysis[fen] : undefined;
    return a && !a.failed && a.depth > 0 ? a.score : undefined;
  };
  if (ply === 0) return pos(game.moves[0]?.fenBefore ?? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  const m = game.moves[ply - 1];
  // Same rule as shared/belief's engineAfter: a verdict made without engine data carries a placeholder score.
  return m && engineAfter(game, m);
}

export function EvalGraph({ game, ply, onSelect, height = 110 }: { game: Game; ply: number; onSelect: (p: number) => void; height?: number }) {
  const W = 400;
  const H = height;
  const n = Math.max(game.moves.length, 1);
  const x = (p: number) => (p / n) * W;
  const y = (win: number) => H - (win / 100) * H;
  const pts: [number, number][] = [];
  let last = 50;
  for (let p = 0; p <= game.moves.length; p++) {
    const s = engineScoreAt(game, p);
    if (s) last = winPercentWhite(s);
    pts.push([x(p), y(last)]);
  }
  const area = `M0,${H} ` + pts.map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`).join(" ") + ` L${W},${H} Z`;
  const selfLine = (c: Color) => {
    const sp = game.moves
      .filter((m) => m.color === c && m.selfEval !== null)
      .map((m) => [x(m.ply), y(winPercentWhite({ cp: m.selfEval! * 100 }))] as [number, number]);
    return sp;
  };
  const selfColors = selfEvalColors(game);
  const notable = game.moves.filter((m) => m.analysis && ["brilliant", "great", "blunder", "mistake", "miss", "inaccuracy"].includes(m.analysis.classification));

  return (
    <svg
      className="graph"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height: H }}
      onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        onSelect(Math.round(((e.clientX - r.left) / r.width) * n));
      }}
    >
      <path d={area} fill="#ffffff" />
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="#8b8987" strokeWidth="0.6" strokeDasharray="3 3" />
      {(["w", "b"] as Color[]).map((c) => {
        const sp = selfLine(c);
        if (sp.length < 1) return null;
        return (
          <g key={c}>
            <polyline points={sp.map(([a, b]) => `${a},${b}`).join(" ")} fill="none" stroke={selfColors[c]} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
            {sp.map(([a, b], i) => (
              <circle key={i} cx={a} cy={b} r="1.8" fill={selfColors[c]} />
            ))}
          </g>
        );
      })}
      {notable.map((m) => (
        <circle key={m.ply} cx={x(m.ply)} cy={pts[m.ply][1]} r="3.2" fill={CLASS_META[m.analysis!.classification].color} stroke="#262421" strokeWidth="0.8" />
      ))}
      <line x1={x(ply)} x2={x(ply)} y1="0" y2={H} stroke="#81b64c" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Review({ game, ply, onSelect, ratings }: { game: Game; ply: number; onSelect: (p: number) => void; ratings: Record<Color, number | undefined> }) {
  const rv = game.review;
  const counts = (c: Color, k: string) => game.moves.filter((m) => m.color === c && m.analysis?.classification === k).length;
  const selfColors = selfEvalColors(game);
  const pending = game.moves.filter((m) => !m.analysis && !game.analysis[m.fenAfter]?.failed && !game.analysis[m.fenBefore]?.failed).length;
  const failed = game.moves.length - pending - game.moves.filter((m) => m.analysis).length;
  return (
    <div className="review">
      <div className="section-title">Evaluation</div>
      <EvalGraph game={game} ply={ply} onSelect={onSelect} />
      <div className="legend">
        <span>
          <i style={{ background: "#fff" }} />
          Engine (Stockfish)
        </span>
        {(["w", "b"] as Color[])
          .filter((c) => game.moves.some((m) => m.color === c && m.selfEval !== null))
          .map((c) => (
            <span key={c}>
              <i style={{ background: selfColors[c] }} />
              {sideName(game, c)}'s self-eval
            </span>
          ))}
      </div>
      {pending > 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>Engine is analyzing {pending} move(s)…</div>}
      {failed > 0 && (
        <div style={{ color: "var(--c-mistake)", fontSize: 13 }}>
          The engine couldn't analyze {failed} move(s); they're left out of the review and retried on the next server start.
        </div>
      )}

      <div className="review-players">
        <div />
        {(["w", "b"] as Color[]).map((c) => (
          <div className="hdr" key={c}>
            <PlayerAvatar player={c === "w" ? game.white : game.black} look={sideLooks(game)[c]} size={36} />
            {sideName(game, c)}
          </div>
        ))}
        <div className="lbl">Accuracy</div>
        {(["w", "b"] as Color[]).map((c) => (
          <div key={c} className={`acc-box ${c}`}>
            {rv?.[c].accuracy != null ? rv[c].accuracy!.toFixed(1) : "–"}
          </div>
        ))}
        <div className="lbl">Game rating</div>
        {(["w", "b"] as Color[]).map((c) => (
          <div key={c} className="val">
            {rv?.[c].estElo ?? "–"}
          </div>
        ))}
        <div className="lbl" title="Average gap between the player's own winning chances and Stockfish's, in percentage points">
          Self-eval error
        </div>
        {(["w", "b"] as Color[]).map((c) => (
          <div key={c} className="val" style={{ color: selfColors[c] }}>
            {rv?.[c].selfEvalError != null ? `±${rv[c].selfEvalError!.toFixed(1)}%` : "–"}
          </div>
        ))}
        <div className="lbl">Arena rating</div>
        {(["w", "b"] as Color[]).map((c) => (
          <div key={c} className="val" style={{ fontWeight: 600 }}>
            {ratings[c] ?? "–"}
            {game.ratingChange && (
              <span style={{ color: game.ratingChange[c] >= 0 ? "var(--green)" : "var(--c-blunder)", fontSize: 12 }}>
                {" "}
                {game.ratingChange[c] >= 0 ? "+" : ""}
                {game.ratingChange[c]}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="class-table">
        {CLASS_ORDER.map((k) => (
          <div className="row" key={k}>
            <span style={{ color: CLASS_META[k].color }}>{CLASS_META[k].label}</span>
            <span className="n" style={{ color: CLASS_META[k].color }}>
              {counts("w", k)}
            </span>
            <span className="ic">
              <ClassIcon c={k} />
            </span>
            <span className="n" style={{ color: CLASS_META[k].color }}>
              {counts("b", k)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
