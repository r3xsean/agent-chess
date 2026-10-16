import { useState } from "react";
import type { Color, Game, Result } from "../../../shared/types";
import { sideName } from "../../../shared/naming";
import { START_FEN } from "../../../shared/rules";
import { useStream } from "../api";
import { crowdApi, renameViewer, type ViewerInfo } from "../viewer";

export interface CrowdState {
  open: { result: boolean; move: boolean };
  lockPly: number;
  points: { result: number; move: number };
  result: { tally: Record<Result, number>; total: number; mine: Result | null; actual: Result | null };
  move: { ply: number; total: number; top: { uci: string; san: string; n: number }[]; mine: { uci: string; san: string } | null };
  lastMove: { ply: number; san: string; total: number; right: number; mine: boolean | null } | null;
  you: { name: string; points: number; right: number; calls: number; rank: number } | null;
}

/** The live crowd for a game, from the prediction server. */
export function useCrowd(base: string | null, gameId: string, viewer: ViewerInfo | null) {
  return useStream<CrowdState>(base !== null && viewer ? `${base}/api/games/${gameId}/crowd/stream?viewer=${encodeURIComponent(viewer.id)}` : null);
}

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

/** Call the result, guess the next move, and see how the crowd is doing. */
export function CrowdPanel({
  game,
  base,
  viewer,
  setViewer,
  crowd,
  guessing,
  setGuessing,
}: {
  game: Game;
  base: string;
  viewer: ViewerInfo | null;
  setViewer: (v: ViewerInfo) => void;
  crowd: CrowdState | null;
  guessing: boolean;
  setGuessing: (on: boolean) => void;
}) {
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  if (!viewer || !crowd) return <div className="empty">Connecting to the prediction desk…</div>;

  const call = async (pick: Result) => {
    setErr("");
    try {
      await crowdApi(base, `/api/games/${game.id}/predict`, { viewer: viewer.id, kind: "result", pick });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const r = crowd.result;
  const options: [Result, string, Color | null][] = [
    ["1-0", sideName(game, "w"), "w"],
    ["1/2-1/2", "Draw", null],
    ["0-1", sideName(game, "b"), "b"],
  ];
  const mover = (game.moves[game.moves.length - 1]?.fenAfter ?? game.startFen ?? START_FEN).split(" ")[1] as Color;
  const you = crowd.you;
  // The prediction desk may hear of a move a moment after this page shows it (on the local site): no guessing a move you've seen.
  const moveOpen = crowd.open.move && crowd.move.ply === game.moves.length + 1;

  return (
    <div className="crowd">
      <div className="crowd-you">
        {editing ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                setViewer(await renameViewer(base, viewer.id, name));
                setEditing(false);
              } catch (x) {
                setErr(x instanceof Error ? x.message : String(x));
              }
            }}
          >
            <input autoFocus type="text" maxLength={20} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            <button className="btn green">Save</button>
          </form>
        ) : (
          <>
            <span>
              🔮 <b>{you?.name ?? viewer.name}</b> · {you?.points ?? 0} pts{you && you.calls > 0 ? ` · #${you.rank}` : ""}
            </span>
            <button
              className="icon-btn"
              title="Change your name"
              onClick={() => {
                setName(you?.name ?? viewer.name);
                setEditing(true);
              }}
            >
              ✎
            </button>
          </>
        )}
      </div>

      <div className="crowd-block">
        <div className="crowd-title">
          Who wins?{" "}
          <span className="muted">
            {r.actual ? "final" : crowd.open.result ? `${crowd.points.result} pts if you're right · closes at move ${crowd.lockPly / 2}` : "calls are closed"}
          </span>
        </div>
        {options.map(([pick, label]) => {
          const share = pct(r.tally[pick], r.total);
          const won = r.actual === pick;
          return (
            <button
              key={pick}
              className={`crowd-option ${r.mine === pick ? "mine" : ""} ${won ? "won" : ""}`}
              disabled={!crowd.open.result}
              onClick={() => call(pick)}
              title={crowd.open.result ? "Your call — you can change it until move 10" : undefined}
            >
              <span className="crowd-fill" style={{ width: `${share}%` }} />
              <span className="crowd-label">
                {won && "🏆 "}
                {label}
                {r.mine === pick && <small> · your call</small>}
              </span>
              <span className="crowd-share">{share}%</span>
            </button>
          );
        })}
        <div className="muted small">
          {r.total} call{r.total === 1 ? "" : "s"}
          {r.actual && r.mine && (r.actual === r.mine ? ` · you called it! +${crowd.points.result}` : " · not this time")}
        </div>
      </div>

      {(moveOpen || crowd.lastMove) && (
        <div className="crowd-block">
          <div className="crowd-title">
            Next move <span className="muted">{crowd.points.move} pts per correct guess</span>
          </div>
          {crowd.lastMove && (
            <div className="crowd-last">
              {crowd.lastMove.san}: {crowd.lastMove.right} of {crowd.lastMove.total} guessed it
              {crowd.lastMove.mine === true && <b className="good"> · you did! +{crowd.points.move}</b>}
              {crowd.lastMove.mine === false && <span className="muted"> · you missed</span>}
            </div>
          )}
          {moveOpen &&
            (guessing ? (
              <div className="crowd-arm on">
                🎯 Play {sideName(game, mover)}'s next move on the board…
                <button className="btn" onClick={() => setGuessing(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="crowd-arm">
                {crowd.move.mine ? (
                  <span>
                    Your guess: <b>{crowd.move.mine.san}</b>
                  </span>
                ) : (
                  <span>What will {sideName(game, mover)} play?</span>
                )}
                <button className="btn green" onClick={() => setGuessing(true)}>
                  {crowd.move.mine ? "Change guess" : "🎯 Guess"}
                </button>
              </div>
            ))}
          {moveOpen && crowd.move.total > 0 && (
            <div className="crowd-top">
              {crowd.move.mine ? (
                crowd.move.top.map((t) => (
                  <span key={t.uci} className={t.uci === crowd.move.mine?.uci ? "mine" : ""}>
                    {t.san} <small>{pct(t.n, crowd.move.total)}%</small>
                  </span>
                ))
              ) : (
                <span className="muted">
                  {crowd.move.total} viewer{crowd.move.total === 1 ? " has" : "s have"} guessed — guess to see what they picked
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {err && <div className="play-err">{err}</div>}
    </div>
  );
}
