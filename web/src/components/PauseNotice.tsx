import type { Game, GamePause } from "../../../shared/types";
import { fullName } from "../../../shared/naming";

export function PauseNotice({ pause, game, compact = false }: { pause: GamePause; game: Pick<Game, "white" | "black">; compact?: boolean }) {
  const waiting = pause.seats?.map((c) => fullName(c === "w" ? game.white : game.black)).join(" and ");
  return (
    <div className={compact ? "pause-summary" : "pause-notice"} role="status">
      {!compact && <strong><span aria-hidden="true">⏸</span> Game paused</strong>}
      <div className="pause-reason">{pause.reason}</div>
      {!compact && <>
        {waiting && <div>Waiting for {waiting}.</div>}
        {pause.resetAt && <div>Expected reset: <time dateTime={new Date(pause.resetAt).toISOString()}>{new Date(pause.resetAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</time>.</div>}
        <div className="pause-explanation">Thinking timers are frozen. {pause.code === "usage_limit" ? "Play continues automatically when the affected players act again." : "Waiting for the operator to resume the game."}</div>
      </>}
    </div>
  );
}
