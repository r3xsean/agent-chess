import type { PlayerRef } from "../../../shared/types";
import { personalityById } from "../../../shared/personalities";
import { makerOf } from "../../../shared/models";
import { fullName, isHuman } from "../../../shared/naming";

/** The word that tells models apart at a glance: "Opus", "Haiku", "Sol", "Luna"… */
export function modelMark(p: Pick<PlayerRef, "provider" | "modelLabel">): string {
  const words = p.modelLabel.split(" ");
  return p.provider === "codex" ? words[words.length - 1] : words[0];
}

/** A player's face: their model in its maker's colour, with the personality as a badge. */
export function PlayerAvatar({ player, size = 40 }: { player: PlayerRef; size?: number }) {
  const maker = makerOf(player.provider);
  const persona = personalityById(player.personality);
  if (isHuman(player))
    return (
      <div className="player-avatar" style={{ width: size, height: size, background: maker.color }} title={`${player.modelLabel} (human)`}>
        <span style={{ fontSize: size * 0.55 }}>{persona.emoji}</span>
      </div>
    );
  const mark = modelMark(player);
  return (
    <div className="player-avatar" style={{ width: size, height: size, background: maker.color }} title={fullName(player)}>
      <span style={{ fontSize: size * (mark.length > 5 ? 0.22 : 0.27) }}>{mark}</span>
      {!persona.plain && (
        <i className="persona-badge" style={{ background: persona.color, width: size * 0.48, height: size * 0.48, fontSize: size * 0.28 }}>
          {persona.emoji}
        </i>
      )}
    </div>
  );
}

/** "Opus 5.5 as The Magician", with the effort: the model leads, the personality is its style. */
export function PlayerName({ player, effort = true, className = "" }: { player: PlayerRef; effort?: boolean; className?: string }) {
  const maker = makerOf(player.provider);
  const persona = personalityById(player.personality);
  if (isHuman(player))
    return (
      <span className={`player-fullname ${className}`}>
        <b style={{ color: maker.color }}>{player.modelLabel}</b>
        {effort && <small className="effort">human</small>}
      </span>
    );
  return (
    <span className={`player-fullname ${className}`}>
      <b style={{ color: maker.color }}>{player.modelLabel}</b>
      {effort && <small className="effort">{player.effort}</small>}
      {!persona.plain && (
        <span className="as">
          as <span style={{ color: persona.color }}>{persona.name}</span>
        </span>
      )}
    </span>
  );
}
