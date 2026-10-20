import type { PlayerRef } from "../../../shared/types";
import { lookOf } from "../../../shared/looks";
import { GLYPHS } from "../glyphs";

/** The model behind a player, in its maker's colour, with its glyph. */
export function ModelTag({ player, effort = true, className = "" }: { player: Pick<PlayerRef, "provider" | "modelLabel" | "effort">; effort?: boolean; className?: string }) {
  const look = lookOf(player);
  return (
    <span className={`model-tag ${className}`} style={{ "--maker": look.color } as React.CSSProperties} title={`${look.makerName} · ${player.modelLabel} · ${player.effort} effort`}>
      {look.glyph ? <svg className="glyph" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: GLYPHS[look.glyph](look.color, "#3a3835") }} /> : <i className="dot" />}
      {player.modelLabel}
      {effort && <small>{player.effort}</small>}
    </span>
  );
}
