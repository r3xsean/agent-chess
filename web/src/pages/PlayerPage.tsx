import { personalityById } from "../../../shared/personalities";
import { isHuman } from "../../../shared/naming";
import { useFetch, type PlayerPage as Data } from "../api";
import { Avatar } from "../components/PlayerBar";
import { PlayerAvatar, PlayerName } from "../components/PlayerName";
import { GamesTable, RatingText } from "./Lobby";
import { LessonsPanel } from "../components/LessonsPanel";

export function PlayerPage({ id }: { id: string }) {
  const data = useFetch<Data>(`/api/players/${encodeURIComponent(id)}`, [id]);
  if (!data) return <div className="empty">Loading…</div>;
  const { player, journal, games } = data;
  const p = personalityById(player.ref.personality);
  return (
    <div className="page">
      <div className="hero player-hero">
        <PlayerAvatar player={player.ref} size={72} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <PlayerName player={player.ref} />
          </h1>
          <p className="sub" style={{ margin: 0 }}>
            {p.tagline}
          </p>
        </div>
        <div className="player-hero-rating">
          <div className="big-rating">
            <RatingText p={player} />
          </div>
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            {player.wins}W / {player.draws}D / {player.losses}L
          </div>
        </div>
      </div>
      {/* A human has no style prompt, lessons or journal: just their record. */}
      {!isHuman(player.ref) && (
        <>
          {!p.plain && (
            <div className="card" style={{ padding: "12px 14px", color: "var(--text-2)", lineHeight: 1.5, fontSize: 14 }}>
              <b style={{ color: "white" }}>Style.</b> {p.style}
              <br />
              <b style={{ color: "white" }}>Voice.</b> {p.voice}
            </div>
          )}
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
        </>
      )}
      <h2>Games</h2>
      <GamesTable games={games} />
    </div>
  );
}
