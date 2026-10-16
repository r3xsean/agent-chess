import { useState } from "react";
import type { Game, Tournament } from "../../../shared/types";
import { api, useFetch, type LaunchSpec, type Meta } from "../api";
import { SeatPicker, type SeatChoice } from "./SeatPicker";
import { saveName, saveSeat, savedName } from "../seat";
import { DEFAULT_BROADCASTER } from "../../../shared/models";

export function BroadcasterPicker({ meta, value, onChange }: { meta: Meta; value: { enabled: boolean; model: string; effort: string }; onChange: (v: { enabled: boolean; model: string; effort: string }) => void }) {
  return (
    <div className="seat" style={{ marginTop: 14 }}>
      <h3>
        🎙 Broadcaster
        <span className={`toggle ${value.enabled ? "on" : ""}`} style={{ marginLeft: "auto" }} onClick={() => onChange({ ...value, enabled: !value.enabled })}>
          {value.enabled ? "On" : "Off"} <span className="sw" />
        </span>
      </h3>
      {value.enabled && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 8 }}>
          <label className="field">
            Model
            <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
              {meta.models.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Effort
            <select value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
              {["low", "medium", "high"].map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

export function LearningToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="seat" style={{ marginTop: 14 }}>
      <h3>
        📚 Learning
        <span className={`toggle ${value ? "on" : ""}`} style={{ marginLeft: "auto" }} onClick={() => onChange(!value)}>
          {value ? "On" : "Off"} <span className="sw" />
        </span>
      </h3>
      <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.45 }}>
        {value
          ? "Players read their model's lessons before and during the game, study their worst moves afterwards, and rewrite the lessons."
          : "Players start fresh: no lessons shown, none written. Useful as a control for experiments."}
      </div>
    </div>
  );
}

/** Chess960 on or off; empty position = a random one (0–959) for each game. */
export interface Chess960Choice {
  on: boolean;
  position: string;
}

export function Chess960Toggle({ value, onChange, tournament }: { value: Chess960Choice; onChange: (v: Chess960Choice) => void; tournament?: boolean }) {
  return (
    <div className="seat" style={{ marginTop: 14 }}>
      <h3>
        🔀 Chess960
        <span className={`toggle ${value.on ? "on" : ""}`} style={{ marginLeft: "auto" }} onClick={() => onChange({ ...value, on: !value.on })}>
          {value.on ? "On" : "Off"} <span className="sw" />
        </span>
      </h3>
      <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.45 }}>
        {value.on
          ? tournament
            ? "Every pairing gets its own random start position (a double round-robin replays it with colours swapped). No opening theory — pure calculation from move one."
            : "The back rank is shuffled, so there's no opening theory to lean on — pure calculation from move one."
          : "Standard chess from the normal starting position."}
      </div>
      {value.on && !tournament && (
        <label className="field" style={{ marginTop: 8 }}>
          Start position (0–959, blank = random)
          <input type="number" min={0} max={959} value={value.position} placeholder="random" onChange={(e) => onChange({ ...value, position: e.target.value })} />
        </label>
      )}
    </div>
  );
}

/** What the server expects: false, true (random) or a position number. */
export const chess960Body = (v: Chess960Choice) => (!v.on ? false : v.position.trim() === "" ? true : Number(v.position));

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
      setErr(e instanceof Error ? e.message : String(e));
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

/** Shown after creating a game or tournament: how to bring the agents in. */
export function SummonInfo({ gameId, tournamentId }: { gameId?: string; tournamentId?: string }) {
  const meta = useFetch<Meta>("/api/meta");
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

export function NewGameModal({ onClose }: { onClose: () => void }) {
  const meta = useFetch<Meta>("/api/meta");
  const [white, setWhite] = useState<SeatChoice>({ model: "claude-opus-5-5", effort: "high", personality: "magician" });
  const [black, setBlack] = useState<SeatChoice>({ model: "gpt-6-astra", effort: "high", personality: "python" });
  const [bc, setBc] = useState({ enabled: true, model: DEFAULT_BROADCASTER.model, effort: DEFAULT_BROADCASTER.effort });
  const [learning, setLearning] = useState(true);
  const [c960, setC960] = useState<Chess960Choice>({ on: false, position: "" });
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState("");
  if (!meta) return null;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{created ? "Game created" : "New game"}</h2>
        {created ? (
          <SummonInfo gameId={created} />
        ) : (
          <>
            <div className="seat-grid">
              <div className="seat">
                <h3>♔ White</h3>
                <SeatPicker meta={meta} value={white} onChange={setWhite} />
              </div>
              <div className="seat">
                <h3>♚ Black</h3>
                <SeatPicker meta={meta} value={black} onChange={setBlack} />
              </div>
            </div>
            <Chess960Toggle value={c960} onChange={setC960} />
            <BroadcasterPicker meta={meta} value={bc} onChange={setBc} />
            <LearningToggle value={learning} onChange={setLearning} />
            {err && <p style={{ color: "var(--c-blunder)" }}>{err}</p>}
            <div className="row-actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn green big"
                onClick={async () => {
                  try {
                    const r = await api<{ game: Game; launch: LaunchSpec }>("/api/games", { white, black, broadcaster: bc, learning, chess960: chess960Body(c960) });
                    setCreated(r.game.id);
                  } catch (e) {
                    setErr(String(e));
                  }
                }}
              >
                Create game
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** You against an agent: you only play the moves — no commentary, evals or interviews. */
export function PlayAgentModal({ onClose }: { onClose: () => void }) {
  const meta = useFetch<Meta>("/api/meta");
  const [name, setName] = useState(savedName);
  const [side, setSide] = useState<"w" | "b" | "random">("w");
  const [agent, setAgent] = useState<SeatChoice>({ model: "claude-opus-5-5", effort: "high", personality: "magician" });
  const [bc, setBc] = useState({ enabled: true, model: DEFAULT_BROADCASTER.model, effort: DEFAULT_BROADCASTER.effort });
  const [learning, setLearning] = useState(true);
  const [c960, setC960] = useState<Chess960Choice>({ on: false, position: "" });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState("");
  if (!meta) return null;
  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      const me = side === "random" ? (Math.random() < 0.5 ? "w" : "b") : side;
      const human = { human: true, name: name.trim() || "Human" };
      saveName(name.trim());
      const r = await api<{ game: Game; humanKey: string }>("/api/games", {
        white: me === "w" ? human : agent,
        black: me === "b" ? human : agent,
        broadcaster: bc,
        learning,
        chess960: chess960Body(c960),
      });
      saveSeat(r.game.id, r.humanKey);
      if (!meta.summonAvailable) return setCreated(r.game.id);
      try {
        await api(`/api/games/${r.game.id}/summon`, {});
      } catch (e) {
        setErr(`Summoning the agent failed: ${e instanceof Error ? e.message : e}`);
        return setCreated(r.game.id);
      }
      // Straight to the board; the agent (and broadcaster) are on their way.
      location.hash = `#/game/${r.game.id}`;
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{created ? "Game created" : "Play an agent"}</h2>
        {created ? (
          <>
            {err && <p style={{ color: "var(--c-blunder)" }}>{err}</p>}
            <SummonInfo gameId={created} />
          </>
        ) : (
          <>
            <p style={{ color: "var(--text-2)", lineHeight: 1.5, marginTop: 0 }}>
              You just play your moves on the board. The engine, the agent's thinking and the broadcaster stay hidden from you until the game ends.
            </p>
            <div className="seat-grid">
              <div className="seat">
                <h3>🧑 You</h3>
                <label className="field">
                  Your name
                  <input type="text" value={name} maxLength={24} placeholder="Human" onChange={(e) => setName(e.target.value)} />
                </label>
                <div className="field">
                  You play
                  <div className="segmented">
                    {(
                      [
                        ["w", "♔ White"],
                        ["b", "♚ Black"],
                        ["random", "🎲 Random"],
                      ] as const
                    ).map(([k, label]) => (
                      <button key={k} className={side === k ? "on" : ""} onClick={() => setSide(k)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="seat">
                <h3>🤖 Your opponent</h3>
                <SeatPicker meta={meta} value={agent} compact onChange={setAgent} />
              </div>
            </div>
            <Chess960Toggle value={c960} onChange={setC960} />
            <BroadcasterPicker meta={meta} value={bc} onChange={setBc} />
            <LearningToggle value={learning} onChange={setLearning} />
            {err && <p style={{ color: "var(--c-blunder)" }}>{err}</p>}
            <div className="row-actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn green big" disabled={busy} onClick={create}>
                {busy ? "Setting up…" : meta.summonAvailable ? "Play" : "Create game"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function NewTournamentModal({ onClose }: { onClose: () => void }) {
  const meta = useFetch<Meta>("/api/meta");
  const [name, setName] = useState("Agent Invitational");
  const [seats, setSeats] = useState<SeatChoice[]>([
    { model: "claude-opus-5-5", effort: "high", personality: "magician" },
    { model: "gpt-6-astra", effort: "high", personality: "python" },
    { model: "claude-sonnet-5-5", effort: "high", personality: "grinder" },
    { model: "gpt-6.1-sol", effort: "high", personality: "streamer" },
  ]);
  const [double, setDouble] = useState(false);
  const [learning, setLearning] = useState(true);
  const [c960, setC960] = useState<Chess960Choice>({ on: false, position: "" });
  const [bc, setBc] = useState({ enabled: true, model: DEFAULT_BROADCASTER.model, effort: DEFAULT_BROADCASTER.effort });
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState("");
  if (!meta) return null;
  const n = seats.length;
  const games = ((n * (n - 1)) / 2) * (double ? 2 : 1);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{created ? "Tournament created" : "New tournament"}</h2>
        {created ? (
          <SummonInfo tournamentId={created} />
        ) : (
          <>
            <label className="field">
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {seats.map((s, i) => (
                <div className="seat" key={i}>
                  <h3>
                    Player {i + 1}
                    <button className="icon-btn" style={{ marginLeft: "auto" }} onClick={() => setSeats(seats.filter((_, j) => j !== i))} disabled={seats.length <= 2}>
                      ✕
                    </button>
                  </h3>
                  <SeatPicker meta={meta} value={s} compact onChange={(v) => setSeats(seats.map((x, j) => (j === i ? v : x)))} />
                </div>
              ))}
            </div>
            <div className="row-actions" style={{ justifyContent: "space-between" }}>
              <button className="btn" onClick={() => setSeats([...seats, { model: "claude-sonnet-5-5", effort: "high", personality: meta.personalities[seats.length % meta.personalities.length].id }])}>
                + Add player
              </button>
              <span className={`toggle ${double ? "on" : ""}`} onClick={() => setDouble(!double)}>
                Double round-robin <span className="sw" />
              </span>
            </div>
            <Chess960Toggle value={c960} onChange={setC960} tournament />
            <BroadcasterPicker meta={meta} value={bc} onChange={setBc} />
            <LearningToggle value={learning} onChange={setLearning} />
            {err && <p style={{ color: "var(--c-blunder)" }}>{err}</p>}
            <div className="row-actions">
              <span style={{ color: "var(--muted)", fontSize: 13 }}>
                {n} players · {games} games
              </span>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn green big"
                onClick={async () => {
                  try {
                    const t = await api<Tournament>("/api/tournaments", { name, players: seats, doubleRound: double, broadcaster: bc, learning, chess960: c960.on });
                    setCreated(t.id);
                  } catch (e) {
                    setErr(String(e));
                  }
                }}
              >
                Create tournament
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
