import type { Color, Game, SeatSetup } from "../../../shared/types";
import { isNormalSetup, seatSetup } from "../../../shared/seatSetup";
import { sideName } from "../../../shared/naming";

const VIEW: Record<SeatSetup["view"], { icon: string; text: string; title: string } | null> = {
  text: null,
  added: { icon: "📷", text: "Text + image", title: "Sees the text board (FEN, piece list, diagram) and a picture of the board every turn." },
  image: { icon: "🖼️", text: "Image only", title: "Sees the board only as a picture: no FEN, piece list or text diagram." },
};

/**
 * A seat's experiment toggles, as badges (nothing for the normal text briefing): how it sees the board, and
 * whether it must write the position out before each move.
 */
export function SetupChip({ setup, compact }: { setup?: SeatSetup; compact?: boolean }) {
  if (!setup || isNormalSetup(setup)) return null;
  const view = VIEW[setup.view];
  return (
    <span className={`setup-chips${compact ? " compact" : ""}`}>
      {view && (
        <span className="setup-chip" title={view.title}>
          {view.icon} {view.text}
        </span>
      )}
      {setup.reread && (
        <span className="setup-chip" title="Writes out every piece on the board before each move; a position that doesn't match the board is sent back.">
          🔁 Re-read
        </span>
      )}
    </span>
  );
}

/** "Text only" for a seat on the normal briefing, where both seats are listed. `block`: on its own line, under a name. */
export function SetupText({ setup, block }: { setup: SeatSetup; block?: boolean }) {
  if (isNormalSetup(setup)) return <span className={`setup-chips${block ? " compact" : ""}`}><span className="setup-chip plain">📝 Text only</span></span>;
  return <SetupChip setup={setup} compact={block} />;
}

/**
 * On an experiment game's page: how each side sees the board. The turns sent back for it aren't shown with the game
 * (the players are told they aren't); the Experiments page counts them across games.
 */
export function ExperimentNote({ game }: { game: Game }) {
  return (
    <div className="experiment-note">
      <div className="head">
        <b>🔬 Experiment game</b>
        <a href="#/experiments">Compare →</a>
      </div>
      {(["w", "b"] as Color[]).map((c) => (
        <div key={c} className="row">
          <span className="who">
            {c === "w" ? "♔" : "♚"} {sideName(game, c)}
          </span>
          <SetupText setup={seatSetup(game, c)} />
        </div>
      ))}
    </div>
  );
}
