import { useFetch } from "../api";
import type { ArmMetric, ArmStats, Difference, Estimate, ExperimentReport } from "../../../shared/experiments";
import { SetupText } from "../components/SetupChip";

/*
 * Every toggle combination side by side (shared/experiments.ts). Each number has its 95% range; under it, its
 * difference from the first row (the plain text briefing when it's in the scope), marked clear only when the server
 * finds it bigger than its own range, measured game by game, so a gap that's only noise isn't read as a result.
 */

type Col = { key: ArmMetric; label: string; title: string; better: "up" | "down" };

const COLS: Col[] = [
  { key: "accuracy", label: "Accuracy", title: "Game accuracy, as the site shows it, averaged over the games.", better: "up" },
  { key: "balancedAccuracy", label: "Open accuracy", title: "Move accuracy only while the position was still open (engine within ±2 pawns): a side already winning plays easy moves.", better: "up" },
  { key: "blunders", label: "Blunders", title: "Per 100 graded moves (no book or forced moves).", better: "down" },
  { key: "mistakes", label: "Mistakes", title: "Mistakes and misses per 100 graded moves.", better: "down" },
  { key: "illegal", label: "Illegal", title: "Illegal attempts per 100 moves played.", better: "down" },
  { key: "positionRefusals", label: "Misreads", title: "Written-out positions that didn't match the board, per 100 moves (re-read seats only).", better: "down" },
  { key: "codeRefusals", label: "No code", title: "Moves sent without this turn's picture code, per 100 moves (picture seats only).", better: "down" },
  { key: "score", label: "Score %", title: "Points per game (a draw is half).", better: "up" },
];

const est = (e: Estimate) => (e.value === null ? "–" : e.ci === null ? `${e.value}` : `${e.value} ±${e.ci}`);

/** The difference from the first row, as the server measured it, and whether it's clear of the noise (and which way is better). */
function Delta({ d, better }: { d?: Difference; better: "up" | "down" }) {
  if (!d || d.value === null) return null;
  const good = (d.value > 0) === (better === "up");
  const title = d.ci === null ? "Too few games to tell yet" : d.clear ? `Bigger than the noise (95% range ±${d.ci})` : `Within the noise (95% range ±${d.ci}): not shown to differ yet`;
  return (
    <small className={`delta ${d.clear ? (good ? "good" : "bad") : "noise"}`} title={title}>
      {d.value > 0 ? "+" : ""}
      {d.value}
      {d.clear ? " ✓" : d.ci === null ? " · few games" : ""}
    </small>
  );
}

function ArmTable({ arms, compact }: { arms: ArmStats[]; compact?: boolean }) {
  const cols = compact ? COLS.filter((c) => ["accuracy", "balancedAccuracy", "blunders", "illegal", "score"].includes(c.key)) : COLS;
  return (
    <div className="table-scroll">
      <table className="table exp-table">
        <thead>
          <tr>
            <th>Setup</th>
            <th title="Games played under it (one seat each), and its graded moves">Games</th>
            {cols.map((c) => (
              <th key={c.key} title={c.title}>
                {c.label}
              </th>
            ))}
            {!compact && <th title="Average thinking time per move">Think</th>}
          </tr>
        </thead>
        <tbody>
          {arms.map((a, i) => (
            <tr key={a.key}>
              <td>
                <SetupText setup={a.setup} block />
              </td>
              <td>
                {a.games}
                <small className="muted"> · {a.graded} mv</small>
              </td>
              {cols.map((c) => (
                <td key={c.key} className="num">
                  {est(a[c.key])}
                  {i > 0 && <Delta d={a.vsFirst?.[c.key]} better={c.better} />}
                </td>
              ))}
              {!compact && <td className="num">{a.thinkSec === null ? "–" : `${a.thinkSec}s`}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExperimentsPage({ query }: { query: URLSearchParams }) {
  const scope = query.get("scope") ?? "experiments";
  const data = useFetch<ExperimentReport>(`/api/experiments?scope=${encodeURIComponent(scope)}`, [scope]);
  return (
    <div className="page">
      <h1>🔬 Experiments</h1>
      <p className="sub">
        How the players do under each board-view setup. Every number has its 95% range (±), once there are at least five games. Below the first row, each number shows its
        difference from it, measured game by game: <b>✓</b> marks a difference bigger than the noise, in green when it's better.
      </p>
      {!data ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <div className="chips" style={{ marginBottom: 14 }}>
            {data.scopes.map((s) => (
              <a key={s.id} className={`chip ${data.scope === s.id ? "on" : ""}`} href={`#/experiments?scope=${encodeURIComponent(s.id)}`}>
                {s.label} <span className="muted">· {s.games}</span>
              </a>
            ))}
          </div>
          {!data.arms.length ? (
            <div className="empty">No reviewed games here yet. Set up a game or tournament with the 🔬 Board-view experiment option.</div>
          ) : (
            <>
              <h2>By setup · all models</h2>
              <div className="card">
                <ArmTable arms={data.arms} />
              </div>
              {data.headToHead.length > 0 && (
                <>
                  <h2>Head to head</h2>
                  <p className="sub">Games where the two sides played under different setups.</p>
                  <div className="card">
                    <table className="table exp-table">
                      <thead>
                        <tr>
                          <th>Setup</th>
                          <th>vs</th>
                          <th>Games</th>
                          <th>W / D / L</th>
                          <th title="Points per game for the first setup, in %">Score %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.headToHead.map((h) => (
                          <tr key={`${h.a}|${h.b}`}>
                            <td>{h.aLabel}</td>
                            <td>{h.bLabel}</td>
                            <td>{h.games}</td>
                            <td>
                              {h.aWins} / {h.draws} / {h.bWins}
                            </td>
                            <td className="num">{est(h.aScore)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {data.models.length > 0 && (
                <>
                  <h2>By model</h2>
                  <p className="sub">Each model against itself under each setup: a handful of games per row, so expect wide ranges.</p>
                  {data.models.map((m) => (
                    <div key={m.model} className="card exp-model">
                      <h3>{m.label}</h3>
                      <ArmTable arms={m.arms} compact />
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
