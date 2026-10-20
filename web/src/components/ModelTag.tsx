import type { PlayerRef } from "../../../shared/types";
import { makerOf } from "../../../shared/models";

/** The model behind a player, in its maker's colour. */
export function ModelTag({ player, effort = true, className = "" }: { player: Pick<PlayerRef, "provider" | "modelLabel" | "effort">; effort?: boolean; className?: string }) {
  const maker = makerOf(player.provider);
  return (
    <span className={`model-tag ${className}`} style={{ "--maker": maker.color } as React.CSSProperties} title={`${maker.name} · ${player.modelLabel} · ${player.effort} effort`}>
      <i className="dot" />
      {player.modelLabel}
      {effort && <small>{player.effort}</small>}
    </span>
  );
}
