import type { PlayerRef } from "../../../shared/types";
import { makerOf } from "../../../shared/models";
import { fullName, isHuman } from "../../../shared/naming";

/** The word that tells models apart at a glance: "Opus", "Haiku", "Sol", "Luna"… */
export function modelMark(p: Pick<PlayerRef, "provider" | "modelLabel">): string {
  const words = p.modelLabel.split(" ");
  return p.provider === "codex" ? words[words.length - 1] : words[0];
}

/** A player's face: their model in its maker's colour. */
export function PlayerAvatar({ player, size = 40 }: { player: PlayerRef; size?: number }) {
  const maker = makerOf(player.provider);
  if (isHuman(player))
    return (
      <div className="player-avatar" style={{ width: size, height: size, background: maker.color }} title={`${player.modelLabel} (human)`}>
        <span style={{ fontSize: size * 0.55 }}>🧑</span>
      </div>
    );
  const mark = modelMark(player);
  return (
    <div className="player-avatar" style={{ width: size, height: size, background: maker.color }} title={fullName(player)}>
      <span style={{ fontSize: size * (mark.length > 5 ? 0.22 : 0.27) }}>{mark}</span>
    </div>
  );
}

/** The model's name in its maker's colour, with the effort. */
export function PlayerName({ player, effort = true, className = "" }: { player: PlayerRef; effort?: boolean; className?: string }) {
  const maker = makerOf(player.provider);
  return (
    <span className={`player-fullname ${className}`}>
      <b style={{ color: maker.color }}>{player.modelLabel}</b>
      {effort && <small className="effort">{isHuman(player) ? "human" : player.effort}</small>}
    </span>
  );
}
