import { useState } from "react";
import { api, ratingsOf, useFetch, useMeta, useStream, type Lobby, type TournamentPage as Data } from "../api";
import type { PlayerRef, Tournament } from "../../../shared/types";
import { sideLooks } from "../../../shared/looks";
import { openingById } from "../../../shared/openingSuite";
import { GamesTable, PlayerCell } from "./Lobby";
import { SummonInfo } from "../components/NewGame";

export function TournamentPage({ id }: { id: string }) {
  const lobby = useStream<Lobby>("/api/lobby/stream");
  const meta = useMeta();
  const data = useFetch<Data>(`/api/tournaments/${id}`, [id, JSON.stringify(lobby?.games.map((g) => g.phase)), JSON.stringify(lobby?.tournaments)]);
  if (!data) return <div className="empty">Loading…</div>;
  const { tournament: t, games } = data;
  const all = ratingsOf(lobby);
  // A Chess960 tournament is shown with its players' Chess960 ratings.
  const variant = t.chess960 ? "chess960" : "standard";
  const ratings = all[variant];
  const score: Record<string, { pts: number; played: number; w: number; d: number; l: number }> = {};
  for (const p of t.players) score[p.id] = { pts: 0, played: 0, w: 0, d: 0, l: 0 };
  for (const g of games) {
    if (!g?.result) continue;
    const sw = g.result === "1-0" ? 1 : g.result === "0-1" ? 0 : 0.5;
    for (const [pid, s] of [
      [g.white.id, sw],
      [g.black.id, 1 - sw],
    ] as const) {
      const row = score[pid];
      if (!row) continue;
      row.pts += s;
      row.played++;
      if (s === 1) row.w++;
      else if (s === 0) row.l++;
      else row.d++;
    }
  }
  const standings = [...t.players].sort((a, b) => score[b.id].pts - score[a.id].pts || (ratings[b.id] ?? 0) - (ratings[a.id] ?? 0));
  const byId = new Map(t.players.map((p) => [p.id, p]));
  return (
    <div className="page">
      <h1>🏆 {t.name}</h1>
      <p className="sub">
        {t.players.length} players · {t.doubleRound ? "double" : "single"} round-robin{t.chess960 ? " · Chess960 (rated apart from standard)" : ""}
        {t.openings ? (t.openings === "each" ? " · set openings (each pairing its own)" : ` · set opening: ${openingById(t.openings)?.name ?? t.openings}`) : ""}
        {t.rated === false ? " · unrated" : ""} · {t.status}
      </p>
      {meta && !meta.publicMode && <TournamentSettings key={`${t.id}:${t.boards}:${t.breakHours}`} tournament={t} />}
      {t.status === "running" && (
        <div className="card" style={{ padding: 14 }}>
          <SummonInfo tournamentId={t.id} />
        </div>
      )}
      {!!data.next?.length && (
        <NextUp
          tournamentId={t.id}
          matchups={data.next.map((i) => t.pairings[i]).map((p) => [byId.get(p.white)!, byId.get(p.black)!] as const)}
          breakUntil={data.breakUntil}
          canSkip={!!meta && !meta.publicMode}
        />
      )}
      <h2>Standings</h2>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Points</th>
              <th className="hide-sm">Played</th>
              <th>W / D / L</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((p, i) => (
              <tr key={p.id}>
                <td style={{ fontWeight: 700, color: i === 0 ? "#f7c631" : "var(--muted)" }}>{i + 1}</td>
                <td>
                  <PlayerCell p={p} rating={ratings[p.id]} variant={variant} />
                </td>
                <td style={{ fontWeight: 800 }}>{score[p.id].pts}</td>
                <td className="hide-sm">{score[p.id].played}</td>
                <td>
                  {score[p.id].w} / {score[p.id].d} / {score[p.id].l}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Schedule</h2>
      <div className="card">
        <table className="table">
          <tbody>
            {t.pairings.map((p, i) => {
              const g = games[i];
              return (
                <tr key={i} className={g ? "click" : ""} onClick={() => g && (location.hash = `#/game/${g.id}`)}>
                  <td style={{ color: "var(--muted)" }}>{i + 1}</td>
                  <td>
                    <PlayerCell p={byId.get(p.white)!} />
                  </td>
                  <td>
                    <PlayerCell p={byId.get(p.black)!} look={sideLooks({ white: byId.get(p.white)!, black: byId.get(p.black)! }).b} />
                  </td>
                  <td className="res">
                    {g ? g.result ?? <span style={{ color: "var(--green)" }}>{g.phase}</span> : data.next?.includes(i) ? <span style={{ color: "#f7c631" }}>next</span> : <span style={{ color: "var(--muted)" }}>upcoming</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h2>Games</h2>
      <GamesTable games={games.filter((g): g is NonNullable<typeof g> => !!g)} ratings={all} />
    </div>
  );
}

/** The game(s) that start next, and during a break, when it ends and a button to end it now. */
function NextUp({ tournamentId, matchups, breakUntil, canSkip }: { tournamentId: string; matchups: (readonly [PlayerRef, PlayerRef])[]; breakUntil?: number; canSkip: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  const [err, setErr] = useState("");
  const left = breakUntil ? Math.max(0, breakUntil - Date.now()) : 0;
  const h = Math.floor(left / 3_600_000);
  const m = Math.ceil((left % 3_600_000) / 60_000);
  return (
    <div className="card" style={{ padding: 14 }}>
      <h2 style={{ margin: "0 0 8px" }}>Next {matchups.length > 1 ? `${matchups.length} games` : "game"}</h2>
      <table className="table">
        <tbody>
          {matchups.map(([w, b], i) => (
            <tr key={i}>
              <td><PlayerCell p={w} /></td>
              <td style={{ color: "var(--muted)" }}>vs</td>
              <td><PlayerCell p={b} look={sideLooks({ white: w, black: b }).b} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {breakUntil && (
        <p style={{ margin: "10px 0 0" }}>
          On a break until {new Date(breakUntil).toLocaleString()} ({h ? `${h}h ` : ""}{m}m left).{" "}
          {canSkip && (
            <button
              className="btn"
              disabled={state === "sending"}
              onClick={async () => {
                setState("sending");
                try {
                  await api(`/api/tournaments/${tournamentId}/skip-break`, {});
                  setState("idle");
                } catch (e) {
                  setErr(String(e));
                  setState("error");
                }
              }}
            >
              {state === "sending" ? "Starting…" : `⏭ Skip break and start ${matchups.length > 1 ? "them" : "it"} now`}
            </button>
          )}
          {state === "error" && <span style={{ color: "var(--red, #e55)" }}> {err}</span>}
        </p>
      )}
    </div>
  );
}

function TournamentSettings({ tournament: t }: { tournament: Tournament }) {
  const [boards, setBoards] = useState(t.boards ?? Math.max(1, Math.floor(t.players.length / 2)));
  const [hours, setHours] = useState(t.breakHours ?? 0);
  const [message, setMessage] = useState("");
  return <form className="card" style={{ padding: 14 }} onSubmit={async (e) => {
    e.preventDefault();
    try {
      await api(`/api/tournaments/${t.id}/settings`, { boards, breakHours: hours });
      setMessage("Saved");
    } catch (error) { setMessage(String(error)); }
  }}>
    <label className="field">Boards
      <input type="number" min="1" max={Math.max(1, Math.floor(t.players.length / 2))} step="1" value={boards} onChange={(e) => setBoards(Number(e.target.value))} required />
    </label>
    <label className="field">Break between games (hours)
      <input type="number" min="0" max="8760" step="0.25" value={hours} onChange={(e) => setHours(Number(e.target.value))} required />
      <small>After all active boards finish. Set to 0 for no break. Current: {t.breakHours ?? 0} hours.</small>
    </label>
    <button className="btn" type="submit">Save settings</button>
    <span role="status"> {message}</span>
  </form>;
}
