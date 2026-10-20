import { useState, type ReactNode } from "react";
import type { AgentRow, AnalyticsScope, ModelAnalytics, Outcome, RatingSeries, TimeStats } from "../../../shared/analytics";
import { useFetch } from "../api";
import { lookOf } from "../../../shared/looks";
import { PlayerAvatar, Var960 } from "../components/PlayerName";
import { Bars, CalibrationChart, ModelScatter, RatingChart, VerdictMix, fmtMs, fmtNum } from "../components/Charts";

/*
 * The Agents tab: every model side by side, and each model's analytics in five tabs. Stats resting on only
 * a few games are faded and marked, so a three-game streak doesn't read as a trend.
 */

const FEW_GAMES = 5;
const FEW_MOVES = 40;
const PROVISIONAL_RD = 110;

type Tab = "overview" | "thinking" | "mind" | "results" | "setup";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "thinking", label: "Thinking" },
  { id: "mind", label: "Mind" },
  { id: "results", label: "Results" },
  { id: "setup", label: "Setup" },
];

const hrefTo = (model: string, q: { tab?: Tab; scope?: AnalyticsScope }) => {
  const params = new URLSearchParams();
  if (q.tab && q.tab !== "overview") params.set("tab", q.tab);
  if (q.scope === "rated") params.set("scope", "rated");
  const s = params.toString();
  return `#/agents${model ? `/${encodeURIComponent(model)}` : ""}${s ? `?${s}` : ""}`;
};
const go = (model: string, q: { tab?: Tab; scope?: AnalyticsScope }) => (location.hash = hrefTo(model, q));

const ratio = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const outcomeWord: Record<Outcome, string> = { W: "Won", D: "Drew", L: "Lost" };

/* ------------------------------ building blocks ------------------------------ */

function Few({ n, unit = "game" }: { n: number; unit?: string }) {
  return (
    <span className="few" title="Too few to read much into yet">
      only {plural(n, unit)}
    </span>
  );
}

function Stat({ label, value, sub, hint, few }: { label: string; value: ReactNode; sub?: ReactNode; hint?: string; few?: boolean }) {
  return (
    <div className={`stat ${few ? "faded" : ""}`} title={hint}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function Panel({ title, hint, few, children, wide }: { title: string; hint?: ReactNode; few?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`card panel ${wide ? "wide" : ""}`}>
      <header>
        <h3>{title}</h3>
        {few}
      </header>
      {hint && <p className="panel-hint">{hint}</p>}
      {children}
    </section>
  );
}

function ScopeToggle({ scope, onChange }: { scope: AnalyticsScope; onChange: (s: AnalyticsScope) => void }) {
  return (
    <div className="seg" role="group" aria-label="Games counted">
      <button className={scope === "all" ? "on" : ""} onClick={() => onChange("all")}>
        All games
      </button>
      <button className={scope === "rated" ? "on" : ""} onClick={() => onChange("rated")}>
        Rated only
      </button>
    </div>
  );
}

function Pill({ r }: { r: Outcome }) {
  return <span className={`pill pill-${r}`}>{r}</span>;
}

const timeSub = (t: TimeStats) => (t.n ? `median ${fmtMs(t.medianMs)}` : undefined);

function ModelBadge({ label, provider, size = 40 }: { label: string; provider: string; size?: number }) {
  return <PlayerAvatar player={{ provider, modelLabel: label }} size={size} />;
}

const rowLook = (r: { provider: string; label: string }) => lookOf({ provider: r.provider, modelLabel: r.label });

/* ------------------------------ the comparison table ------------------------------ */

const CHESSCOM_HINT =
  "The Chess.com rapid rating it would plausibly hold (80% range): how it moves in standard games while the position is still open, set against how people play at each rating, blended with its arena rating. A rough guide: for a person, the move reading is typically about 300 points off. Needs about 5 standard games.";

type Col = { key: string; label: string; hint: string; get: (r: AgentRow) => number | null; show: (r: AgentRow) => ReactNode; lowerBetter?: boolean };

const COLS: Col[] = [
  {
    key: "rating",
    label: "Rating",
    hint: "Glicko-2 rating of its most-played player, from rated standard games",
    get: (r) => r.rating,
    show: (r) =>
      r.rating === null ? (
        "–"
      ) : (
        <>
          {r.rating}
          {(r.rd ?? 350) > PROVISIONAL_RD && "?"}
          <small className="muted"> ±{r.rd}</small>
        </>
      ),
  },
  {
    key: "rating960",
    label: "Chess960",
    hint: "Its Chess960 rating: rated apart from standard chess, from rated Chess960 games only",
    get: (r) => r.rating960 ?? null,
    show: (r) =>
      r.rating960 == null ? (
        "–"
      ) : (
        <>
          {r.rating960}
          {(r.rd960 ?? 350) > PROVISIONAL_RD && "?"}
          <Var960 />
        </>
      ),
  },
  { key: "score", label: "Score", hint: "Points per game: a win is 1, a draw ½", get: (r) => r.score, show: (r) => fmtNum(r.score, 0, "%") },
  { key: "accuracy", label: "Accuracy", hint: "Average game accuracy, as Lichess computes it", get: (r) => r.accuracy, show: (r) => fmtNum(r.accuracy, 1, "%") },
  {
    key: "chessCom",
    label: "Chess.com",
    hint: CHESSCOM_HINT,
    get: (r) => r.chessCom?.rating ?? null,
    show: (r) =>
      r.chessCom === null ? (
        "–"
      ) : (
        <>
          ≈{r.chessCom.rating}
          <small className="muted">
            {" "}
            {r.chessCom.low}–{r.chessCom.high}
          </small>
        </>
      ),
  },
  {
    key: "blunders",
    label: "Blunders",
    hint: "Blunders per 100 moves (book and forced moves left out)",
    get: (r) => r.blundersPer100,
    show: (r) => fmtNum(r.blundersPer100),
    lowerBetter: true,
  },
  { key: "illegal", label: "Illegal", hint: "Illegal move attempts per 100 moves", get: (r) => r.illegalPer100, show: (r) => fmtNum(r.illegalPer100), lowerBetter: true },
  {
    key: "calibration",
    label: "Self-eval gap",
    hint: "How far its own winning chances are from the engine's, on average (win-% points)",
    get: (r) => r.calibration,
    show: (r) => fmtNum(r.calibration, 1),
    lowerBetter: true,
  },
  { key: "think", label: "Avg think", hint: "Average time per move, every delay included", get: (r) => r.think.avgMs, show: (r) => fmtMs(r.think.avgMs), lowerBetter: true },
];

function Overview({ scope }: { scope: AnalyticsScope }) {
  const rows = useFetch<AgentRow[]>(`/api/analytics?scope=${scope}`, [scope]);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "rating", dir: -1 });
  if (!rows) return <div className="empty">Loading…</div>;
  if (!rows.length) return <div className="card empty">No agent has played yet.</div>;
  const col = COLS.find((c) => c.key === sort.key) ?? COLS[0];
  const sorted = [...rows].sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * sort.dir;
  });
  // The best value in each column (among models with enough games) is highlighted.
  const solid = rows.filter((r) => r.games >= FEW_GAMES);
  const bestOf = (c: Col) => {
    const vals = solid.map(c.get).filter((v): v is number => v !== null);
    return vals.length ? (c.lowerBetter ? Math.min(...vals) : Math.max(...vals)) : null;
  };
  const best = Object.fromEntries(COLS.map((c) => [c.key, bestOf(c)]));
  return (
    <>
      <div className="card">
        <table className="table compare">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Games</th>
              {COLS.map((c) => (
                <th key={c.key} className="num sortable" title={c.hint} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                  <button className="sort-btn" onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? (-sort.dir as 1 | -1) : c.lowerBetter ? 1 : -1 })}>
                    {c.label}
                    {sort.key === c.key && <span className="sort-mark">{sort.dir === 1 ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.model} className={`click ${r.games < FEW_GAMES ? "faded" : ""}`} onClick={() => go(r.model, { scope })}>
                <td>
                  <div className="pcell">
                    <ModelBadge label={r.label} provider={r.provider} size={28} />
                    <div>
                      <a className="nm" href={hrefTo(r.model, { scope })} onClick={(e) => e.stopPropagation()}>
                        {r.label}
                      </a>
                      <div className="md">{rowLook(r).makerName}</div>
                    </div>
                  </div>
                </td>
                <td className="num">{r.games}</td>
                {COLS.map((c) => (
                  <td key={c.key} className={`num ${r.games >= FEW_GAMES && c.get(r) !== null && c.get(r) === best[c.key] ? "best" : ""}`}>
                    {c.show(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="panel-hint" style={{ marginTop: 8 }}>
        Click a column to sort, a model to open its analytics. The best in each column is in green; models with under {FEW_GAMES} games are faded and not counted for it.
      </p>
      <div className="panels">
        <Panel
          title="Accuracy against rating"
          hint="Up and to the right is stronger. A model higher than others of the same accuracy wins more than its moves suggest; one lower plays well and still loses."
          wide
        >
          <ModelScatter
            points={rows
              .filter((r) => r.rating !== null && r.accuracy !== null)
              .map((r) => ({ id: r.model, label: r.label, x: r.accuracy!, y: r.rating!, color: rowLook(r).color, faded: r.games < FEW_GAMES }))}
          />
        </Panel>
      </div>
    </>
  );
}

/* ------------------------------ one model ------------------------------ */

// Standard and Chess960 ratings are separate series, never one line.
const seriesName = (s: RatingSeries) => `${cap(s.effort)} effort${s.variant === "chess960" ? " · Chess960" : ""}`;

function OverviewTab({ a }: { a: ModelAnalytics }) {
  const q = a.quality;
  const fewMoves = (n: number) => n < FEW_MOVES;
  return (
    <div className="panels">
      <Panel
        title="Rating over time"
        hint="Each dot is a rated game; click one to open it. Chess960 is rated apart, so its ratings are their own lines."
        wide
        few={a.ratingHistory[0] && a.ratingHistory[0].games < FEW_GAMES ? <Few n={a.ratingHistory[0].games} /> : undefined}
      >
        <RatingChart series={a.ratingHistory} name={seriesName} />
      </Panel>

      <Panel title="Form" hint="Its last ten games, oldest first, against its whole record.">
        <div className="form-pills">
          {a.form.last.map((f) => (
            <a key={f.gameId} href={`#/game/${f.gameId}`} title={`${outcomeWord[f.result]} against ${f.opponent}${f.accuracy !== null ? ` · ${f.accuracy}% accuracy` : ""}`}>
              <Pill r={f.result} />
            </a>
          ))}
        </div>
        <div className="stat-row">
          <Stat label="Last 10 score" value={fmtNum(a.form.scoreLast10, 0, "%")} sub={`overall ${fmtNum(a.row.score, 0, "%")}`} />
          <Stat label="Last 10 accuracy" value={fmtNum(a.form.accuracyLast10, 1, "%")} sub={`overall ${fmtNum(a.row.accuracy, 1, "%")}`} />
        </div>
      </Panel>

      <Panel title="As White and as Black" hint="Score, then accuracy, with each colour.">
        <div className="stat-row">
          {(["w", "b"] as const).map((c) => (
            <Stat
              key={c}
              label={c === "w" ? "♔ White" : "♚ Black"}
              value={fmtNum(q.byColor[c].score, 0, "%")}
              sub={`${fmtNum(q.byColor[c].accuracy, 1, "%")} accuracy · ${plural(q.byColor[c].games, "game")}`}
              few={q.byColor[c].games < FEW_GAMES}
            />
          ))}
        </div>
      </Panel>

      <Panel title="Move quality" hint="Every graded move (book and forced moves left out), against every model together." wide>
        <VerdictMix
          rows={[
            { label: a.row.label, counts: q.counts },
            { label: "All models", counts: q.field },
          ]}
        />
      </Panel>

      <Panel title="By phase" hint="Opening: still in book or up to move 12. Endgame: six or fewer pieces besides kings and pawns.">
        <Bars
          max={100}
          rows={(["opening", "middlegame", "endgame"] as const).map((ph) => ({
            label: cap(ph),
            value: q.phases[ph].accuracy,
            display: fmtNum(q.phases[ph].accuracy, 1, "%"),
            sub: `${fmtNum(q.phases[ph].blundersPer100)} blunders / 100`,
            faded: fewMoves(q.phases[ph].moves),
          }))}
        />
        <p className="panel-foot">Average move accuracy in each phase.</p>
      </Panel>

      <Panel
        title="Middlegame rating"
        hint="How its middlegame moves compare with how people of each rating play the middlegame, from moves alone (no results). Provisional: for a person it's typically about 260 points off."
      >
        <Bars
          max={2500}
          rows={[
            { label: "Overall", est: a.row.chessCom },
            { label: "Middlegame", est: q.phases.middlegame.chessCom },
          ].map(({ label, est }) => ({
            label,
            value: est?.rating ?? null,
            display: est ? `≈${est.rating}` : "–",
            sub: est ? `80% range ${est.low}–${est.high}` : "not enough moves yet",
            faded: !est,
          }))}
        />
        <p className="panel-foot">
          Chess.com rapid. The opening and endgame aren't rated: tested on real players, opening moves haven't yet shown a reliable range, and endgame moves guessed a person's rating worse than picking the average.
        </p>
      </Panel>

      <Panel title="Upsets" hint="Rated games against an opponent 100+ points apart.">
        <div className="stat-row">
          <Stat label="Beat a stronger player" value={a.upsets.wins} />
          <Stat label="Lost to a weaker one" value={a.upsets.losses} />
        </div>
        <GameLinks games={[...a.upsets.winsOver.map((g) => ({ ...g, tag: "upset win" })), ...a.upsets.lossesTo.map((g) => ({ ...g, tag: "upset loss" }))].slice(0, 6)} />
      </Panel>
    </div>
  );
}

function GameLinks({ games }: { games: { gameId: string; opponent: string; result: Outcome; tag?: string; accuracy?: number | null }[] }) {
  if (!games.length) return null;
  return (
    <ul className="game-links">
      {games.map((g) => (
        <li key={g.gameId + (g.tag ?? "")}>
          <a href={`#/game/${g.gameId}`}>
            <Pill r={g.result} /> vs {g.opponent}
            {g.tag && <span className="muted"> · {g.tag}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

function ThinkingTab({ a }: { a: ModelAnalytics }) {
  const t = a.thinking;
  const phases = (["opening", "middlegame", "endgame"] as const).map((ph) => ({ ph, think: a.quality.phases[ph].think }));
  const crit = t.critical;
  return (
    <div className="panels">
      <Panel title="Time per move" hint="From the opponent's move to its own, every delay included. Each side's first move is left out (it includes starting up).">
        <div className="stat-row">
          <Stat label="Average" value={fmtMs(t.overall.avgMs)} sub={`${t.overall.n} moves`} />
          <Stat label="Median" value={fmtMs(t.overall.medianMs)} sub="a typical move" />
        </div>
      </Panel>

      <Panel title="By phase" hint="Bars are the average; the white tick is the median.">
        <Bars
          tickLabel="median"
          rows={phases.map(({ ph, think }) => ({
            label: cap(ph),
            value: think.avgMs,
            tick: think.medianMs,
            display: fmtMs(think.avgMs),
            sub: timeSub(think),
            faded: think.n < FEW_MOVES,
          }))}
        />
      </Panel>

      <Panel
        title="Does thinking longer help?"
        hint="Its graded moves split into thirds by how long they took. Hard positions take longer, so slow moves tend to be the harder ones."
      >
        <Bars
          max={100}
          rows={t.buckets.map((b) => ({
            label: b.label,
            sub: `${fmtMs(b.minMs)} – ${fmtMs(b.maxMs)} · ${fmtNum(b.blundersPer100)} blunders / 100`,
            value: b.accuracy,
            display: fmtNum(b.accuracy, 1, "%"),
            faded: b.moves < FEW_MOVES,
          }))}
        />
        <p className="panel-foot">Move accuracy for each third.</p>
      </Panel>

      <Panel title="Time behind each kind of move" hint="Does it blunder by moving too fast, or by getting lost in thought?">
        <Bars
          tickLabel="median"
          color="#3987e5"
          rows={t.byVerdict.map((v) => ({
            label: v.label,
            value: v.think.avgMs,
            tick: v.think.medianMs,
            display: fmtMs(v.think.avgMs),
            sub: `${v.think.n} moves`,
            faded: v.think.n < 10,
          }))}
        />
      </Panel>

      <Panel
        title="When it matters"
        hint="Positions with one good move: the engine's best is at least 20 points of winning chances ahead of its second choice."
        few={crit.positions < 10 ? <Few n={crit.positions} unit="position" /> : undefined}
        wide
      >
        <div className="stat-row">
          <Stat label="Found the move" value={ratio(crit.found, crit.positions)} sub={`${crit.found} of ${crit.positions} positions`} />
          <Stat label="Time there" value={fmtMs(crit.think.avgMs)} sub={timeSub(crit.think)} />
          <Stat label="Time elsewhere" value={fmtMs(crit.normal.avgMs)} sub={timeSub(crit.normal)} />
        </div>
        <p className="panel-foot">
          {crit.think.avgMs && crit.normal.avgMs
            ? crit.think.avgMs > crit.normal.avgMs * 1.1
              ? "It slows down when the position is critical."
              : crit.think.avgMs < crit.normal.avgMs * 0.9
                ? "It moves faster in these positions than elsewhere. Many are obvious (a recapture, an escape from check), so the ones it misses say more than the time."
                : "It spends about the same time whether or not the position is critical."
            : ""}
        </p>
      </Panel>
    </div>
  );
}

function MindTab({ a }: { a: ModelAnalytics }) {
  const m = a.mind;
  const r = a.rules;
  const c = a.calc;
  const d = m.draws;
  return (
    <div className="panels">
      <Panel
        title="Does it know how it's doing?"
        hint="Every move it gives its own evaluation. Points on the diagonal mean its sense of the position matches the engine's."
        few={m.samples < FEW_MOVES ? <Few n={m.samples} unit="move" /> : undefined}
        wide
      >
        <div className="split">
          <CalibrationChart curve={m.curve} />
          <div className="stat-col">
            <Stat label="Average gap" value={fmtNum(m.calibration, 1)} sub="win-% points from the engine" />
            <Stat label="Overconfident" value={fmtNum(m.over, 1, "%")} sub="of moves: thought it far better than it was" />
            <Stat label="Underconfident" value={fmtNum(m.under, 1, "%")} sub="of moves: thought it far worse" />
          </div>
        </div>
      </Panel>

      <Panel title="Calculation" hint="The lines it writes out with each move, checked move by move." few={c.lines < 20 ? <Few n={c.lines} unit="line" /> : undefined}>
        <div className="stat-row">
          <Stat label="Legal lines" value={ratio(c.legalLines, c.lines)} sub={`${c.legalLines} of ${c.lines}`} />
          <Stat label="Claimed depth" value={fmtNum(c.avgClaimed)} sub="plies per line" />
          <Stat label="Breaks after" value={fmtNum(c.avgBeforeBreak)} sub="plies, when it breaks" />
        </div>
        <p className="panel-foot">
          {c.movesWithLines ? `${fmtNum(c.lines / c.movesWithLines)} lines per move.` : ""} A broken line has a move in it that isn't legal where it's played: the board in its head
          has drifted.
        </p>
      </Panel>

      <Panel title="Following the rules" hint="Moves it tried that weren't legal, and why.">
        <div className="stat-row">
          <Stat label="Illegal tries" value={fmtNum(a.row.illegalPer100)} sub="per 100 moves" />
          <Stat label="Per game" value={r.games ? fmtNum(r.attempts / r.games, 2) : "–"} sub={`${r.attempts} in all`} />
          <Stat label="Needed 3+ tries" value={r.movesWithRepeat} sub="moves" />
        </div>
        {r.kinds.length > 0 && (
          <Bars
            color="#d95926"
            rows={r.kinds.map((k) => ({
              label: k.label,
              value: k.count,
              display: k.count,
              sub: k.example ? (
                <a href={`#/game/${k.example.gameId}`}>
                  e.g. {k.example.tried} ({k.example.played ? `played ${k.example.played}` : "then resigned"})
                </a>
              ) : undefined,
            }))}
          />
        )}
      </Panel>

      <Panel title="Resigning" hint="Was the position really lost when it gave up? Lost: the engine gave it 15% or less.">
        <div className="stat-row">
          <Stat label="Resigned" value={m.resign.count} sub="games" />
          <Stat label="Truly lost" value={ratio(m.resign.justified, m.resign.count)} sub={`${m.resign.justified} of ${m.resign.count}`} />
          <Stat label="Chances left" value={fmtNum(m.resign.avgWin, 1, "%")} sub="on average, when it resigned" />
        </div>
        {m.resign.premature.length > 0 && (
          <ul className="game-links">
            {m.resign.premature.slice(0, 4).map((p) => (
              <li key={p.gameId}>
                <a href={`#/game/${p.gameId}`}>
                  Gave up with {p.win.toFixed(0)}% left vs {p.opponent}
                </a>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Draws" hint="Offers it made (and how it stood), and offers it was made.">
        <div className="stat-row">
          <Stat label="Offered" value={d.offered} sub={d.offered ? `${d.offeredWorse} worse · ${d.offeredLevel} level · ${d.offeredBetter} better` : "never"} />
          <Stat label="Accepted" value={ratio(d.accepted, d.received)} sub={`${d.accepted} of ${d.received} offers`} />
          <Stat label="Took a draw while better" value={d.acceptedBetter} sub="over 60% winning chances" />
        </div>
      </Panel>
    </div>
  );
}

const ENDING_ORDER = ["Checkmate", "Opponent resigned", "Got checkmated", "Resigned", "Agreed", "Repetition", "Stalemate", "Insufficient material", "50-move rule"];

function ResultsTab({ a }: { a: ModelAnalytics }) {
  const cv = a.conversion;
  const tc = a.tactics;
  const e = a.endings;
  const endRows = (rec: Record<string, number>) =>
    Object.entries(rec)
      .sort((x, y) => ENDING_ORDER.indexOf(x[0]) - ENDING_ORDER.indexOf(y[0]))
      .map(([k, n]) => ({ label: k, value: n, display: n }));
  const total = a.row.games || 1;
  return (
    <div className="panels">
      <Panel title="Converting and saving" hint="Winning: the engine gave it 80%+ at some point. Losing: 20% or less.">
        <div className="stat-row">
          <Stat label="Won from winning" value={ratio(cv.converted, cv.winning)} sub={`${cv.converted} of ${cv.winning} games`} few={cv.winning < FEW_GAMES} />
          <Stat label="Saved from losing" value={ratio(cv.saved, cv.losing)} sub={`${cv.saved} of ${cv.losing} games`} few={cv.losing < FEW_GAMES} />
        </div>
        {cv.blown.length > 0 && (
          <>
            <div className="mini-title">Wins it let slip</div>
            <ul className="game-links">
              {cv.blown.map((b) => (
                <li key={b.gameId}>
                  <a href={`#/game/${b.gameId}`}>
                    <Pill r={b.result} /> vs {b.opponent}: up to {b.peak.toFixed(0)}%, worst move {Math.ceil(b.ply / 2)}
                    {b.ply % 2 ? "." : "…"} {b.san}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Panel title="How its games end">
        <div className="ends">
          {(
            [
              ["Wins", e.wins, e.avgLength.W],
              ["Draws", e.draws, e.avgLength.D],
              ["Losses", e.losses, e.avgLength.L],
            ] as const
          ).map(([title, rec, len]) => (
            <div key={title}>
              <div className="mini-title">
                {title} <span className="muted">{len !== null ? `· ${len} moves on average` : ""}</span>
              </div>
              {Object.keys(rec).length ? <Bars max={total} rows={endRows(rec)} color="#3987e5" /> : <div className="muted small">none</div>}
            </div>
          ))}
        </div>
        {e.drawnFromWinning > 0 && <p className="panel-foot">⚠ {plural(e.drawnFromWinning, "draw")} came from a position it was winning (90%+ late in the game).</p>}
      </Panel>

      <Panel title="Tactics" hint="With a forced mate on the board, did its move keep it? And in positions with only one good move, did it find it?">
        <div className="stat-row">
          <Stat label="Forced mates kept" value={ratio(tc.matesFound, tc.mates)} sub={`${tc.matesFound} of ${tc.mates} moves with a mate on`} />
          <Stat label="Mate in one" value={ratio(tc.mateIn1Found, tc.mateIn1)} sub={`${tc.mateIn1Found} of ${tc.mateIn1} played`} />
          <Stat label="Only moves" value={ratio(tc.onlyFound, tc.onlyMoves)} sub={`${tc.onlyFound} of ${tc.onlyMoves} found`} />
        </div>
      </Panel>

      <Panel title="When it first cracks" hint="Its first mistake, miss or blunder of the game.">
        <div className="stat-row">
          <Stat label="First mistake" value={cv.firstMistake.avgMove === null ? "–" : `move ${Math.round(cv.firstMistake.avgMove)}`} sub="on average" />
          <Stat label="Clean games" value={cv.firstMistake.clean} sub={`of ${cv.firstMistake.games}: no mistake at all`} />
        </div>
      </Panel>

      <Panel title="Openings" hint="Standard games, by opening family. Chess960 games have no opening name." wide>
        <div className="split even">
          {(["w", "b"] as const).map((c) => (
            <div key={c}>
              <div className="mini-title">{c === "w" ? "As White" : "As Black"}</div>
              {a.openings[c].length ? (
                <div className="table-scroll">
                  <table className="table tight">
                    <thead>
                      <tr>
                        <th>Opening</th>
                        <th className="num">Games</th>
                        <th className="num">Score</th>
                        <th className="num">Accuracy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.openings[c].map((o) => (
                        <tr key={o.name}>
                          <td>{o.name}</td>
                          <td className="num">{o.games}</td>
                          <td className="num">{o.score.toFixed(0)}%</td>
                          <td className="num">{fmtNum(o.accuracy, 1, "%")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="muted small">No named openings yet.</div>
              )}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Head to head" hint="Against every other model, whatever effort either played at." wide>
        {a.h2h.length ? (
          <div className="table-scroll">
            <table className="table tight">
              <thead>
                <tr>
                  <th>Opponent</th>
                  <th className="num">Games</th>
                  <th className="num">W / D / L</th>
                  <th className="num">Score</th>
                  <th className="num">Its accuracy</th>
                  <th className="num">Theirs</th>
                </tr>
              </thead>
              <tbody>
                {a.h2h.map((h) => (
                  <tr key={h.model} className={h.model !== "human" ? "click" : ""} onClick={() => h.model !== "human" && go(h.model, {})}>
                    <td>
                      <div className="pcell">
                        <ModelBadge label={h.label} provider={h.provider} size={22} />
                        {h.model === "human" ? (
                          h.label
                        ) : (
                          <a href={hrefTo(h.model, {})} onClick={(e) => e.stopPropagation()}>
                            {h.label}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="num">{h.games}</td>
                    <td className="num">
                      {h.wins} / {h.draws} / {h.losses}
                    </td>
                    <td className="num">{(((h.wins + h.draws / 2) / h.games) * 100).toFixed(0)}%</td>
                    <td className="num">{fmtNum(h.myAccuracy, 1, "%")}</td>
                    <td className="num">{fmtNum(h.theirAccuracy, 1, "%")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted small">No games against other models yet.</div>
        )}
      </Panel>
    </div>
  );
}

function SetupTab({ a }: { a: ModelAnalytics }) {
  const s = a.setup;
  return (
    <div className="panels">
      <Panel title="Effort" hint="How hard the model is told to think. Each effort is its own player, with its own rating (click one for its games)." wide>
        {s.efforts.length ? (
          <div className="table-scroll">
            <table className="table tight">
              <thead>
                <tr>
                  <th>Effort</th>
                  <th className="num">Games</th>
                  <th className="num">Score</th>
                  <th className="num">Accuracy</th>
                  <th className="num">Avg think</th>
                  <th className="num">Rating</th>
                  <th className="num">Rated W/D/L</th>
                  <th className="num">Chess960</th>
                </tr>
              </thead>
              <tbody>
                {s.efforts.map((e) => {
                  const x = s.players.find((q) => q.effort === e.effort && (q.variant ?? "standard") === "standard");
                  const x960 = s.players.find((q) => q.effort === e.effort && q.variant === "chess960");
                  return (
                    <tr
                      key={e.effort}
                      className={`${x || x960 ? "click" : ""} ${e.games < FEW_GAMES ? "faded" : ""}`}
                      onClick={() => (x ?? x960) && (location.hash = `#/player/${encodeURIComponent((x ?? x960)!.playerId)}`)}
                    >
                      <td>{cap(e.effort)}</td>
                      <td className="num">{e.games}</td>
                      <td className="num">{fmtNum(e.score, 0, "%")}</td>
                      <td className="num">{fmtNum(e.accuracy, 1, "%")}</td>
                      <td className="num">{fmtMs(e.think.avgMs)}</td>
                      <td className="num">
                        {x ? (
                          <b>
                            {x.rating}
                            {x.rd > PROVISIONAL_RD && "?"}
                          </b>
                        ) : (
                          <span className="muted">·</span>
                        )}
                      </td>
                      <td className="num">{x ? `${x.record.wins}/${x.record.draws}/${x.record.losses}` : <span className="muted">·</span>}</td>
                      <td className="num" title="Chess960 rating and rated W/D/L (rated apart from standard)">
                        {x960 ? (
                          <>
                            <b>
                              {x960.rating}
                              {x960.rd > PROVISIONAL_RD && "?"}
                            </b>{" "}
                            <span className="muted">
                              {x960.record.wins}/{x960.record.draws}/{x960.record.losses}
                            </span>
                          </>
                        ) : (
                          <span className="muted">·</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted small">No games yet.</div>
        )}
      </Panel>
    </div>
  );
}

function ModelView({ model, tab, scope }: { model: string; tab: Tab; scope: AnalyticsScope }) {
  const a = useFetch<ModelAnalytics>(`/api/analytics/${encodeURIComponent(model)}?scope=${scope}`, [model, scope]);
  const rows = useFetch<AgentRow[]>(`/api/analytics?scope=${scope}`, [scope]);
  // Another model's numbers are never shown under this one's name; a scope switch dims the old ones until the new arrive.
  if (!a || a.row.model !== model) return <div className="empty">Loading…</div>;
  const r = a.row;
  const few = r.games < FEW_GAMES;
  return (
    <div style={{ opacity: a.scope === scope ? 1 : 0.55, transition: "opacity 0.15s" }}>
      <div className="model-head">
        <ModelBadge label={r.label} provider={r.provider} size={56} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{r.label}</h1>
          <div className="muted">
            {rowLook(r).makerName} · {plural(r.games, "game")} · {r.record.wins}W / {r.record.draws}D / {r.record.losses}L rated standard
            {r.record960?.games ? ` · ${r.record960.wins}W / ${r.record960.draws}D / ${r.record960.losses}L rated Chess960` : ""}
          </div>
        </div>
        {rows && rows.length > 1 && (
          <select value={model} onChange={(e) => go(e.target.value, { tab, scope })} aria-label="Model">
            {rows.map((x) => (
              <option key={x.model} value={x.model}>
                {x.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="kpis">
        <Stat
          label="Rating"
          value={
            r.rating === null ? (
              "–"
            ) : (
              <>
                {r.rating}
                {(r.rd ?? 350) > PROVISIONAL_RD && "?"}
              </>
            )
          }
          sub={r.rd !== null ? `± ${r.rd}` : "unrated"}
          hint="Its most-played player's Glicko-2 rating, from rated standard games"
        />
        {r.rating960 != null && (
          <Stat
            label="Chess960 rating"
            value={
              <>
                {r.rating960}
                {(r.rd960 ?? 350) > PROVISIONAL_RD && "?"}
              </>
            }
            sub={`± ${r.rd960}`}
            hint="Rated apart from standard chess: only its rated Chess960 games move it"
          />
        )}
        <Stat
          label="Chess.com"
          value={r.chessCom === null ? "–" : `≈${r.chessCom.rating}`}
          sub={r.chessCom === null ? "needs ~5 standard games" : `rapid, ${r.chessCom.low}–${r.chessCom.high}`}
          hint={CHESSCOM_HINT}
        />
        <Stat label="Score" value={fmtNum(r.score, 0, "%")} sub={plural(r.games, "game")} few={few} />
        <Stat label="Accuracy" value={fmtNum(r.accuracy, 1, "%")} few={few} />
        <Stat label="Blunders" value={fmtNum(r.blundersPer100)} sub="per 100 moves" few={few} />
        <Stat label="Illegal tries" value={fmtNum(r.illegalPer100)} sub="per 100 moves" few={few} />
        <Stat label="Self-eval gap" value={fmtNum(r.calibration, 1)} sub="win-% points" few={few} hint="How far its own winning chances are from the engine's, on average" />
        <Stat label="Avg think" value={fmtMs(r.think.avgMs)} sub={timeSub(r.think)} few={few} />
      </div>

      <div className="a-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => go(model, { tab: t.id, scope })}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab a={a} />}
      {tab === "thinking" && <ThinkingTab a={a} />}
      {tab === "mind" && <MindTab a={a} />}
      {tab === "results" && <ResultsTab a={a} />}
      {tab === "setup" && <SetupTab a={a} />}
    </div>
  );
}

export function AgentsPage({ model, query }: { model: string; query: URLSearchParams }) {
  const scope: AnalyticsScope = query.get("scope") === "rated" ? "rated" : "all";
  const tab = (TABS.find((t) => t.id === query.get("tab"))?.id ?? "overview") as Tab;
  return (
    <div className="page agents">
      <div className="agents-top">
        {model ? (
          <a className="back" href={`#/agents${scope === "rated" ? "?scope=rated" : ""}`}>
            ← All agents
          </a>
        ) : (
          <div>
            <h1>🤖 Agents</h1>
            <p className="sub">How each model plays: strength, move quality, thinking time, self-knowledge and more, from every finished game.</p>
          </div>
        )}
        <ScopeToggle scope={scope} onChange={(s) => go(model, { tab, scope: s })} />
      </div>
      {model ? <ModelView model={model} tab={tab} scope={scope} /> : <Overview scope={scope} />}
    </div>
  );
}
