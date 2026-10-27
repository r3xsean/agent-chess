/*
 * What a live stream sends, worked out once per change for everyone watching it. A viewer gets the whole thing
 * when it connects (a plain message, as it always was), then only what changed since (a "patch" event): a
 * game's new moves and analysis rather than the whole game again. Nothing goes out when nothing changed.
 */

/** Which of the streamed object's fields are sent piece by piece: an array by index, a record by key. */
export interface Shape {
  arrays?: string[];
  records?: string[];
}

/** One field of the object, serialised: whole, or as its pieces. */
type Part = { whole: string } | { items: string[] } | { entries: Map<string, string> };

export interface Version {
  v: number;
  /** The whole object, as a plain message (built on first use). */
  full(): string;
  /** What changed since version v - 1, as a "patch" event; null for the first version. */
  patch: string | null;
}

interface State {
  v: number;
  parts: Map<string, Part>;
  version: Version;
}

const json = (value: unknown) => JSON.stringify(value) ?? "null";

function partsOf(obj: Record<string, unknown>, shape: Shape): Map<string, Part> {
  const parts = new Map<string, Part>();
  for (const [k, value] of Object.entries(obj)) {
    if (value === undefined || typeof value === "function") continue;
    if (shape.arrays?.includes(k) && Array.isArray(value)) parts.set(k, { items: value.map(json) });
    else if (shape.records?.includes(k) && value && typeof value === "object" && !Array.isArray(value)) {
      const entries = new Map<string, string>();
      for (const [ek, ev] of Object.entries(value)) if (ev !== undefined) entries.set(ek, json(ev));
      parts.set(k, { entries });
    } else parts.set(k, { whole: json(value) });
  }
  return parts;
}

const partJson = (p: Part) =>
  "whole" in p ? p.whole : "items" in p ? `[${p.items.join(",")}]` : `{${[...p.entries].map(([k, s]) => `${JSON.stringify(k)}:${s}`).join(",")}}`;

const objectJson = (parts: Map<string, Part>) => `{${[...parts].map(([k, p]) => `${JSON.stringify(k)}:${partJson(p)}`).join(",")}}`;

/**
 * The patch from `before` to `after`, or null when they're the same. `set`: fields replaced whole; `del`: fields
 * gone; `arrays`: per array its new length and the items that changed (by index); `records`: per record the
 * entries set and the keys gone.
 */
function diff(before: Map<string, Part>, after: Map<string, Part>, base: number, v: number): string | null {
  const set: string[] = [];
  const del: string[] = [];
  const arrays: string[] = [];
  const records: string[] = [];
  for (const k of before.keys()) if (!after.has(k)) del.push(JSON.stringify(k));
  for (const [k, p] of after) {
    const q = before.get(k);
    const key = JSON.stringify(k);
    if ("items" in p && q && "items" in q) {
      const at: string[] = [];
      p.items.forEach((s, i) => s !== q.items[i] && at.push(`"${i}":${s}`));
      if (at.length || p.items.length !== q.items.length) arrays.push(`${key}:{"len":${p.items.length},"at":{${at.join(",")}}}`);
    } else if ("entries" in p && q && "entries" in q) {
      const es: string[] = [];
      const gone: string[] = [];
      for (const [ek, s] of p.entries) if (q.entries.get(ek) !== s) es.push(`${JSON.stringify(ek)}:${s}`);
      for (const ek of q.entries.keys()) if (!p.entries.has(ek)) gone.push(JSON.stringify(ek));
      if (es.length || gone.length) records.push(`${key}:{"set":{${es.join(",")}},"del":[${gone.join(",")}]}`);
    } else if (!q || partJson(q) !== partJson(p)) set.push(`${key}:${partJson(p)}`);
  }
  if (!set.length && !del.length && !arrays.length && !records.length) return null;
  return `{"base":${base},"v":${v},"set":{${set.join(",")}},"del":[${del.join(",")}],"arrays":{${arrays.join(",")}},"records":{${records.join(",")}}}`;
}

/** Each stream's latest version, while anyone watches it. */
const states = new Map<string, State>();

/** The stream's current version, from its object as it is now: a new version only when something changed. */
export function current(event: string, obj: Record<string, unknown>, shape: Shape): Version {
  const parts = partsOf(obj, shape);
  const was = states.get(event);
  if (was) {
    const patch = diff(was.parts, parts, was.v, was.v + 1);
    if (patch === null) return was.version;
    was.parts = parts;
    was.v++;
    was.version = version(was.v, parts, patch);
    return was.version;
  }
  const state: State = { v: 1, parts, version: version(1, parts, null) };
  states.set(event, state);
  return state.version;
}

function version(v: number, parts: Map<string, Part>, patch: string | null): Version {
  let full: string | undefined;
  return { v, patch, full: () => (full ??= objectJson(parts)) };
}

/** The last viewer of a stream has gone. */
export const forget = (event: string) => void states.delete(event);

/** What to write to a viewer who has version `has` (0: nothing yet), or null when it's up to date. */
export function messageFor(has: number, ver: Version): string | null {
  if (has === ver.v) return null;
  if (has === ver.v - 1 && ver.patch) return `event: patch\nid: ${ver.v}\ndata: ${ver.patch}\n\n`;
  return `id: ${ver.v}\ndata: ${ver.full()}\n\n`;
}
