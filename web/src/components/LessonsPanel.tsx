import { useState } from "react";
import type { Lessons } from "../../../shared/types";
import { api, useFetch } from "../api";

/** A model's self-written playbook, shared by all its personalities, with revision history and reset. */
export function LessonsPanel({ model, modelLabel }: { model: string; modelLabel: string }) {
  const [rev, setRev] = useState(0);
  const lessons = useFetch<Lessons>(`/api/lessons/${encodeURIComponent(model)}`, [model, rev]);
  const [showHistory, setShowHistory] = useState(false);
  if (!lessons) return null;
  const history = [...lessons.history].reverse();
  return (
    <>
      <h2 style={{ display: "flex", alignItems: "center", gap: 10 }}>
        📚 Lessons <span style={{ color: "var(--muted)", fontSize: 13, fontWeight: 500 }}>shared by every {modelLabel} player · v{lessons.version}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {history.length > 0 && (
            <button className="btn" onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? "Hide history" : `History (${history.length})`}
            </button>
          )}
          <button
            className="btn"
            disabled={!lessons.text}
            onClick={async () => {
              if (!confirm(`Reset ${modelLabel}'s lessons? Every ${modelLabel} player starts its next game with no lessons. (History is kept.)`)) return;
              await api(`/api/lessons/${encodeURIComponent(model)}/reset`, {});
              setRev(rev + 1);
            }}
          >
            Reset memory
          </button>
        </span>
      </h2>
      <div className="card" style={{ padding: "12px 14px" }}>
        {lessons.text ? (
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, fontSize: 14 }}>{lessons.text}</div>
        ) : (
          <div className="empty" style={{ padding: 12 }}>
            No lessons yet. After each game with learning on, the player studies its worst moves and rewrites this list.
          </div>
        )}
        {lessons.updatedAt && (
          <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 8 }}>Last updated {new Date(lessons.updatedAt).toLocaleString()}</div>
        )}
      </div>
      {showHistory && (
        <div className="card" style={{ marginTop: 10 }}>
          {history.map((h) => (
            <div className="journal-entry" key={h.version}>
              <div className="meta">
                v{h.version} · {new Date(h.ts).toLocaleString()} ·{" "}
                {h.gameId ? (
                  <a href={`#/game/${h.gameId}`} style={{ color: "var(--green)" }}>
                    after game {h.gameId}
                  </a>
                ) : (
                  "reset"
                )}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{h.text || <i style={{ color: "var(--muted)" }}>(empty)</i>}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
