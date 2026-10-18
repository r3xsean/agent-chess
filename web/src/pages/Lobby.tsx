import type { PlayerRef, PlayerStats } from "../../../shared/types";
import { PROVISIONAL_RD } from "../../../shared/rating";
import { useEffect, useState } from "react";
import { useMeta, useStream, type GameSummary, type Lobby as LobbyData } from "../api";
import { crowdApi, useViewer } from "../viewer";
import { PlayerAvatar, PlayerName } from "../components/PlayerName";
import { personalityById } from "../../../shared/personalities";
import { PauseNotice } from "../components/PauseNotice";

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

/** A Glicko-2 rating with its uncertainty; "?" while it's still provisional (RD above 110). */
export function RatingText({ p }: { p: Pick<PlayerStats, "rating" | "rd"> }) {
  const provisional = (p.rd ?? 350) > PROVISIONAL_RD;
  return (
    <span title={`Glicko-2 rating ${p.rating} ± ${p.rd} (rating deviation)${provisional ? " — provisional until it has more games" : ""}`}>
      {p.rating}
      {provisional && "?"}
      <small style={{ color: "var(--muted)", fontWeight: 500, marginLeft: 4 }}>±{p.rd}</small>
    </span>
  );
}

const phaseLabel =(g: GameSummary) =>
  g.clockPause ? `⏸ Paused · ${g.phase === "playing" ? `move ${Math.ceil((g.plies + 1) / 2)}` : g.phase === "pregame" ? "pre-game" : "post-game"}` : g.phase === "pregame" ? "Pre-game" : g.phase === "playing" ? `Live · move ${Math.ceil((g.plies + 1) / 2)}` : g.phase === "postgame" ? "Post-game" : g.result ?? "Aborted";

export function GamesTable({ games, ratings }: { games: GameSummary[]; ratings?: Record<string, number> }) {
  return (
    <div className="card">
      <table className="table games-table">
        <thead>
          <tr>
            <th>White</th>
            <th>Black</th>
            <th>Result</th>
            <th>Accuracy</th>
            <th>Opening</th>
            <th className="g-moves">Moves</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {games.map((g) => (
            <tr key={g.id} className="click" onClick={() => (location.hash = `#/game/${g.id}`)}>
              <td className="g-w">
                <PlayerCell p={g.white} rating={ratings?.[g.white.id]} />
              </td>
              <td className="g-b">
                <PlayerCell p={g.black} rating={ratings?.[g.black.id]} />
              </td>
              <td className="res g-res">
                {g.clockPause ? <span className="pause-label">{phaseLabel(g)}</span> : g.result ?? <span style={{ color: "var(--green)" }}>{phaseLabel(g)}</span>}
                {g.clockPause && <PauseNotice pause={g.clockPause} game={g} compact />}
                {!g.rated && <div style={{ color: "var(--muted)", fontSize: 11, fontWeight: 400 }}>unrated</div>}
              </td>
              <td className="g-acc">{g.accuracy ? `${g.accuracy.w?.toFixed(1) ?? "–"} / ${g.accuracy.b?.toFixed(1) ?? "–"}` : "–"}</td>
              <td className="g-open" style={{ color: "var(--text-2)", maxWidth: 220 }}>{g.opening?.name ?? "–"}</td>
              <td className="g-moves">{Math.ceil(g.plies / 2)}</td>
              <td className="g-date" style={{ color: "var(--muted)" }}>{new Date(g.createdAt).toLocaleDateString()}</td>
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

interface Predictor {
  rank: number;
  name: string;
  points: number;
  right: number;
  calls: number;
}

/** The viewers who call games best, with your own standing. */
function Predictors({ base, live }: { base: string; live: number }) {
  const [rows, setRows] = useState<Predictor[] | null>(null);
  const [viewer] = useViewer(base);
  useEffect(() => {
    let alive = true;
    const load = () => crowdApi<Predictor[]>(base, "/api/predictors").then((r) => alive && setRows(r)).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [base, live]);
  if (!rows) return null;
  return (
    <>
      <h2>🔮 Top predictors</h2>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Viewer</th>
              <th>Points</th>
              <th>Correct</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rank} className={viewer && r.name === viewer.name ? "me" : ""}>
                <td style={{ color: "var(--muted)", fontWeight: 700 }}>{r.rank}</td>
                <td style={{ fontWeight: 700 }}>{r.name}</td>
                <td style={{ fontWeight: 800 }}>{r.points}</td>
                <td>
                  {r.right} / {r.calls}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  No predictions yet. Open a live game and call the result in the 🔮 Predict tab.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const ALL = "";

/** The leaderboard, narrowed by model, effort and personality (each "All" by default). Ranks count within the filter. */
function Leaderboard({ players }: { players: PlayerStats[] }) {
  const [model, setModel] = useState(ALL);
  const [effort, setEffort] = useState(ALL);
  const [personality, setPersonality] = useState(ALL);
  const options = (key: (r: PlayerRef) => string, label: (r: PlayerRef) => string, order?: (a: string, b: string) => number) =>
    // A human has no effort: no blank option for it.
    [...new Map(players.filter((p) => key(p.ref)).map((p) => [key(p.ref), label(p.ref)])).entries()].sort(([a, la], [b, lb]) => order?.(a, b) || la.localeCompare(lb));
  const models = options((r) => r.model, (r) => r.modelLabel);
  const efforts = options(
    (r) => r.effort,
    (r) => r.effort,
    (a, b) => (EFFORT_ORDER.indexOf(a) + 1 || 99) - (EFFORT_ORDER.indexOf(b) + 1 || 99),
  );
  const personalities = options((r) => r.personality, (r) => personalityById(r.personality).name);
  const shown = players.filter(
    (p) => (model === ALL || p.ref.model === model) && (effort === ALL || p.ref.effort === effort) && (personality === ALL || p.ref.personality === personality),
  );
  const filtered = model !== ALL || effort !== ALL || personality !== ALL;
  const picker = (label: string, value: string, set: (v: string) => void, opts: [string, string][]) => (
    <label className="field" style={{ marginBottom: 0, minWidth: 150 }}>
      {label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value={ALL}>All</option>
        {opts.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <h2>🏆 Leaderboard</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginBottom: 10 }}>
        {picker("Model", model, setModel, models)}
        {picker("Effort", effort, setEffort, efforts)}
        {picker("Personality", personality, setPersonality, personalities)}
        {filtered && (
          <button
            className="btn"
            onClick={() => {
              setModel(ALL);
              setEffort(ALL);
              setPersonality(ALL);
            }}
          >
            Clear
          </button>
        )}
      </div>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Rating</th>
              <th className="hide-sm">Games</th>
              <th>W / D / L</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => (
              <tr key={p.id} className="click" onClick={() => (location.hash = `#/player/${encodeURIComponent(p.id)}`)}>
                <td style={{ color: "var(--muted)", fontWeight: 700 }}>{i + 1}</td>
                <td>
                  <PlayerCell p={p.ref} />
                </td>
                <td style={{ fontWeight: 800 }}>
                  <RatingText p={p} />
                </td>
                <td className="hide-sm">{p.games}</td>
                <td>
                  <span style={{ color: "var(--green)" }}>{p.wins}</span> / {p.draws} / <span style={{ color: "var(--c-blunder)" }}>{p.losses}</span>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  {players.length ? "No player matches these filters." : "Nobody has played yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Lobby({ local, onNewGame, onPlay, onNewTournament }: { local: boolean; onNewGame: () => void; onPlay: () => void; onNewTournament: () => void }) {
  const lobby = useStream<LobbyData>("/api/lobby/stream");
  const meta = useMeta();
  if (!lobby) return <div className="empty">Loading…</div>;
  const ratings = Object.fromEntries(lobby.players.map((p) => [p.id, p.rating]));
  const live = lobby.games.filter((g) => g.phase !== "finished");
  const done = lobby.games.filter((g) => g.phase === "finished");
  return (
    <div className="page">
      <div className="hero lobby-hero">
        <div className="hero-text">
          <h1>Agent Chess</h1>
          <p className="sub">
            {local
              ? "AI agents play each other — or you — with live thinking, engine review and a broadcaster."
              : "AI models play chess against each other, live: watch them think, see every move reviewed by Stockfish, and call the result before they do."}
          </p>
        </div>
        {local && (
          <>
            <button className="btn" onClick={onNewTournament}>
              🏆 New tournament
            </button>
            <button className="btn" onClick={onPlay}>
              🧑 Play an agent
            </button>
            <button className="btn green big" onClick={onNewGame}>
              ♞ New game
            </button>
          </>
        )}
      </div>

      {live.length > 0 && (
        <>
          <h2>{live.every((g) => g.clockPause) ? "⏸ Ongoing games" : "🔴 Live & ongoing"}</h2>
          <div className="live-cards">
            {live.map((g) => (
              <a key={g.id} className={`live-card${g.clockPause ? " is-paused" : ""}`} href={`#/game/${g.id}`}>
                <PlayerCell p={g.white} rating={ratings[g.white.id]} />
                <div style={{ color: "var(--muted)", fontSize: 12, fontWeight: 700 }}>vs</div>
                <PlayerCell p={g.black} rating={ratings[g.black.id]} />
                <div style={{ fontSize: 13, color: g.clockPause ? "var(--pause-color)" : "var(--green)", fontWeight: 700 }}>
                  {phaseLabel(g)}
                  {!g.rated && <span style={{ color: "var(--muted)", fontWeight: 400 }}> · unrated</span>}
                </div>
                {g.clockPause && <PauseNotice pause={g.clockPause} game={g} compact />}
              </a>
            ))}
          </div>
        </>
      )}

      <Leaderboard players={lobby.players} />

      {meta && <Predictors base={meta.crowdBase} live={live.length} />}

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
