import { useState } from "react";
import { useFetch, type MemoryModel } from "../api";
import { PlayerAvatar, PlayerName } from "../components/PlayerName";
import { LessonsPanel } from "../components/LessonsPanel";

const colorName = (c: "w" | "b") => (c === "w" ? "White" : "Black");

function PlayerJournal({ entry }: { entry: MemoryModel["players"][number] }) {
  const [all, setAll] = useState(false);
  const { player, journal } = entry;
  const shown = [...journal].reverse().slice(0, all ? undefined : 3);
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px", padding: "10px 14px", background: "var(--panel-2)" }}>
        <PlayerAvatar player={player.ref} size={36} />
        <a href={`#/player/${encodeURIComponent(player.id)}`}>
          <PlayerName player={player.ref} />
        </a>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {player.rating} · {player.wins}W / {player.draws}D / {player.losses}L
        </span>
        <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 13 }}>
          {journal.length} journal {journal.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      {journal.length === 0 && <div className="empty" style={{ padding: 14 }}>No journal entries yet.</div>}
      {shown.map((e) => (
        <div className="journal-entry" key={e.gameId + e.color}>
          <div className="meta">
            {new Date(e.ts).toLocaleString()} · as {colorName(e.color)} · {e.result} · vs {e.opponent} ·{" "}
            <a href={`#/game/${e.gameId}`} style={{ color: "var(--green)" }}>
              view game
            </a>
          </div>
          {e.text}
        </div>
      ))}
      {journal.length > 3 && (
        <div style={{ padding: "8px 14px" }}>
          <button className="btn" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${journal.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

export function MemoryPage() {
  const data = useFetch<MemoryModel[]>("/api/memory");
  const [filter, setFilter] = useState<string | null>(null);
  if (!data) return <div className="empty">Loading…</div>;
  const models = filter ? data.filter((m) => m.model === filter) : data;
  return (
    <div className="page">
      <h1>🧠 Memory</h1>
      <p className="sub">
        What the players carry between games: each model's <b>lessons</b> (a short playbook shared by all its personalities, rewritten after every game) and each player's{" "}
        <b>journal</b> (notes on individual games and opponents).
      </p>
      {data.length === 0 && <div className="card empty">Nobody has played yet.</div>}
      {data.length > 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
          <button className={`btn ${filter === null ? "green" : ""}`} onClick={() => setFilter(null)}>
            All models
          </button>
          {data.map((m) => (
            <button key={m.model} className={`btn ${filter === m.model ? "green" : ""}`} onClick={() => setFilter(m.model)}>
              {m.label}
            </button>
          ))}
        </div>
      )}
      {models.map((m) => (
        <section key={m.model} style={{ marginTop: 26, paddingTop: 6, borderTop: "1px solid var(--line)" }}>
          <h1 style={{ fontSize: 22 }}>{m.label}</h1>
          <LessonsPanel model={m.model} modelLabel={m.label} />
          <h2>📓 Journals</h2>
          {m.players.length === 0 && <div className="card empty">No players for this model yet.</div>}
          {m.players.map((p) => (
            <PlayerJournal key={p.player.id} entry={p} />
          ))}
        </section>
      ))}
    </div>
  );
}
