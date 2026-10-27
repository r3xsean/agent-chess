import { useState } from "react";
import type { Game } from "../../../shared/types";
import { api, useMeta } from "../api";
import { saveSeat } from "../seat";

/* A game's and a tournament's action buttons, apart from the new-game forms so a game page loads without them. */

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The one-click way: ask T3 (via its webhook) to summon the agents. */
export function SummonButton({ gameId, tournamentId, compact }: { gameId?: string; tournamentId?: string; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "already" | "error">("idle");
  const [err, setErr] = useState("");
  const label = tournamentId ? "▶ Start tournament" : "⚡ Summon agents";
  const send = async (force = false) => {
    setState("sending");
    try {
      const r = await api<{ already?: boolean; alreadyRunning?: string }>(
        tournamentId ? `/api/tournaments/${tournamentId}/start` : `/api/games/${gameId}/summon`,
        { force },
      );
      setState(r.already ? "already" : "sent");
    } catch (e) {
      setErr(errText(e));
      setState("error");
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button className={`btn green ${compact ? "" : "big"}`} disabled={state === "sending"} onClick={() => send(state === "already")}>
        {state === "sending" ? "Summoning…" : state === "already" ? "Summon again anyway" : label}
      </button>
      {state === "sent" && (
        <span style={{ color: "var(--green-hover)", fontSize: 13 }}>
          {tournamentId
            ? "Started — T3 launches each game in turn; the next pairing starts automatically when a game ends."
            : "Sent — a T3 orchestrator is launching the players. They usually arrive within a minute."}
        </span>
      )}
      {state === "already" && (
        <span style={{ color: "var(--c-inaccuracy)", fontSize: 13 }}>
          Agents were already summoned in the last 10 minutes — they may still be starting up.
        </span>
      )}
      {state === "error" && <span style={{ color: "var(--c-blunder)", fontSize: 13 }}>{err}</span>}
    </div>
  );
}

/** The same game again with the colours swapped (same set opening, rated the same way), then its board. */
export function RematchButton({ gameId }: { gameId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ game: Game; humanKey?: string }>(`/api/games/${gameId}/rematch`, {});
      if (r.humanKey) saveSeat(r.game.id, r.humanKey);
      location.hash = `#/game/${r.game.id}`;
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn" disabled={busy} onClick={go} title="Play the same opening again, each side with the other colour">
        {busy ? "Setting up…" : "⇄ Rematch, colours swapped"}
      </button>
      {err && <span style={{ color: "var(--c-blunder)", fontSize: 13 }}>{err}</span>}
    </>
  );
}

/** Shown after creating a game or tournament: how to bring the agents in. */
export function SummonInfo({ gameId, tournamentId }: { gameId?: string; tournamentId?: string }) {
  const meta = useMeta();
  const phrase = tournamentId ? `run chess tournament ${tournamentId}` : `summon chess game ${gameId}`;
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {meta?.summonAvailable ? (
        <>
          <p style={{ color: "var(--text-2)", lineHeight: 1.5, marginTop: 0 }}>
            The {tournamentId ? "tournament is" : "board is"} set up. Click to have T3 summon the agents with <code>$delegate</code>
            {tournamentId ? " and run every game in turn." : "."}
          </p>
          <SummonButton gameId={gameId} tournamentId={tournamentId} />
        </>
      ) : (
        <p style={{ color: "var(--text-2)", lineHeight: 1.5, marginTop: 0 }}>
          The {tournamentId ? "tournament is" : "board is"} set up. Agents are summoned by your orchestrator (Claude in T3 Code) through <code>$delegate</code>.
        </p>
      )}
      <p style={{ color: "var(--muted)", fontSize: 13, margin: "14px 0 6px" }}>
        {meta?.summonAvailable ? "Or paste this into a Claude chat in T3:" : "Paste this into the chat:"}
      </p>
      <div className="codebox">{phrase}</div>
      <div className="row-actions" style={{ justifyContent: "flex-start" }}>
        <button
          className="btn"
          onClick={() => {
            navigator.clipboard.writeText(phrase);
            setCopied(true);
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <a className="btn" href={tournamentId ? `#/tournament/${tournamentId}` : `#/game/${gameId}`}>
          Go to {tournamentId ? "tournament" : "board"} →
        </a>
      </div>
    </div>
  );
}
