import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelOption, PlayerStats } from "../../../shared/types";
import { lookOf, makerKey, MAKER_LOOKS } from "../../../shared/looks";
import { useFetch, type Lobby } from "../api";
import { PlayerAvatar, Var960 } from "./PlayerName";
import type { Variant } from "../../../shared/rules";

export interface SeatChoice {
  model: string;
  effort: string;
}

/** Every rated player's rating by id ("model@effort") in one variant's ratings, for showing beside the choices. */
export type Ratings = Map<string, PlayerStats> & { variant: Variant };
export function useRatings(variant: Variant = "standard"): Ratings {
  const lobby = useFetch<Lobby>("/api/lobby");
  // Chess960 is rated apart: a Chess960 game is set up against its players' Chess960 ratings. A player who
  // has only played unrated games still sits at the starting rating: leave them out.
  return useMemo(() => {
    const pool = (variant === "chess960" ? lobby?.players960 : lobby?.players) ?? [];
    return Object.assign(new Map(pool.filter((p) => p.wins + p.draws + p.losses > 0).map((p) => [p.id, p])), { variant });
  }, [lobby, variant]);
}

const who = (m: ModelOption) => ({ provider: m.provider, modelLabel: m.label });

/** "1712", "1650?" while provisional, or null when it has no rated games. */
export function ratingText(r: Ratings, model: string, effort: string): string | null {
  const p = r.get(`${model}@${effort}`);
  return p ? `${p.rating}${p.rd > 110 ? "?" : ""}` : null;
}

/** The catalog grouped by maker, in catalog order. */
function groupsOf(models: ModelOption[]) {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const key = makerKey(who(m)) ?? m.provider;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups].map(([key, list]) => ({ key, name: MAKER_LOOKS[key]?.name ?? key, list }));
}

/**
 * A model chooser that shows each model's face: its glyph on its tile, older releases aged. Opens a
 * searchable list grouped by maker, with the rating each model holds at the chosen effort.
 */
export function ModelPicker({
  models,
  value,
  effort,
  onChange,
  ratings,
  seated,
  label = "Model",
}: {
  models: ModelOption[];
  value: string;
  /** The effort the seat plays at: the ratings shown are for this effort. */
  effort: string;
  onChange: (model: ModelOption) => void;
  /** Left out, no ratings are shown. */
  ratings?: Ratings;
  /** Models already in another seat, marked in the list. */
  seated?: Set<string>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = models.find((m) => m.model === value) ?? models[0];

  const q = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      groupsOf(models)
        .map((g) => ({ ...g, list: g.list.filter((m) => !q || `${g.name} ${m.label} ${m.model}`.toLowerCase().includes(q)) }))
        .filter((g) => g.list.length),
    [models, q],
  );
  const flat = groups.flatMap((g) => g.list);

  const place = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const width = Math.max(r.width, Math.min(320, innerWidth - 16));
    const left = Math.max(8, Math.min(r.left, innerWidth - width - 8));
    // Open downward unless there's clearly more room above.
    if (below >= 280 || below >= above) setPos({ left, width, top: r.bottom + 6, maxHeight: Math.min(440, below) });
    else setPos({ left, width, bottom: innerHeight - r.top + 6, maxHeight: Math.min(440, above) });
  };

  const show = () => {
    setQuery("");
    setActive(Math.max(0, models.indexOf(current)));
    place();
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (m: ModelOption) => {
    onChange(m);
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

  // Keep the highlighted option in view as the keyboard moves it.
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : flat.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[active]) pick(flat[active]);
    } else if (e.key === "Tab") close(false);
  };

  const look = lookOf(who(current));
  const rating = ratings && ratingText(ratings, current.model, effort);
  let i = 0;
  return (
    <div className="mp">
      {label && (
        <span className="mp-label" id={`${id}l`}>
          {label}
        </span>
      )}
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
        <PlayerAvatar player={who(current)} size={38} />
        <span className="mp-text" id={`${id}v`}>
          <b style={{ color: look.color }}>{current.label}</b>
          <small>
            {look.makerName}
            {ratings && (
              <>
                {" · "}
                {rating ? (
                  <>
                    <span className="mp-rating">{rating}</span>
                    {ratings.variant === "chess960" && <Var960 />}
                  </>
                ) : ratings.variant === "chess960" ? (
                  "no Chess960 rating"
                ) : (
                  "unrated"
                )}{" "}
                at {effort}
              </>
            )}
          </small>
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
            className="mp-pop"
            style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            onKeyDown={onKey}
            // Clicks in here are the picker's, not the backdrop's.
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              type="text"
              className="mp-search"
              placeholder="Search models…"
              value={query}
              role="combobox"
              aria-expanded
              aria-controls={`${id}list`}
              aria-activedescendant={flat[active] ? `${id}-${active}` : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
            />
            <div className="mp-list" role="listbox" id={`${id}list`} ref={list} aria-label={label || "Model"}>
              {!flat.length && <div className="mp-empty">No model matches “{query}”.</div>}
              {groups.map((g) => (
                <div key={g.key} role="group" aria-label={g.name}>
                  <div className="mp-group">{g.name}</div>
                  {g.list.map((m) => {
                    const n = i++;
                    const l = lookOf(who(m));
                    const r = ratings?.get(`${m.model}@${effort}`);
                    const selected = m.model === current.model;
                    return (
                      <div
                        key={m.model}
                        id={`${id}-${n}`}
                        data-i={n}
                        role="option"
                        aria-selected={selected}
                        className={`mp-opt ${n === active ? "active" : ""} ${selected ? "selected" : ""}`}
                        onMouseMove={() => n !== active && setActive(n)}
                        onClick={() => pick(m)}
                      >
                        <PlayerAvatar player={who(m)} size={34} />
                        <span className="mp-text">
                          <b style={{ color: l.color }}>{m.label}</b>
                          <small>
                            {!ratings ? (
                              l.makerName
                            ) : r ? (
                              <>
                                <span className="mp-rating">{ratingText(ratings, m.model, effort)}</span>
                                {ratings.variant === "chess960" && <Var960 />} · {r.wins}W {r.draws}D {r.losses}L
                              </>
                            ) : (
                              `No rated ${ratings.variant === "chess960" ? "Chess960 " : ""}games at ${effort}`
                            )}
                          </small>
                        </span>
                        {seated?.has(m.model) && !selected && <span className="mp-tag">seated</span>}
                        {selected && (
                          <span className="mp-check" aria-hidden>
                            ✓
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Effort as a row of chips, each with the rating that model holds at it. */
export function EffortPicker({ efforts, value, onChange, ratings, model }: { efforts: string[]; value: string; onChange: (e: string) => void; ratings?: Ratings; model?: string }) {
  return (
    <div className="mp">
      <span className="mp-label">Effort</span>
      <div className="chips" role="radiogroup" aria-label="Effort">
        {efforts.map((e) => {
          const r = ratings && model ? ratingText(ratings, model, e) : null;
          return (
            <button key={e} type="button" role="radio" aria-checked={value === e} className={`chip ${value === e ? "on" : ""}`} onClick={() => onChange(e)} title={(() => { const kind = ratings?.variant === "chess960" ? "Chess960 " : ""; return r ? `${kind ? "Chess960 rating" : "Rated"} ${r} at ${e} effort` : `No rated ${kind}games at ${e} effort`; })()}>
              {e}
              {r && <small>{r}</small>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A seat's model and effort. Switching model keeps the effort when the new model offers it. */
export function SeatPicker({ models, value, onChange, ratings, seated, efforts, label }: { models: ModelOption[]; value: SeatChoice; onChange: (v: SeatChoice) => void; ratings: Ratings; seated?: Set<string>; efforts?: string[]; label?: string }) {
  const model = models.find((m) => m.model === value.model) ?? models[0];
  return (
    <div className="seat-picker">
      <ModelPicker
        label={label}
        models={models}
        value={value.model}
        effort={value.effort}
        ratings={ratings}
        seated={seated}
        onChange={(m) => onChange({ model: m.model, effort: m.efforts.includes(value.effort) ? value.effort : m.defaultEffort })}
      />
      <EffortPicker efforts={efforts ?? model.efforts} value={value.effort} onChange={(effort) => onChange({ ...value, effort })} ratings={ratings} model={model.model} />
    </div>
  );
}
