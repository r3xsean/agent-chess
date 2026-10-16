import type { PlayerRef } from "../../../shared/types";
import { personalityById } from "../../../shared/personalities";
import { useStream, type GameSummary, type Lobby as LobbyData } from "../api";
import { Avatar } from "../components/PlayerBar";
import { PlayerAvatar, PlayerName } from "../components/PlayerName";

export function PlayerCell({ p, rating }: { p: PlayerRef; rating?: number }) {
  return (
    <a className="pcell" href={`#/player/${encodeURIComponent(p.id)}`} onClick={(e) => e.stopPropagation()}>
      <PlayerAvatar player={p} size={36} />
      <div>
        <div className="nm">
          <PlayerName player={p} />
          {rating !== undefined && <span style={{ color: "var(--muted)", fontWeight: 500 }}> ({rating})</span>}
        </div>
      </div>
    </a>
  );
}

const phaseLabel = (g: GameSummary) =>
  g.phase === "pregame" ? "Pre-game" : g.phase === "playing" ? `Live · move ${Math.ceil((g.plies + 1) / 2)}` : g.phase === "postgame" ? "Post-game" : g.result ?? "Aborted";

export function GamesTable({ games, ratings }: { games: GameSummary[]; ratings?: Record<string, number> }) {
  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th>White</th>
            <th>Black</th>
            <th>Result</th>
            <th>Accuracy</th>
            <th>Opening</th>
            <th>Moves</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {games.map((g) => (
            <tr key={g.id} className="click" onClick={() => (location.hash = `#/game/${g.id}`)}>
              <td>
                <PlayerCell p={g.white} rating={ratings?.[g.white.id]} />
              </td>
              <td>
                <PlayerCell p={g.black} rating={ratings?.[g.black.id]} />
              </td>
              <td className="res">{g.result ?? <span style={{ color: "var(--green)" }}>{phaseLabel(g)}</span>}</td>
              <td>{g.accuracy ? `${g.accuracy.w?.toFixed(1) ?? "–"} / ${g.accuracy.b?.toFixed(1) ?? "–"}` : "–"}</td>
              <td style={{ color: "var(--text-2)", maxWidth: 220 }}>{g.opening?.name ?? "–"}</td>
              <td>{Math.ceil(g.plies / 2)}</td>
              <td style={{ color: "var(--muted)" }}>{new Date(g.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
          {games.length === 0 && (
            <tr>
              <td colSpan={7} className="empty">
                No games yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Lobby({ onNewGame, onNewTournament }: { onNewGame: () => void; onNewTournament: () => void }) {
  const lobby = useStream<LobbyData>("/api/lobby/stream");
  if (!lobby) return <div className="empty">Loading…</div>;
  const ratings = Object.fromEntries(lobby.players.map((p) => [p.id, p.rating]));
  const live = lobby.games.filter((g) => g.phase !== "finished");
  const done = lobby.games.filter((g) => g.phase === "finished");
  return (
    <div className="page">
      <div className="hero">
        <div style={{ flex: 1 }}>
          <h1>Agent Chess</h1>
          <p className="sub">AI agents play each other with live thinking, engine review and a broadcaster.</p>
        </div>
        <button className="btn" onClick={onNewTournament}>
          🏆 New tournament
        </button>
        <button className="btn green big" onClick={onNewGame}>
          ♞ New game
        </button>
      </div>

      {live.length > 0 && (
        <>
          <h2>🔴 Live now</h2>
          <div className="live-cards">
            {live.map((g) => (
              <a key={g.id} className="live-card" href={`#/game/${g.id}`}>
                <PlayerCell p={g.white} rating={ratings[g.white.id]} />
                <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 700 }}>vs</div>
                <PlayerCell p={g.black} rating={ratings[g.black.id]} />
                <div style={{ fontSize: 13, color: "var(--green)", fontWeight: 700 }}>{phaseLabel(g)}</div>
              </a>
            ))}
          </div>
        </>
      )}

      <h2>🏆 Leaderboard</h2>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Rating</th>
              <th>Games</th>
              <th>W / D / L</th>
            </tr>
          </thead>
          <tbody>
            {lobby.players.map((p, i) => (
              <tr key={p.id} className="click" onClick={() => (location.hash = `#/player/${encodeURIComponent(p.id)}`)}>
                <td style={{ color: "var(--muted)", fontWeight: 700 }}>{i + 1}</td>
                <td>
                  <PlayerCell p={p.ref} />
                </td>
                <td style={{ fontWeight: 800 }}>{p.rating}</td>
                <td>{p.games}</td>
                <td>
                  <span style={{ color: "var(--green)" }}>{p.wins}</span> / {p.draws} / <span style={{ color: "var(--c-blunder)" }}>{p.losses}</span>
                </td>
              </tr>
            ))}
            {lobby.players.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Nobody has played yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {lobby.tournaments.length > 0 && (
        <>
          <h2>Tournaments</h2>
          <div className="card">
            <table className="table">
              <tbody>
                {lobby.tournaments.map((t) => (
                  <tr key={t.id} className="click" onClick={() => (location.hash = `#/tournament/${t.id}`)}>
                    <td style={{ fontWeight: 700 }}>🏆 {t.name}</td>
                    <td>{t.players.length} players</td>
                    <td>
                      {t.pairings.filter((p) => p.gameId).length}/{t.pairings.length} games
                    </td>
                    <td style={{ color: t.status === "running" ? "var(--green)" : "var(--muted)", fontWeight: 700 }}>{t.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Recent games</h2>
      <GamesTable games={done} ratings={ratings} />
    </div>
  );
}
