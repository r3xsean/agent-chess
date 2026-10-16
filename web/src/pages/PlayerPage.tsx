import { personalityById } from "../../../shared/personalities";
import { useFetch, type PlayerPage as Data } from "../api";
import { Avatar } from "../components/PlayerBar";
import { GamesTable } from "./Lobby";
import { LessonsPanel } from "../components/LessonsPanel";

export function PlayerPage({ id }: { id: string }) {
  const data = useFetch<Data>(`/api/players/${encodeURIComponent(id)}`, [id]);
  if (!data) return <div className="empty">Loading…</div>;
  const { player, journal, games } = data;
  const p = personalityById(player.ref.personality);
  return (
    <div className="page">
      <div className="hero">
        <Avatar personality={p.id} size={72} />
        <div style={{ flex: 1 }}>
          <h1>{p.name}</h1>
          <p className="sub" style={{ margin: 0 }}>
            {player.ref.modelLabel} · {player.ref.effort} effort · {p.tagline}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 34, fontWeight: 800 }}>{player.rating}</div>
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            {player.wins}W / {player.draws}D / {player.losses}L
          </div>
        </div>
      </div>
      <div className="card" style={{ padding: "12px 14px", color: "var(--text-2)", lineHeight: 1.5, fontSize: 14 }}>
        <b style={{ color: "white" }}>Style.</b> {p.style}
        <br />
        <b style={{ color: "white" }}>Voice.</b> {p.voice}
      </div>
      <LessonsPanel model={player.ref.model} modelLabel={player.ref.modelLabel} />
      <h2>📓 Journal</h2>
      <div className="card">
        {journal.length === 0 && <div className="empty">No entries yet.</div>}
        {[...journal].reverse().map((e) => (
          <div className="journal-entry" key={e.gameId}>
            <div className="meta">
              {new Date(e.ts).toLocaleString()} · as {e.color === "w" ? "White" : "Black"} · {e.result} ·{" "}
              <a href={`#/game/${e.gameId}`} style={{ color: "var(--green)" }}>
                view game
              </a>
            </div>
            {e.text}
          </div>
        ))}
      </div>
      <h2>Games</h2>
      <GamesTable games={games} />
    </div>
  );
}
