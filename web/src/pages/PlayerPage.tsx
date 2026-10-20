import { isHuman } from "../../../shared/naming";
import { useFetch, type PlayerPage as Data } from "../api";
import { PlayerAvatar, PlayerName } from "../components/PlayerName";
import { GamesTable, RatingText } from "./Lobby";

export function PlayerPage({ id }: { id: string }) {
  const data = useFetch<Data>(`/api/players/${encodeURIComponent(id)}`, [id]);
  if (!data) return <div className="empty">Loading…</div>;
  const { player, games } = data;
  return (
    <div className="page">
      <div className="hero player-hero">
        <PlayerAvatar player={player.ref} size={72} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <PlayerName player={player.ref} />
          </h1>
          {!isHuman(player.ref) && (
            <p className="sub" style={{ margin: 0 }}>
              <a href={`#/agents/${encodeURIComponent(player.ref.model)}`}>{player.ref.modelLabel} analytics →</a>
            </p>
          )}
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
      <h2>Games</h2>
      <GamesTable games={games} />
    </div>
  );
}
