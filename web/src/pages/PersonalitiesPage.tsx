import { useState } from "react";
import type { Personality, PlayerStats } from "../../../shared/types";
import { useFetch } from "../api";
import { Avatar } from "../components/PlayerBar";
import { RiskBadge } from "../components/RiskBadge";
import { RISK_LABEL } from "../../../shared/personalities";

interface PersonalityInfo {
  personality: Personality;
  riskRule: string;
  record: { games: number; wins: number; draws: number; losses: number };
  players: PlayerStats[];
}

export function PersonalitiesPage() {
  const data = useFetch<PersonalityInfo[]>("/api/personalities");
  const [selected, setSelected] = useState<string | null>(null);
  if (!data) return <div className="empty">Loading…</div>;
  const cur = data.find((d) => d.personality.id === selected) ?? data[0];
  const p = cur.personality;
  const r = cur.record;
  return (
    <div className="page">
      <h1>🎭 Personalities</h1>
      <p className="sub">
        Each personality is a playing <b>style</b>, a <b>voice</b> and a <b>risk appetite</b>. <RiskBadge risk="calm" /> styles only break ties between equal moves,{" "}
        <RiskBadge risk="bold" /> ones pick the sharper of close moves, and <RiskBadge risk="wild" /> ones knowingly trade a little soundness for practical chances —
        dubious gambits and speculative sacrifices included. Wild players will score lower on engine accuracy; the leaderboard shows whether the risk pays off.
      </p>

      <div className="persona-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 8 }}>
        {data.map((d) => (
          <button key={d.personality.id} className={`persona ${d.personality.id === p.id ? "on" : ""}`} onClick={() => setSelected(d.personality.id)}>
            <Avatar personality={d.personality.id} />
            <div>
              <b>
                {d.personality.name} <RiskBadge risk={d.personality.risk} />
              </b>
              <span>{d.personality.tagline}</span>
              <span style={{ display: "block", marginTop: 2 }}>
                {d.record.games ? `${d.record.wins}W / ${d.record.draws}D / ${d.record.losses}L` : "no games yet"}
              </span>
            </div>
          </button>
        ))}
      </div>

      <div className="card" style={{ marginTop: 20, padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Avatar personality={p.id} size={64} />
          <div style={{ flex: 1 }}>
            <h1 style={{ fontSize: 24, margin: 0 }}>
              {p.name} <RiskBadge risk={p.risk} />
            </h1>
            <div style={{ color: "var(--text-2)" }}>{p.tagline}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{r.games ? `${Math.round(((r.wins + r.draws / 2) / r.games) * 100)}%` : "–"}</div>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
              score over {r.games} game{r.games === 1 ? "" : "s"}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
          <div className="seat">
            <div className="section-title" style={{ marginBottom: 6 }}>
              ♟ Style — how it chooses moves
            </div>
            <div style={{ lineHeight: 1.5, fontSize: 14 }}>{p.style}</div>
          </div>
          <div className="seat">
            <div className="section-title" style={{ marginBottom: 6 }}>
              🗣 Voice — how it talks
            </div>
            <div style={{ lineHeight: 1.5, fontSize: 14 }}>{p.voice}</div>
          </div>
        </div>
        <div className="seat" style={{ marginTop: 14 }}>
          <div className="section-title" style={{ marginBottom: 6 }}>
            🎲 Risk appetite — {RISK_LABEL[p.risk].label}
          </div>
          <div style={{ lineHeight: 1.5, fontSize: 14 }}>{cur.riskRule}</div>
        </div>

        <div className="section-title" style={{ margin: "18px 0 8px" }}>
          Played by
        </div>
        {cur.players.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 14 }}>No model has played as {p.name} yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Effort</th>
                <th>Rating</th>
                <th>W / D / L</th>
              </tr>
            </thead>
            <tbody>
              {cur.players.map((x) => (
                <tr key={x.id} className="click" onClick={() => (location.hash = `#/player/${encodeURIComponent(x.id)}`)}>
                  <td style={{ fontWeight: 700 }}>{x.ref.modelLabel}</td>
                  <td>{x.ref.effort}</td>
                  <td style={{ fontWeight: 800 }}>{x.rating}</td>
                  <td>
                    {x.wins} / {x.draws} / {x.losses}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      </div>
    </div>
  );
}
