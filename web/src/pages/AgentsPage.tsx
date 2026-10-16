import { useState } from "react";
import type { Personality, PlayerStats } from "../../../shared/types";
import { useFetch } from "../api";
import { Avatar } from "../components/PlayerBar";
import { RiskBadge } from "../components/RiskBadge";
import { RatingText } from "./Lobby";
import { RISK_LABEL } from "../../../shared/personalities";
import { makerOf } from "../../../shared/models";

type Record4 = { games: number; wins: number; draws: number; losses: number };

interface PersonalityInfo {
  personality: Personality;
  riskRule: string;
  record: Record4;
  /** This agent's players in this personality, one per effort, best first. */
  players: PlayerStats[];
}

interface AgentInfo {
  model: string;
  label: string;
  provider: string;
  record: Record4;
  best: PlayerStats;
  personalities: PersonalityInfo[];
}

const score = (r: Record4) => (r.games ? `${Math.round(((r.wins + r.draws / 2) / r.games) * 100)}%` : "–");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const wdl = (r: Record4) => (r.games ? `${r.wins}W / ${r.draws}D / ${r.losses}L` : "no games yet");

function PersonalityCard({ info }: { info: PersonalityInfo }) {
  const [open, setOpen] = useState(false);
  const p = info.personality;
  return (
    <div className="seat" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Avatar personality={p.id} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>
            {p.name} {!p.plain && <RiskBadge risk={p.risk} />}
          </b>
          <div style={{ color: "var(--text-2)", fontSize: 13 }}>{p.tagline}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{score(info.record)}</div>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>{wdl(info.record)}</div>
        </div>
      </div>

      {info.players.length > 0 && (
        <table className="table" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Effort</th>
              <th>Rating</th>
              <th>W / D / L</th>
            </tr>
          </thead>
          <tbody>
            {info.players.map((x) => (
              <tr key={x.id} className="click" onClick={() => (location.hash = `#/player/${encodeURIComponent(x.id)}`)}>
                <td>{x.ref.effort}</td>
                <td style={{ fontWeight: 800 }}>
                  <RatingText p={x} />
                </td>
                <td>
                  {x.wins} / {x.draws} / {x.losses}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button className="btn" style={{ marginTop: 10 }} onClick={() => setOpen(!open)}>
        {open ? "Hide style, voice & risk ▴" : "Style, voice & risk ▾"}
      </button>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginTop: 10, fontSize: 14, lineHeight: 1.5 }}>
          <div>
            <div className="section-title" style={{ marginBottom: 4 }}>
              ♟ Style
            </div>
            {p.style}
          </div>
          <div>
            <div className="section-title" style={{ marginBottom: 4 }}>
              🗣 Voice
            </div>
            {p.voice}
          </div>
          <div>
            <div className="section-title" style={{ marginBottom: 4 }}>
              🎲 Risk — {p.plain ? "None" : RISK_LABEL[p.risk].label}
            </div>
            {info.riskRule}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentsPage({ model }: { model: string }) {
  const data = useFetch<AgentInfo[]>("/api/agents");
  if (!data) return <div className="empty">Loading…</div>;
  const cur = data.find((a) => a.model === model) ?? data[0];
  const played = cur?.personalities.filter((x) => x.players.length > 0) ?? [];
  const unplayed = cur?.personalities.filter((x) => x.players.length === 0) ?? [];
  return (
    <div className="page">
      <h1>🤖 Agents</h1>
      <p className="sub">
        Each agent is a model, and it plays in a <b>personality</b>: a playing <b>style</b>, a <b>voice</b> and a <b>risk appetite</b>. <RiskBadge risk="calm" /> styles only
        break ties between equal moves, <RiskBadge risk="bold" /> ones pick the sharper of close moves, and <RiskBadge risk="wild" /> ones knowingly trade a little soundness for
        practical chances — dubious gambits and speculative sacrifices included. Wild players will score lower on engine accuracy; the leaderboard shows whether the risk pays
        off. <b>No personality</b> is the control group: the model plays as itself, with none of this in its prompt.
      </p>

      {!cur ? (
        <div className="card empty">No agent has played yet.</div>
      ) : (
        <>
          <div className="persona-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 8 }}>
            {data.map((a) => (
              <button key={a.model} className={`persona ${a.model === cur.model ? "on" : ""}`} onClick={() => (location.hash = `#/agents/${encodeURIComponent(a.model)}`)}>
                <div className="avatar" style={{ background: makerOf(a.provider).color }}>
                  {a.label[0]}
                </div>
                <div>
                  <b>{a.label}</b>
                  <span>
                    best {a.best.rating} · {plural(a.personalities.filter((x) => x.players.length > 0).length, "personality", "personalities")}
                  </span>
                  <span style={{ display: "block", marginTop: 2 }}>{wdl(a.record)}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="card" style={{ marginTop: 20, padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ flex: 1 }}>
                <h1 style={{ fontSize: 24, margin: 0 }}>{cur.label}</h1>
                <div style={{ color: "var(--text-2)", marginTop: 4 }}>
                  {makerOf(cur.provider).name} · {played.length} of {cur.personalities.length} personalities played ·{" "}
                  <a href="#/memory" style={{ color: "var(--green)" }}>
                    lessons &amp; journals
                  </a>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{score(cur.record)}</div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>
                  score over {cur.record.games} game{cur.record.games === 1 ? "" : "s"}
                </div>
              </div>
            </div>

            <div className="section-title" style={{ margin: "18px 0 8px" }}>
              Personalities
            </div>
            {played.map((x) => (
              <PersonalityCard key={x.personality.id} info={x} />
            ))}

            {unplayed.length > 0 && (
              <>
                <div className="section-title" style={{ margin: "18px 0 8px" }}>
                  Not played yet
                </div>
                {unplayed.map((x) => (
                  <PersonalityCard key={x.personality.id} info={x} />
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
