import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OPENINGS, openingById, openingMovesText, type OpeningRecord, type OpeningStats } from "../../../shared/openingSuite";

/** The names of the two seats, for the head-to-head lines (null: no seats yet, e.g. a tournament). */
export type SeatNames = { w: string; b: string } | null;

const fmtEval = (e: number) => (e > 0 ? `+${e.toFixed(2)}` : e.toFixed(2));
const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;

function recordLine(name: string, r: OpeningRecord) {
  if (!r.games) return `${name}: no games from here`;
  const score = (r.wins + r.draws / 2) / r.games;
  return `${name}: ${r.wins}W ${r.draws}D ${r.losses}L (${Math.round(score * 100)}%)${r.accuracy != null ? ` · ${r.accuracy}% acc` : ""}`;
}

/** An opening's numbers: the two seats against each other, each one's own record, and every game from it. */
function StatsLines({ s, names }: { s?: OpeningStats; names: SeatNames }) {
  if (!s) return null;
  const { pair, players, all } = s;
  return (
    <span className="op-stats">
      {names && pair && (
        <span>
          {pair.games ? (
            <>
              Head to head: <b>{names.w}</b> {pair.a} – {pair.b} <b>{names.b}</b>
              {pair.draws ? `, ${pair.draws} drawn` : ""}
            </>
          ) : (
            "They haven't played each other from here"
          )}
        </span>
      )}
      {names && players && (
        <span>
          {recordLine(names.w, players.w)} · {recordLine(names.b, players.b)}
        </span>
      )}
      <span className="muted">
        {all.games ? `All games: ${all.games} · White wins ${pct(all.white, all.games)}, draws ${pct(all.draws, all.games)}, Black wins ${pct(all.black, all.games)}` : "No games from here yet"}
      </span>
    </span>
  );
}

/**
 * The set-opening chooser: the automatic choice first ("Next for this pair", or a tournament's "Each pairing
 * gets its own"), then every opening with its moves, what kind of game it makes, its engine eval at the
 * handover and the numbers from it. `value` "" is the automatic choice.
 */
export function OpeningPicker({
  value,
  onChange,
  autoLabel,
  autoNote,
  next,
  stats,
  names,
}: {
  value: string;
  onChange: (id: string) => void;
  autoLabel: string;
  /** What the automatic choice comes to, shown under it. */
  autoNote: React.ReactNode;
  /** The opening "next for this pair" is, marked in the list. */
  next?: string | null;
  stats?: OpeningStats[] | null;
  names: SeatNames;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  // Index 0 is the automatic choice; 1… are the openings in suite order.
  const ids = ["", ...OPENINGS.map((o) => o.id)];
  const statsOf = (oid: string) => stats?.find((s) => s.id === oid);
  const current = openingById(value);

  const place = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const width = Math.max(r.width, Math.min(460, innerWidth - 16));
    const left = Math.max(8, Math.min(r.left, innerWidth - width - 8));
    if (below >= 320 || below >= above) setPos({ left, width, top: r.bottom + 6, maxHeight: Math.min(520, below) });
    else setPos({ left, width, bottom: innerHeight - r.top + 6, maxHeight: Math.min(520, above) });
  };
  const show = () => {
    setActive(Math.max(0, ids.indexOf(value)));
    place();
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (oid: string) => {
    onChange(oid);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    const onMove = () => place();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // The list takes the keyboard as soon as it opens.
  useEffect(() => {
    if (open) pop.current?.focus();
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : ids.length - 1)) % ids.length);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : ids.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(ids[active]);
    } else if (e.key === "Tab") close(false);
  };

  return (
    <div className="mp op-picker">
      <span className="mp-label" id={`${id}l`}>
        Opening
      </span>
      <button
        ref={trigger}
        type="button"
        className={`mp-trigger ${open ? "open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}l ${id}v`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="op-glyph" aria-hidden>
          ♟
        </span>
        <span className="mp-text" id={`${id}v`}>
          <b>{current ? current.name : autoLabel}</b>
          <small>{current ? openingMovesText(current.moves) : autoNote}</small>
        </span>
        <span className="mp-chev" aria-hidden>
          ▾
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={pop}
            tabIndex={-1}
            className="mp-pop op-pop"
            style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            onKeyDown={onKey}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="mp-list" role="listbox" aria-label="Opening" aria-activedescendant={`${id}-${active}`}>
              {ids.map((oid, n) => {
                const o = openingById(oid);
                const selected = oid === value;
                return (
                  <div
                    key={oid || "auto"}
                    id={`${id}-${n}`}
                    data-i={n}
                    role="option"
                    aria-selected={selected}
                    className={`mp-opt op-opt ${n === active ? "active" : ""} ${selected ? "selected" : ""} ${!o ? "op-auto" : ""}`}
                    onMouseMove={() => n !== active && setActive(n)}
                    onClick={() => pick(oid)}
                  >
                    <span className="mp-text">
                      {o ? (
                        <>
                          <b>
                            {o.name}
                            {oid === next && <span className="mp-tag">next for this pair</span>}
                          </b>
                          <small>
                            <span className="opening-moves">{openingMovesText(o.moves)}</span> · {o.kind} · eval {fmtEval(o.eval)}
                          </small>
                          <StatsLines s={statsOf(oid)} names={names} />
                        </>
                      ) : (
                        <>
                          <b>{autoLabel}</b>
                          <small>{autoNote}</small>
                        </>
                      )}
                    </span>
                    {selected && (
                      <span className="mp-check" aria-hidden>
                        ✓
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export { StatsLines };
