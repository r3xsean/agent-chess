import { isHuman } from "../../../shared/naming";
import { useFetch, type PlayerPage as Data } from "../api";
import { PlayerAvatar, PlayerName, Var960 } from "../components/PlayerName";
import { GamesTable, RatingText } from "./Lobby";

export function PlayerPage({ id }: { id: string }) {
  const data = useFetch<Data>(`/api/players/${encodeURIComponent(id)}`, [id]);
  if (!data) return <div className="empty">Loading…</div>;
  const { player, player960, games } = data;
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
        {/* Standard and Chess960 are rated apart: each rating with its own record. */}
        <div className="player-hero-rating">
          <div className="big-rating">
            <RatingText p={player} />
          </div>
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            Standard · {player.wins}W / {player.draws}D / {player.losses}L
          </div>
        </div>
        {player960 && (
          <div className="player-hero-rating">
            <div className="big-rating">
              <RatingText p={player960} />
              <Var960 />
            </div>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>
              Chess960 · {player960.wins}W / {player960.draws}D / {player960.losses}L
            </div>
          </div>
        )}
      </div>
      <h2>Games</h2>
      <GamesTable games={games} />
    </div>
  );
}
