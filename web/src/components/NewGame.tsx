import { useEffect, useId, useRef, useState } from "react";
import type { Game, ModelOption, PlayerRef, SeatSetup, Tournament } from "../../../shared/types";
import { isNormalSetup, NORMAL_SETUP, setupKey } from "../../../shared/seatSetup";
import { api, useMeta, type LaunchSpec } from "../api";
import { SeatPicker, useRatings, type Ratings, type SeatChoice } from "./ModelPicker";
import { PlayerAvatar } from "./PlayerName";
import { saveName, saveSeat, savedName } from "../seat";
import { sideLooks } from "../../../shared/looks";
import { newRules, START_FEN } from "../../../shared/rules";
import { openingById, openingMovesText, type OpeningStats } from "../../../shared/openingSuite";
import { Board } from "./Board";
import { OpeningPicker, StatsLines, type SeatNames } from "./OpeningPicker";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const idOf = (s: SeatChoice) => `${s.model}@${s.effort}`;
const refOf = (models: ModelOption[], s: SeatChoice): Pick<PlayerRef, "provider" | "modelLabel"> => {
  const m = models.find((x) => x.model === s.model);
  return { provider: m?.provider ?? "", modelLabel: m?.label ?? s.model };
};

/** The dialog every set-up shares: a header with a close button, a scrolling body and a footer that stays put. */
function Modal({ title, subtitle, onClose, footer, children }: { title: string; subtitle?: React.ReactNode; onClose: () => void; footer?: React.ReactNode; children: React.ReactNode }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="modal"
        role="dialog"
        aria-modal
        aria-labelledby={id}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className="modal-head">
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <span className="sw" />
    </button>
  );
}

/** One setting: what it is, what it does now, its switch, and its options while it's on. */
function OptionRow({ icon, title, on, onChange, children, note }: { icon: string; title: string; on: boolean; onChange: (v: boolean) => void; note: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className={`opt-row ${on ? "on" : ""}`}>
      <div className="opt-head" onClick={() => onChange(!on)}>
        <span className="opt-ico" aria-hidden>
          {icon}
        </span>
        <span className="opt-text">
          <b>{title}</b>
          <small>{note}</small>
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <Switch on={on} onChange={onChange} label={title} />
        </span>
      </div>
      {on && children && <div className="opt-body">{children}</div>}
    </div>
  );
}

export function RatedOption({ value, onChange, tournament }: { value: boolean; onChange: (v: boolean) => void; tournament?: boolean }) {
  return (
    <OptionRow
      icon="📈"
      title="Rated"
      on={value}
      onChange={onChange}
      note={
        value
          ? tournament
            ? "Every result updates the players' ratings and leaderboard records."
            : "The result updates the players' ratings and leaderboard records."
          : tournament
            ? "No game in it changes anyone's rating or leaderboard record."
            : "The result doesn't change anyone's rating or leaderboard record."
      }
    />
  );
}

/** One seat's experiment toggles: how it sees the board, and whether it writes the position out each move. */
function SetupPicker({ label, value, onChange }: { label: React.ReactNode; value: SeatSetup; onChange: (v: SeatSetup) => void }) {
  return (
    <div className="setup-pick">
      <span className="mp-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label="How it sees the board">
        {(
          [
            ["text", "📝 Text"],
            ["added", "📷 Text + image"],
            ["image", "🖼️ Image only"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={value.view === k} className={value.view === k ? "on" : ""} onClick={() => onChange({ ...value, view: k })}>
            {l}
          </button>
        ))}
      </div>
      <label className="setup-reread">
        <Switch on={value.reread} onChange={(reread) => onChange({ ...value, reread })} label="Re-read the board" />
        <span>🔁 Re-read: write out every piece before each move (checked against the board)</span>
      </label>
    </div>
  );
}

const SETUP_NOTE =
  "📷 adds a picture of the board each turn (White at the bottom, like the text diagram); 🖼️ gives only the picture. Either way the player must send the picture's check code with each move, so it has to look. Experiment games' agents play through chess tools that bring the picture with each turn.";

/** A game's experiment: each seat's toggles. Off: both see the text briefing as always. */
export interface GameSetupChoice {
  on: boolean;
  w: SeatSetup;
  b: SeatSetup;
}

export function GameSetupOption({ value, onChange, names }: { value: GameSetupChoice; onChange: (v: GameSetupChoice) => void; names: { w: string; b: string } }) {
  return (
    <OptionRow icon="🔬" title="Board-view experiment" on={value.on} onChange={(on) => onChange({ ...value, on })} note={value.on ? SETUP_NOTE : "Both players see the board as text (FEN, piece list and diagram), as always."}>
      <SetupPicker label={<>♔ White · {names.w}</>} value={value.w} onChange={(w) => onChange({ ...value, w })} />
      <SetupPicker label={<>♚ Black · {names.b}</>} value={value.b} onChange={(b) => onChange({ ...value, b })} />
    </OptionRow>
  );
}

const gameSetupBody = (v: GameSetupChoice) => (v.on ? { w: v.w, b: v.b } : undefined);

/** Against a person: only the agent's toggles (you always see the website's board). */
export interface AgentSetupChoice {
  on: boolean;
  setup: SeatSetup;
}

export function AgentSetupOption({ value, onChange, name }: { value: AgentSetupChoice; onChange: (v: AgentSetupChoice) => void; name: string }) {
  return (
    <OptionRow icon="🔬" title="Board-view experiment" on={value.on} onChange={(on) => onChange({ ...value, on })} note={value.on ? SETUP_NOTE : "The agent sees the board as text (FEN, piece list and diagram), as always."}>
      <SetupPicker label={<>🤖 {name}</>} value={value.setup} onChange={(setup) => onChange({ ...value, setup })} />
    </OptionRow>
  );
}

/** A tournament's experiment: one setup for everyone, or a split, `a` against `b` in every pairing. */
export interface TournamentSetupChoice {
  on: boolean;
  split: boolean;
  a: SeatSetup;
  b: SeatSetup;
}

export function TournamentSetupOption({ value, onChange, double }: { value: TournamentSetupChoice; onChange: (v: TournamentSetupChoice) => void; double: boolean }) {
  return (
    <OptionRow icon="🔬" title="Board-view experiment" on={value.on} onChange={(on) => onChange({ ...value, on })} note={value.on ? SETUP_NOTE : "Every player sees the board as text (FEN, piece list and diagram), as always."}>
      <div className="mp">
        <span className="mp-label">Who gets it</span>
        <div className="segmented">
          <button type="button" className={value.split ? "on" : ""} onClick={() => onChange({ ...value, split: true })}>
            Split: A vs B
          </button>
          <button type="button" className={!value.split ? "on" : ""} onClick={() => onChange({ ...value, split: false })}>
            Everyone the same
          </button>
        </div>
        <small className="hint">
          {value.split
            ? double
              ? "In every game one side plays A and the other B. Each pair plays once each way, so every model plays each opponent once under A and once under B, and plays A as White as often as Black (as near as the numbers allow)."
              : "In every game one side plays A and the other B, each model about half its games under each. A double round-robin balances it exactly per opponent."
            : "Every player plays every game under A."}
        </small>
      </div>
      <SetupPicker label={value.split ? "Setup A" : "Setup"} value={value.a} onChange={(a) => onChange({ ...value, a })} />
      {value.split && <SetupPicker label="Setup B" value={value.b} onChange={(b) => onChange({ ...value, b })} />}
    </OptionRow>
  );
}

const tournamentSetupBody = (v: TournamentSetupChoice) => (v.on ? { a: v.a, ...(v.split ? { b: v.b } : {}) } : undefined);
/** On, but nothing to compare: every side would play the normal text briefing anyway. */
const tournamentSetupEmpty = (v: TournamentSetupChoice) => v.on && isNormalSetup(v.a) && (!v.split || isNormalSetup(v.b));
const tournamentSetupSame = (v: TournamentSetupChoice) => v.on && v.split && setupKey(v.a) === setupKey(v.b);

/** Chess960 on or off; empty position = a random one (0–959) for each game. */
export interface Chess960Choice {
  on: boolean;
  position: string;
}

export function Chess960Option({ value, onChange, tournament }: { value: Chess960Choice; onChange: (v: Chess960Choice) => void; tournament?: boolean }) {
  const pos = value.position.trim();
  const bad = pos !== "" && !(Number.isInteger(Number(pos)) && Number(pos) >= 0 && Number(pos) <= 959);
  return (
    <OptionRow
      icon="🔀"
      title="Chess960"
      on={value.on}
      onChange={(on) => onChange({ ...value, on })}
      note={
        value.on
          ? tournament
            ? "Every pairing gets its own random start position (a double round-robin replays it with colours swapped). No opening theory."
            : "The back rank is shuffled, so there's no opening theory to lean on."
          : "Standard chess from the normal starting position."
      }
    >
      {!tournament && (
        <div className="c960-pos">
          <div className="chips">
            <button type="button" className={`chip ${pos === "" ? "on" : ""}`} onClick={() => onChange({ ...value, position: "" })}>
              🎲 Random
            </button>
            <button type="button" className={`chip ${pos === "518" ? "on" : ""}`} onClick={() => onChange({ ...value, position: "518" })} title="Position 518 is the standard set-up">
              518 · standard
            </button>
          </div>
          <label className="inline-field">
            or position
            <input type="number" min={0} max={959} value={value.position} placeholder="0–959" className={bad ? "bad" : ""} onChange={(e) => onChange({ ...value, position: e.target.value })} />
          </label>
          {bad && <span className="field-err">A start position is a whole number from 0 to 959.</span>}
        </div>
      )}
    </OptionRow>
  );
}

const chess960Valid = (v: Chess960Choice) => {
  const p = v.position.trim();
  return !v.on || p === "" || (Number.isInteger(Number(p)) && Number(p) >= 0 && Number(p) <= 959);
};

/** What the server expects: false, true (random) or a position number. */
export const chess960Body = (v: Chess960Choice) => (!v.on ? false : v.position.trim() === "" ? true : Number(v.position));

/** A set opening on or off; an empty `pick` is the one the players have played least (a tournament: each pairing its own). */
export interface OpeningChoice {
  on: boolean;
  pick: string;
}

/** The position the players take over from, and the arena's last move. */
function handover(moves: string[]) {
  const c = newRules(START_FEN, "standard");
  let last: [string, string] | undefined;
  for (const san of moves) {
    const m = c.move(san);
    last = [m.from, m.to];
  }
  return { fen: c.fen(), last };
}

function OpeningPreview({ id, extra }: { id: string; extra?: React.ReactNode }) {
  const o = openingById(id);
  if (!o) return null;
  const h = handover(o.moves);
  return (
    <div className="opening-preview">
      <div style={{ "--size": "168px" } as React.CSSProperties}>
        <Board fen={h.fen} orientation="w" lastMove={h.last} />
      </div>
      <div className="opening-info">
        <b>{o.name}</b>
        <span className="opening-moves">{openingMovesText(o.moves)}</span>
        <small className="hint">{o.kind}</small>
        {extra}
      </div>
    </div>
  );
}

/**
 * The arena plays an opening's first moves and the players take over. A game gets the one its two players have
 * played least, or one picked here; `white`/`black` are the seats as sent to the server, with `names` for
 * them. `coloursKnown` false (colours not drawn yet): the seats only give the numbers, not "next". A tournament
 * gives each pairing its own, or one opening to every game.
 */
export function SetOpeningOption({
  value,
  onChange,
  white,
  black,
  names = null,
  coloursKnown = true,
  tournament,
}: {
  value: OpeningChoice;
  onChange: (v: OpeningChoice) => void;
  white?: unknown;
  black?: unknown;
  names?: SeatNames;
  coloursKnown?: boolean;
  tournament?: boolean;
}) {
  const [data, setData] = useState<{ next: string | null; openings: OpeningStats[] } | null>(null);
  const body = value.on ? JSON.stringify(!tournament && white && black ? { white, black } : {}) : null;
  useEffect(() => {
    if (!body) return;
    let alive = true;
    setData(null);
    api<{ next: string | null; openings: OpeningStats[] }>("/api/openings/stats", JSON.parse(body))
      .then((r) => alive && setData(r))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [body]);
  const auto = value.pick === "";
  const next = coloursKnown && !tournament ? (data?.next ?? null) : null;
  const shown = auto ? next : value.pick;
  const seatNames = tournament ? null : names;
  const note = !value.on
    ? "The players open the game themselves."
    : tournament
      ? auto
        ? "Every pairing starts from the opening its players have played least; a double round-robin replays it with colours swapped."
        : "Every game starts from this opening: a thematic tournament."
      : "The arena plays these moves first; neither player chose them.";
  const autoNote = tournament
    ? "The opening each pairing's players have played least"
    : !coloursKnown || !white || !black
      ? "The opening these two have played least, once the colours are drawn"
      : next
        ? `${openingById(next)?.name}: the one these two have played least`
        : "Finding the one these two have played least…";
  return (
    <OptionRow icon="♟" title="Set opening" on={value.on} onChange={(on) => onChange({ ...value, on })} note={note}>
      <OpeningPicker
        value={value.pick}
        onChange={(pick) => onChange({ ...value, pick })}
        autoLabel={tournament ? "Each pairing gets its own" : "Next for this pair"}
        autoNote={autoNote}
        next={next}
        stats={data?.openings}
        names={seatNames}
      />
      {shown && <OpeningPreview id={shown} extra={<StatsLines s={data?.openings.find((s) => s.id === shown)} names={seatNames} />} />}
    </OptionRow>
  );
}

/** What the server expects for a game: nothing, true (the least played) or an opening id. Off under Chess960. */
const openingBody = (v: OpeningChoice, c960: Chess960Choice) => (c960.on || !v.on ? undefined : v.pick || true);

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

/** The expected score from two ratings (the Elo curve), or null when either side has no rated games. */
function expected(ratings: Ratings, a: string, b: string): number | null {
  const ra = ratings.get(a)?.rating, rb = ratings.get(b)?.rating;
  return ra == null || rb == null ? null : 1 / (1 + 10 ** ((rb - ra) / 400));
}

/** Who's favoured: a bar split by each side's expected score, in the colours they'll wear on the board. */
function Matchup({ ratings, white, black, whiteId, blackId }: { ratings: Ratings; white: Pick<PlayerRef, "provider" | "modelLabel">; black: Pick<PlayerRef, "provider" | "modelLabel">; whiteId: string; blackId: string }) {
  const looks = sideLooks({ white: white as PlayerRef, black: black as PlayerRef });
  const e = expected(ratings, whiteId, blackId);
  if (e === null) {
    const missing = [!ratings.has(whiteId) && white.modelLabel, !ratings.has(blackId) && black.modelLabel].filter(Boolean);
    return <div className="matchup quiet">{missing.join(" and ")} {missing.length > 1 ? "have" : "has"} no rated {ratings.variant === "chess960" ? "Chess960 " : ""}games at this effort yet, so there's no prediction.</div>;
  }
  const w = Math.round(e * 100);
  return (
    <div className="matchup">
      <div className="matchup-labels">
        <span>
          <b style={{ color: looks.w.color }}>{white.modelLabel}</b> {w}%
        </span>
        <span className="muted">expected score{ratings.variant === "chess960" ? " · from Chess960 ratings" : ""}</span>
        <span>
          {100 - w}% <b style={{ color: looks.b.color }}>{black.modelLabel}</b>
        </span>
      </div>
      <div className="matchup-bar">
        <i style={{ width: `${w}%`, background: looks.w.color }} />
        <i style={{ width: `${100 - w}%`, background: looks.b.color }} />
      </div>
    </div>
  );
}

function SeatCard({ title, children, className = "" }: { title: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`seat ${className}`}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** The settings at a glance, for the footer. */
const summary = (rated: boolean, c960: Chess960Choice, opening: OpeningChoice, experiment = false) =>
  [rated ? "Rated" : "Unrated", c960.on ? "Chess960" : opening.on ? "Set opening" : "Standard chess", ...(experiment ? ["🔬 Experiment"] : [])].join(" · ");

const Err = ({ text }: { text: string }) => (text ? <p className="form-err" role="alert">{text}</p> : null);

export function NewGameModal({ onClose }: { onClose: () => void }) {
  const meta = useMeta();
  const [white, setWhite] = useState<SeatChoice>({ model: "claude-opus-5-5", effort: "high" });
  const [black, setBlack] = useState<SeatChoice>({ model: "gpt-6-astra", effort: "high" });
  const [rated, setRated] = useState(true);
  const [c960, setC960] = useState<Chess960Choice>({ on: false, position: "" });
  const [opening, setOpening] = useState<OpeningChoice>({ on: false, pick: "" });
  const [setup, setSetup] = useState<GameSetupChoice>({ on: false, w: { view: "added", reread: false }, b: NORMAL_SETUP });
  // Chess960 is rated apart: with it on, every rating shown is the Chess960 one.
  const ratings = useRatings(c960.on ? "chess960" : "standard");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState("");
  if (!meta) return null;
  const same = idOf(white) === idOf(black);
  const experiment = setup.on && !(isNormalSetup(setup.w) && isNormalSetup(setup.b));
  const ok = !same && chess960Valid(c960);
  const swap = () => (setWhite(black), setBlack(white));
  const random = () => {
    const pool = [...meta.models].sort(() => Math.random() - 0.5);
    setWhite({ model: pool[0].model, effort: pool[0].defaultEffort });
    setBlack({ model: pool[1].model, effort: pool[1].defaultEffort });
  };
  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ game: Game; launch: LaunchSpec }>("/api/games", { white, black, rated, chess960: chess960Body(c960), opening: openingBody(opening, c960), seats: gameSetupBody(setup) });
      setCreated(r.game.id);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (created)
    return (
      <Modal title="Game created" onClose={onClose}>
        <SummonInfo gameId={created} />
      </Modal>
    );
  return (
    <Modal
      title="New game"
      subtitle="Two agents play each other while the engine reviews every move."
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">{same ? <span className="warn">Both seats are the same player — change the model or effort.</span> : summary(rated, c960, opening, experiment)}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn green big" disabled={busy || !ok} onClick={create}>
            {busy ? "Creating…" : "Create game"}
          </button>
        </>
      }
    >
      <div className="versus">
        <SeatCard title={<><span className="side-king">♔</span> White</>}>
          <SeatPicker models={meta.models} value={white} onChange={setWhite} ratings={ratings} seated={new Set([black.model])} />
        </SeatCard>
        <div className="versus-mid">
          <span className="vs">VS</span>
          <button type="button" className="round-btn" onClick={swap} title="Swap colours" aria-label="Swap colours">
            ⇄
          </button>
          <button type="button" className="round-btn" onClick={random} title="Random matchup" aria-label="Random matchup">
            🎲
          </button>
        </div>
        <SeatCard title={<><span className="side-king">♚</span> Black</>}>
          <SeatPicker models={meta.models} value={black} onChange={setBlack} ratings={ratings} seated={new Set([white.model])} />
        </SeatCard>
      </div>
      {!same && <Matchup ratings={ratings} white={refOf(meta.models, white)} black={refOf(meta.models, black)} whiteId={idOf(white)} blackId={idOf(black)} />}
      <div className="opt-list">
        <Chess960Option value={c960} onChange={setC960} />
        {!c960.on && (
          <SetOpeningOption
            value={opening}
            onChange={setOpening}
            white={same ? undefined : white}
            black={same ? undefined : black}
            names={same ? null : { w: refOf(meta.models, white).modelLabel, b: refOf(meta.models, black).modelLabel }}
          />
        )}
        <GameSetupOption value={setup} onChange={setSetup} names={{ w: refOf(meta.models, white).modelLabel, b: refOf(meta.models, black).modelLabel }} />
        <RatedOption value={rated} onChange={setRated} />
      </div>
      <Err text={err} />
    </Modal>
  );
}

/** You against an agent: you only play the moves — no commentary, evals or interviews. */
export function PlayAgentModal({ onClose }: { onClose: () => void }) {
  const meta = useMeta();
  const [name, setName] = useState(savedName);
  const [side, setSide] = useState<"w" | "b" | "random">("w");
  const [agent, setAgent] = useState<SeatChoice>({ model: "claude-opus-5-5", effort: "high" });
  const [rated, setRated] = useState(true);
  const [c960, setC960] = useState<Chess960Choice>({ on: false, position: "" });
  const [opening, setOpening] = useState<OpeningChoice>({ on: false, pick: "" });
  const [setup, setSetup] = useState<AgentSetupChoice>({ on: false, setup: { view: "added", reread: false } });
  // Chess960 is rated apart: with it on, every rating shown is the Chess960 one.
  const ratings = useRatings(c960.on ? "chess960" : "standard");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState("");
  if (!meta) return null;
  const experiment = setup.on && !isNormalSetup(setup.setup);
  const myName = name.trim() || "Human";
  const human = { human: true, name: myName };
  const me = { provider: "human", modelLabel: myName };
  const myId = `human:${myName.toLowerCase()}`;
  const mine = ratings.get(myId);
  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      const color = side === "random" ? (Math.random() < 0.5 ? "w" : "b") : side;
      saveName(name.trim());
      const r = await api<{ game: Game; humanKey: string }>("/api/games", {
        white: color === "w" ? human : agent,
        black: color === "b" ? human : agent,
        rated,
        chess960: chess960Body(c960),
        opening: openingBody(opening, c960),
        // The human seat's is dropped by the server, so the agent's can go on both.
        seats: setup.on ? { w: setup.setup, b: setup.setup } : undefined,
      });
      saveSeat(r.game.id, r.humanKey);
      if (!meta.summonAvailable) return setCreated(r.game.id);
      try {
        await api(`/api/games/${r.game.id}/summon`, {});
      } catch (e) {
        setErr(`Summoning the agent failed: ${errText(e)}`);
        return setCreated(r.game.id);
      }
      // Straight to the board; the agent is on its way.
      location.hash = `#/game/${r.game.id}`;
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (created)
    return (
      <Modal title="Game created" onClose={onClose}>
        <Err text={err} />
        <SummonInfo gameId={created} />
      </Modal>
    );
  const agentRef = refOf(meta.models, agent);
  return (
    <Modal
      title="Play an agent"
      subtitle="You just play your moves. The engine and the agent's thinking stay hidden from you until the game ends."
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">{summary(rated, c960, opening, experiment)}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn green big" disabled={busy || !chess960Valid(c960)} onClick={create}>
            {busy ? "Setting up…" : meta.summonAvailable ? "Play" : "Create game"}
          </button>
        </>
      }
    >
      <div className="versus">
        <SeatCard title="You">
          <div className="you-row">
            <PlayerAvatar player={me} size={38} />
            <label className="mp" style={{ flex: 1 }}>
              <span className="mp-label">Your name</span>
              <input type="text" value={name} maxLength={24} placeholder="Human" onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          <div className="you-rating">{mine ? `Your ${ratings.variant === "chess960" ? "Chess960 rating" : "rating"}: ${mine.rating}${mine.rd > 110 ? "?" : ""} · ${mine.wins}W ${mine.draws}D ${mine.losses}L` : ratings.variant === "chess960" ? "No rated Chess960 games under this name yet." : "No rated games under this name yet."}</div>
          <div className="mp">
            <span className="mp-label">You play</span>
            <div className="segmented" role="radiogroup" aria-label="You play">
              {(
                [
                  ["w", <><span className="side-king">♔</span> White</>],
                  ["b", <><span className="side-king">♚</span> Black</>],
                  ["random", "🎲 Random"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={side === k} className={side === k ? "on" : ""} onClick={() => setSide(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </SeatCard>
        <div className="versus-mid">
          <span className="vs">VS</span>
        </div>
        <SeatCard title="Your opponent">
          <SeatPicker models={meta.models} value={agent} onChange={setAgent} ratings={ratings} />
        </SeatCard>
      </div>
      {side !== "random" && (
        <Matchup
          ratings={ratings}
          white={side === "w" ? me : agentRef}
          black={side === "w" ? agentRef : me}
          whiteId={side === "w" ? myId : idOf(agent)}
          blackId={side === "w" ? idOf(agent) : myId}
        />
      )}
      <div className="opt-list">
        <Chess960Option value={c960} onChange={setC960} />
        {!c960.on && (
          <SetOpeningOption
            value={opening}
            onChange={setOpening}
            white={side === "b" ? agent : human}
            black={side === "b" ? human : agent}
            names={side === "b" ? { w: agentRef.modelLabel, b: myName } : { w: myName, b: agentRef.modelLabel }}
            coloursKnown={side !== "random"}
          />
        )}
        <AgentSetupOption value={setup} onChange={setSetup} name={agentRef.modelLabel} />
        <RatedOption value={rated} onChange={setRated} />
      </div>
      <Err text={err} />
    </Modal>
  );
}

const BREAKS: [number, string][] = [
  [0, "None"],
  [1, "1 h"],
  [6, "6 h"],
  [24, "1 day"],
];

export function NewTournamentModal({ onClose }: { onClose: () => void }) {
  const meta = useMeta();
  const [name, setName] = useState("Agent Invitational");
  const [seats, setSeats] = useState<SeatChoice[]>([
    { model: "claude-opus-5-5", effort: "high" },
    { model: "gpt-6-astra", effort: "high" },
    { model: "claude-sonnet-5-5", effort: "high" },
    { model: "gpt-6.1-sol", effort: "high" },
  ]);
  const [double, setDouble] = useState(false);
  const [boards, setBoards] = useState(0);
  const [breakHours, setBreakHours] = useState(0);
  const [rated, setRated] = useState(true);
  const [c960, setC960] = useState<Chess960Choice>({ on: false, position: "" });
  const [opening, setOpening] = useState<OpeningChoice>({ on: false, pick: "" });
  const [setup, setSetup] = useState<TournamentSetupChoice>({ on: false, split: true, a: { view: "added", reread: false }, b: NORMAL_SETUP });
  // Chess960 is rated apart: with it on, every rating shown is the Chess960 one.
  const ratings = useRatings(c960.on ? "chess960" : "standard");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState("");
  if (!meta) return null;
  const n = seats.length;
  const setupBad = tournamentSetupEmpty(setup) || tournamentSetupSame(setup);
  const games = ((n * (n - 1)) / 2) * (double ? 2 : 1);
  const maxBoards = Math.max(1, Math.floor(n / 2));
  const board = Math.min(boards, maxBoards);
  const rounds = (n % 2 ? n : n - 1) * (double ? 2 : 1);
  // The first seat holding each player: a later seat with the same model and effort is a duplicate.
  const firstOf = new Map<string, number>();
  seats.forEach((s, i) => !firstOf.has(idOf(s)) && firstOf.set(idOf(s), i));
  const dupes = seats.filter((s, i) => firstOf.get(idOf(s)) !== i).length;
  const breakBad = !(breakHours >= 0 && breakHours <= 8760);
  const ok = dupes === 0 && n >= 2 && !breakBad && !setupBad && name.trim() !== "";
  // A player is a model and effort, so the new seat takes a model not seated yet.
  const addSeat = () => {
    const m = meta.models.find((x) => !seats.some((s) => s.model === x.model)) ?? meta.models[0];
    setSeats([...seats, { model: m.model, effort: m.defaultEffort }]);
  };
  const addAll = () => setSeats([...seats, ...meta.models.filter((x) => !seats.some((s) => s.model === x.model)).map((m) => ({ model: m.model, effort: m.defaultEffort }))]);
  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      const openings = !c960.on && opening.on ? opening.pick || "each" : undefined;
      const t = await api<Tournament>("/api/tournaments", { name: name.trim(), players: seats, doubleRound: double, rated, chess960: c960.on, openings, boards: board || undefined, breakHours, setups: tournamentSetupBody(setup) });
      setCreated(t.id);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (created)
    return (
      <Modal title="Tournament created" onClose={onClose}>
        <SummonInfo tournamentId={created} />
      </Modal>
    );
  return (
    <Modal
      title="New tournament"
      subtitle="A round-robin: every player meets every other, with colours balanced."
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">
            {dupes ? (
              <span className="warn">Two seats are the same player — change the model or effort.</span>
            ) : setupBad ? (
              <span className="warn">{tournamentSetupSame(setup) ? "Setups A and B are the same: change one, or play everyone the same." : "Pick a setup other than plain text, or turn the experiment off."}</span>
            ) : (
              <>
                <b>{n}</b> players · <b>{games}</b> games · <b>{rounds}</b> rounds · {summary(rated, c960, opening, setup.on)}
              </>
            )}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn green big" disabled={busy || !ok} onClick={create}>
            {busy ? "Creating…" : "Create tournament"}
          </button>
        </>
      }
    >
      <label className="mp">
        <span className="mp-label">Name</span>
        <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="section-head">
        <h3>Players</h3>
        <span className="muted">{n}</span>
        <span className="spacer" />
        <button className="btn small" onClick={addAll} disabled={meta.models.every((x) => seats.some((s) => s.model === x.model))}>
          Add every model
        </button>
        <button className="btn small" onClick={addSeat}>
          + Add player
        </button>
      </div>
      <div className="seat-grid">
        {seats.map((s, i) => {
          const first = firstOf.get(idOf(s))!;
          return (
            <div className={`seat ${first !== i ? "dupe" : ""}`} key={i}>
              <h3 className="seat-top">
                <span className="seat-num">{i + 1}</span>
                Player {i + 1}
                {first !== i && <span className="warn small">· same as player {first + 1}</span>}
                <button className="icon-btn" style={{ marginLeft: "auto" }} onClick={() => setSeats(seats.filter((_, j) => j !== i))} disabled={n <= 2} aria-label={`Remove player ${i + 1}`} title="Remove">
                  ✕
                </button>
              </h3>
              <SeatPicker
                label=""
                models={meta.models}
                value={s}
                onChange={(v) => setSeats(seats.map((x, j) => (j === i ? v : x)))}
                ratings={ratings}
                seated={new Set(seats.filter((_, j) => j !== i).map((x) => x.model))}
              />
            </div>
          );
        })}
      </div>

      <div className="section-head">
        <h3>Format</h3>
      </div>
      <div className="format-grid">
        <div className="mp">
          <span className="mp-label">Round-robin</span>
          <div className="segmented">
            <button type="button" className={!double ? "on" : ""} onClick={() => setDouble(false)}>
              Single
            </button>
            <button type="button" className={double ? "on" : ""} onClick={() => setDouble(true)}>
              Double
            </button>
          </div>
          <small className="hint">{double ? "Each pair plays twice, once with each colour." : "Each pair plays once."}</small>
        </div>
        <div className="mp">
          <span className="mp-label">Boards at once</span>
          <div className="chips">
            <button type="button" className={`chip ${board === 0 ? "on" : ""}`} onClick={() => setBoards(0)}>
              Auto
            </button>
            {Array.from({ length: maxBoards }, (_, i) => (
              <button key={i} type="button" className={`chip ${board === i + 1 ? "on" : ""}`} onClick={() => setBoards(i + 1)}>
                {i + 1}
              </button>
            ))}
          </div>
          <small className="hint">{board === 0 ? `As many as the players fill (${maxBoards}).` : board === 1 ? "One game at a time." : `${board} games at a time.`}</small>
        </div>
        <div className="mp">
          <span className="mp-label">Break between games</span>
          <div className="chips">
            {BREAKS.map(([h, l]) => (
              <button key={h} type="button" className={`chip ${breakHours === h ? "on" : ""}`} onClick={() => setBreakHours(h)}>
                {l}
              </button>
            ))}
            <label className="inline-field">
              <input type="number" min="0" max="8760" step="0.25" value={breakHours} className={breakBad ? "bad" : ""} onChange={(e) => setBreakHours(Number(e.target.value))} aria-label="Break in hours" />h
            </label>
          </div>
          <small className="hint">Starts once all active boards finish.</small>
        </div>
      </div>

      <div className="opt-list">
        <Chess960Option value={c960} onChange={setC960} tournament />
        {!c960.on && <SetOpeningOption value={opening} onChange={setOpening} tournament />}
        <TournamentSetupOption value={setup} onChange={setSetup} double={double} />
        <RatedOption value={rated} onChange={setRated} tournament />
      </div>
      <Err text={err} />
    </Modal>
  );
}
