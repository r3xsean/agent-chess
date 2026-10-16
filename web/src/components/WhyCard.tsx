import type { Game } from "../../../shared/types";
import type { EngineLine, Why } from "../../../shared/why";
import { formatScore, scoreToCp } from "../../../shared/evalmath";
import { sideName } from "../../../shared/naming";
import { CLASS_META, ClassIcon } from "./ClassIcon";

/** How much of an engine line the card shows (▶ plays all of it). */
const SHOWN = 8;

/** Move-number prefixes for a SAN sequence starting at `fen` ("12. ", "12… ", ""). */
export function movePrefixes(fen: string, count: number): string[] {
  const [, side, , , , full] = fen.split(" ");
  let no = Number(full) || 1;
  let white = side === "w";
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(white ? `${no}. ` : i === 0 ? `${no}… ` : "");
    if (!white) no++;
    white = !white;
  }
  return out;
}

function LineRow({ mark, label, line, onPlay }: { mark?: "good" | "bad"; label: string; line: EngineLine; onPlay: () => void }) {
  const shown = line.san.slice(0, SHOWN);
  const prefixes = movePrefixes(line.fen, shown.length);
  return (
    <button className={`why-line ${mark ?? ""}`} onClick={onPlay} title={`Play this line on the board (Stockfish, depth ${line.depth})`}>
      <span className="why-play">▶</span>
      <span className="why-label">
        {mark === "good" ? "✓ " : mark === "bad" ? "✗ " : ""}
        {label}
      </span>
      <span className={`eval-chip engine ${scoreToCp(line.score) < 0 ? "neg" : ""}`}>{formatScore(line.score)}</span>
      <span className="why-moves">
        {shown.map((s, i) => prefixes[i] + s).join(" ")}
        {line.san.length > SHOWN ? " …" : ""}
      </span>
    </button>
  );
}

/**
 * The engine's case for the verdict on the move being viewed: what it wanted instead, what follows the
 * move played, and why that matters in a sentence. Each line plays out on the board.
 */
export function WhyCard({
  game,
  ply,
  why,
  pending,
  onPlay,
}: {
  game: Game;
  ply: number;
  why: Why | null;
  /** No verdict yet: "pending" while the engine works, "none" when it couldn't analyse the move. */
  pending?: "pending" | "none";
  onPlay: (line: EngineLine, basePly: number, label: string) => void;
}) {
  const m = game.moves[ply - 1];
  if (!m) return null;
  const moveNo = `${Math.ceil(m.ply / 2)}${m.color === "w" ? "." : "…"}`;
  if (!why)
    return (
      <div className="why quiet">
        {moveNo} {m.san} · {pending === "none" ? "The engine couldn't analyse this move." : "Engine verdict on its way…"}
      </div>
    );
  const meta = CLASS_META[why.cls];
  const who = sideName(game, m.color);
  const before = Math.round(why.winBefore);
  const after = Math.round(why.winAfter);
  const wentWrong = why.kind === "bad" || why.kind === "miss";
  return (
    <div className="why" style={{ ["--cls" as string]: meta.color }}>
      <div className="why-head">
        <ClassIcon c={why.cls} size={18} />
        <b>
          {moveNo} {m.san}
        </b>
        <span className="why-cls">{meta.label}</span>
        {why.kind !== "book" && why.kind !== "forced" && (
          <span className="why-win" title={`${who}'s winning chances by the engine, before and after the move`}>
            {who}: {before === after ? `${after}%` : `${before}% → ${after}%`}
          </span>
        )}
      </div>
      {why.reason && <div className="why-reason">{why.reason}</div>}
      {why.best && why.bestSan && (
        <LineRow mark="good" label={`Best was ${why.bestSan}`} line={why.best} onPlay={() => onPlay(why.best!, ply - 1, `Engine line: ${moveNo} ${why.bestSan} instead of ${m.san}`)} />
      )}
      {why.after && why.after.san.length > 0 && (
        <LineRow
          mark={why.kind === "bad" ? "bad" : undefined}
          label={wentWrong ? `After ${m.san}` : "Engine continues"}
          line={why.after}
          onPlay={() => onPlay(why.after!, ply, `Engine line after ${moveNo} ${m.san}`)}
        />
      )}
    </div>
  );
}
