import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Classification } from "../../../shared/types";
import type { RatingSeries } from "../../../shared/analytics";
import { CLASS_META } from "./ClassIcon";

/*
 * The Agents tab's charts: plain SVG, sized to their card, with a hover tooltip on every mark. Series
 * colours are three validated categorical slots (blue, orange, aqua) on the panel surface; text stays in
 * the page's ink, never the series colour.
 */

export const SERIES = ["#3987e5", "#d95926", "#199e70"];
const GRID = "#3c3a37";
const AXIS = "#4b4847";
const MUTED = "#989795";
const SURFACE = "#262522";

export const fmtMs = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return "–";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
};
export const fmtNum = (x: number | null | undefined, digits = 1, suffix = "") => (x === null || x === undefined ? "–" : `${x.toFixed(digits)}${suffix}`);
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The element's width, kept up to date. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

/** A chart's box: measures its width and floats the tooltip over it. */
function Frame({ height, children, tip }: { height: number; children: (w: number) => ReactNode; tip: Tip | null }) {
  const [ref, w] = useWidth();
  return (
    <div ref={ref} className="viz" style={{ height }}>
      {w > 0 && children(w)}
      {tip && (
        <div className="viz-tip" style={{ left: Math.min(Math.max(tip.x, 70), w - 70), top: tip.y }}>
          {tip.content}
        </div>
      )}
    </div>
  );
}

const ticks = (lo: number, hi: number, count = 4) => {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};

/* ------------------------------ rating over time ------------------------------ */

export function RatingChart({ series, name }: { series: RatingSeries[]; name: (s: RatingSeries) => string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  // Up to three players get a line (most games first); the colour follows the player, not its rank.
  const shown = series.filter((s) => s.points.length > 0).slice(0, 3);
  const all = shown.flatMap((s) => s.points);
  if (!all.length) return <div className="viz-empty">No rated games yet.</div>;
  const main = shown[0];
  const H = 230;
  const pad = { l: 44, r: 16, t: 14, b: 26 };
  // Games are spaced evenly in the order they ended: days without games would otherwise leave long flat gaps.
  const order = [...new Set(all.map((p) => p.ts))].sort((a, b) => a - b);
  const slot = new Map(order.map((ts, i) => [ts, i]));
  const t0 = order[0];
  const t1 = order[order.length - 1];
  const lo = Math.min(...all.map((p) => p.rating), ...main.points.map((p) => p.rating - p.rd * 0.5));
  const hi = Math.max(...all.map((p) => p.rating), ...main.points.map((p) => p.rating + p.rd * 0.5));
  const yLo = Math.floor((lo - 20) / 50) * 50;
  const yHi = Math.ceil((hi + 20) / 50) * 50;
  const best = main.points.reduce((a, p) => (p.rating > a.rating ? p : a));
  return (
    <>
      <Frame height={H} tip={tip}>
        {(W) => {
          const x = (ts: number) => pad.l + (order.length === 1 ? (W - pad.l - pad.r) / 2 : (slot.get(ts)! / (order.length - 1)) * (W - pad.l - pad.r));
          const y = (r: number) => pad.t + (1 - (r - yLo) / (yHi - yLo)) * (H - pad.t - pad.b);
          const pts = shown.flatMap((s, si) => s.points.map((p) => ({ s, si, p, px: x(p.ts), py: y(p.rating) })));
          const band =
            main.points.map((p, i) => `${i ? "L" : "M"}${x(p.ts)},${y(p.rating + p.rd * 0.5)}`).join("") +
            [...main.points]
              .reverse()
              .map((p) => `L${x(p.ts)},${y(p.rating - p.rd * 0.5)}`)
              .join("") +
            "Z";
          const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            const mx = e.clientX - r.left;
            const my = e.clientY - r.top;
            const near = pts.reduce((a, q) => (Math.hypot(q.px - mx, q.py - my) < Math.hypot(a.px - mx, a.py - my) ? q : a));
            setTip({
              x: near.px,
              y: near.py - 12,
              content: (
                <>
                  <b>
                    {near.p.rating} <span className="muted">± {near.p.rd}</span>
                  </b>
                  <div>
                    {near.p.result === "W" ? "Beat" : near.p.result === "L" ? "Lost to" : "Drew with"} {near.p.opponent}
                  </div>
                  <div className="muted">
                    {name(near.s)} · {fmtDate(near.p.ts)}
                  </div>
                </>
              ),
            });
          };
          const nearestGame = (e: React.MouseEvent<SVGSVGElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            const near = pts.reduce((a, q) =>
              Math.hypot(q.px - (e.clientX - r.left), q.py - (e.clientY - r.top)) < Math.hypot(a.px - (e.clientX - r.left), a.py - (e.clientY - r.top)) ? q : a,
            );
            location.hash = `#/game/${near.p.gameId}`;
          };
          return (
            <svg width={W} height={H} onPointerMove={onMove} onPointerLeave={() => setTip(null)} onClick={nearestGame} style={{ cursor: "pointer" }}>
              {ticks(yLo, yHi).map((v) => (
                <g key={v}>
                  <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={GRID} />
                  <text x={pad.l - 8} y={y(v)} className="viz-axis" textAnchor="end" dominantBaseline="middle">
                    {v}
                  </text>
                </g>
              ))}
              <text x={pad.l} y={H - 6} className="viz-axis">
                {fmtDate(t0)}
              </text>
              <text x={W - pad.r} y={H - 6} className="viz-axis" textAnchor="end">
                {fmtDate(t1)}
              </text>
              {main.points.length > 1 && <path d={band} fill={SERIES[0]} opacity={0.12} />}
              {shown.map((s, si) => (
                <polyline
                  key={`${s.variant}:${s.playerId}`}
                  points={s.points.map((p) => `${x(p.ts)},${y(p.rating)}`).join(" ")}
                  fill="none"
                  stroke={SERIES[si]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              ))}
              {pts.map((q) => (
                <circle key={`${q.s.variant}:${q.s.playerId}-${q.p.gameId}`} cx={q.px} cy={q.py} r={4} fill={SERIES[q.si]} stroke={SURFACE} strokeWidth={2} />
              ))}
              {main.points.length > 1 && (
                <text x={x(best.ts)} y={y(best.rating) - 10} className="viz-label" textAnchor={x(best.ts) > W - pad.r - 40 ? "end" : x(best.ts) < pad.l + 40 ? "start" : "middle"}>
                  best {best.rating}
                </text>
              )}
            </svg>
          );
        }}
      </Frame>
      <div className="viz-legend">
        {shown.map((s, si) => (
          <span key={`${s.variant}:${s.playerId}`}>
            <i style={{ background: SERIES[si] }} />
            {name(s)} · {s.current} ({s.games} game{s.games === 1 ? "" : "s"})
          </span>
        ))}
        {main.points.length > 1 && (
          <span>
            <i style={{ background: SERIES[0], opacity: 0.3, height: 8 }} />
            uncertainty (½ RD)
          </span>
        )}
        {series.length > shown.length && <span className="muted">+{series.length - shown.length} with fewer games</span>}
      </div>
    </>
  );
}

/* ------------------------------ verdict mix ------------------------------ */

const MIX: Classification[] = ["brilliant", "great", "best", "excellent", "good", "inaccuracy", "mistake", "miss", "blunder"];

export function VerdictMix({ rows }: { rows: { label: string; counts: Partial<Record<Classification, number>> }[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const H = rows.length * 46;
  return (
    <>
      <Frame height={H} tip={tip}>
        {(W) => {
          const labelW = 92;
          return (
            <svg width={W} height={H} onPointerLeave={() => setTip(null)}>
              {rows.map((row, ri) => {
                const total = MIX.reduce((a, c) => a + (row.counts[c] ?? 0), 0);
                let at = labelW;
                const span = W - labelW;
                const yy = ri * 46 + 10;
                return (
                  <g key={row.label}>
                    <text x={0} y={yy + 12} className="viz-label" dominantBaseline="middle">
                      {row.label}
                    </text>
                    {MIX.map((c) => {
                      const n = row.counts[c] ?? 0;
                      if (!n || !total) return null;
                      const w = (n / total) * span;
                      const x0 = at;
                      at += w;
                      const share = (n / total) * 100;
                      return (
                        <g
                          key={c}
                          onPointerMove={() =>
                            setTip({
                              x: x0 + w / 2,
                              y: yy - 4,
                              content: (
                                <>
                                  <b>{CLASS_META[c].label}</b>
                                  <div>
                                    {share.toFixed(1)}% · {n} moves
                                  </div>
                                </>
                              ),
                            })
                          }
                        >
                          <rect x={x0} y={yy} width={Math.max(0, w - 2)} height={24} rx={3} fill={CLASS_META[c].color} />
                          {w > 34 && (
                            <text x={x0 + w / 2 - 1} y={yy + 12} className="viz-in" textAnchor="middle" dominantBaseline="middle">
                              {Math.round(share)}%
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </svg>
          );
        }}
      </Frame>
      <div className="viz-legend">
        {MIX.map((c) => (
          <span key={c}>
            <i style={{ background: CLASS_META[c].color, height: 8, width: 8, borderRadius: 2 }} />
            {CLASS_META[c].label}
          </span>
        ))}
      </div>
    </>
  );
}

/* ------------------------------ bar rows ------------------------------ */

export interface BarRow {
  label: ReactNode;
  value: number | null;
  display: ReactNode;
  /** A thin tick on the bar (e.g. the median beside an average). */
  tick?: number | null;
  sub?: ReactNode;
  faded?: boolean;
}

/** Labelled horizontal bars on one scale: the plainest way to compare a handful of numbers. */
export function Bars({ rows, max, color = SERIES[0], tickLabel }: { rows: BarRow[]; max?: number; color?: string; tickLabel?: string }) {
  const top = max ?? Math.max(1, ...rows.flatMap((r) => [r.value ?? 0, r.tick ?? 0]));
  return (
    <div className="bars">
      {rows.map((r, i) => (
        <div key={i} className={`bar-row ${r.faded ? "faded" : ""}`}>
          <div className="bar-label">
            {r.label}
            {r.sub && <div className="bar-sub">{r.sub}</div>}
          </div>
          <div className="bar-track">
            {r.value !== null && <div className="bar-fill" style={{ width: `${Math.max(0.5, (r.value / top) * 100)}%`, background: color }} />}
            {r.tick !== null && r.tick !== undefined && <div className="bar-tick" style={{ left: `${(r.tick / top) * 100}%` }} title={tickLabel} />}
          </div>
          <div className="bar-value">{r.display}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ calibration ------------------------------ */

export function CalibrationChart({ curve }: { curve: { bin: number; n: number; self: number; engine: number }[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  if (!curve.length) return <div className="viz-empty">No moves with its own evaluation yet.</div>;
  const H = 260;
  const pad = { l: 40, r: 14, t: 12, b: 34 };
  const maxN = Math.max(...curve.map((c) => c.n));
  return (
    <Frame height={H} tip={tip}>
      {(W0) => {
        const side = Math.min(W0 - pad.l - pad.r, H - pad.t - pad.b);
        const ox = pad.l + (W0 - pad.l - pad.r - side) / 2;
        const x = (v: number) => ox + (v / 100) * side;
        const y = (v: number) => pad.t + (1 - v / 100) * side;
        return (
          <svg width={W0} height={H} onPointerLeave={() => setTip(null)}>
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <line x1={x(0)} x2={x(100)} y1={y(v)} y2={y(v)} stroke={GRID} />
                <line x1={x(v)} x2={x(v)} y1={y(0)} y2={y(100)} stroke={GRID} />
                <text x={x(0) - 6} y={y(v)} className="viz-axis" textAnchor="end" dominantBaseline="middle">
                  {v}
                </text>
                <text x={x(v)} y={y(0) + 14} className="viz-axis" textAnchor="middle">
                  {v}
                </text>
              </g>
            ))}
            <line x1={x(0)} y1={y(0)} x2={x(100)} y2={y(100)} stroke={AXIS} strokeWidth={1.5} />
            <text x={x(97)} y={y(4)} className="viz-axis" textAnchor="end">
              overconfident ↘
            </text>
            <text x={x(3)} y={y(94)} className="viz-axis">
              ↖ underconfident
            </text>
            <text x={x(50)} y={H - 4} className="viz-axis" textAnchor="middle">
              its own winning chances (%)
            </text>
            <text transform={`translate(10 ${y(50)}) rotate(-90)`} className="viz-axis" textAnchor="middle">
              engine's (%)
            </text>
            <polyline points={curve.map((c) => `${x(c.self)},${y(c.engine)}`).join(" ")} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" />
            {curve.map((c) => (
              <g
                key={c.bin}
                onPointerMove={() =>
                  setTip({
                    x: x(c.self),
                    y: y(c.engine) - 14,
                    content: (
                      <>
                        <b>Said {c.self.toFixed(0)}%</b>
                        <div>Engine: {c.engine.toFixed(0)}%</div>
                        <div className="muted">{c.n} moves</div>
                      </>
                    ),
                  })
                }
              >
                <circle cx={x(c.self)} cy={y(c.engine)} r={14} fill="transparent" />
                <circle cx={x(c.self)} cy={y(c.engine)} r={4 + 6 * Math.sqrt(c.n / maxN)} fill={SERIES[0]} stroke={SURFACE} strokeWidth={2} />
              </g>
            ))}
          </svg>
        );
      }}
    </Frame>
  );
}

/* ------------------------------ comparison scatter ------------------------------ */

export function ModelScatter({ points }: { points: { id: string; label: string; x: number; y: number; color: string; faded?: boolean }[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  if (points.length < 2) return null;
  const H = 280;
  const pad = { l: 48, r: 24, t: 16, b: 34 };
  const xLo = Math.floor((Math.min(...points.map((p) => p.x)) - 2) / 5) * 5;
  const xHi = Math.ceil((Math.max(...points.map((p) => p.x)) + 2) / 5) * 5;
  const yLo = Math.floor((Math.min(...points.map((p) => p.y)) - 30) / 50) * 50;
  const yHi = Math.ceil((Math.max(...points.map((p) => p.y)) + 30) / 50) * 50;
  return (
    <Frame height={H} tip={tip}>
      {(W) => {
        const x = (v: number) => pad.l + ((v - xLo) / (xHi - xLo)) * (W - pad.l - pad.r);
        const y = (v: number) => pad.t + (1 - (v - yLo) / (yHi - yLo)) * (H - pad.t - pad.b);
        // Labels sit right of their dot (left near the edge) and step down past any label they'd overlap.
        const placed: { x0: number; x1: number; y: number }[] = [];
        const labels = new Map<string, { x: number; y: number; anchor: "start" | "end" }>();
        for (const p of [...points].sort((a, b) => b.y - a.y)) {
          const right = x(p.x) <= W - 110;
          const width = p.label.length * 6.6;
          const lx = right ? x(p.x) + 10 : x(p.x) - 10;
          const x0 = right ? lx : lx - width;
          let ly = y(p.y);
          while (placed.some((q) => Math.abs(q.y - ly) < 14 && q.x0 < x0 + width && x0 < q.x1)) ly += 14;
          placed.push({ x0, x1: x0 + width, y: ly });
          labels.set(p.id, { x: lx, y: ly, anchor: right ? "start" : "end" });
        }
        return (
          <svg width={W} height={H} onPointerLeave={() => setTip(null)}>
            {ticks(yLo, yHi).map((v) => (
              <g key={`y${v}`}>
                <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={GRID} />
                <text x={pad.l - 8} y={y(v)} className="viz-axis" textAnchor="end" dominantBaseline="middle">
                  {v}
                </text>
              </g>
            ))}
            {ticks(xLo, xHi, 5).map((v) => (
              <text key={`x${v}`} x={x(v)} y={H - pad.b + 16} className="viz-axis" textAnchor="middle">
                {v}%
              </text>
            ))}
            <text x={(pad.l + W - pad.r) / 2} y={H - 4} className="viz-axis" textAnchor="middle">
              average accuracy
            </text>
            <text transform={`translate(12 ${(pad.t + H - pad.b) / 2}) rotate(-90)`} className="viz-axis" textAnchor="middle">
              rating
            </text>
            {points.map((p) => (
              <g
                key={p.id}
                opacity={p.faded ? 0.45 : 1}
                style={{ cursor: "pointer" }}
                onClick={() => (location.hash = `#/agents/${encodeURIComponent(p.id)}`)}
                onPointerMove={() =>
                  setTip({
                    x: x(p.x),
                    y: y(p.y) - 14,
                    content: (
                      <>
                        <b>{p.label}</b>
                        <div>
                          {p.y} rating · {p.x.toFixed(1)}% accuracy
                        </div>
                      </>
                    ),
                  })
                }
              >
                <circle cx={x(p.x)} cy={y(p.y)} r={14} fill="transparent" />
                <circle cx={x(p.x)} cy={y(p.y)} r={6} fill={p.color} stroke={SURFACE} strokeWidth={2} />
                <text x={labels.get(p.id)!.x} y={labels.get(p.id)!.y} className="viz-label" dominantBaseline="middle" textAnchor={labels.get(p.id)!.anchor}>
                  {p.label}
                </text>
              </g>
            ))}
          </svg>
        );
      }}
    </Frame>
  );
}
