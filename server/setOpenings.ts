import { OPENINGS, type OpeningRecord, type OpeningStats } from "../shared/openingSuite";
import { newRules, START_FEN, variantOf } from "../shared/rules";
import type { Game } from "../shared/types";
import { posKey } from "./openings";
import { games } from "./store";

/** A game (or a tournament pairing not played yet) by its players' ids and its set opening. */
interface Seen {
  white: string;
  black: string;
  opening?: string;
}

/** FNV-1a: a stable order of the openings for each pair, so pairs don't all start with the same one. */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * The set opening these two players (ids, these colours) have played least: fewest times with these colours
 * first, then one they've played with the colours the other way round (so it becomes a colour-swapped pair),
 * then the pair's own fixed order. `planned`: pairings already given an opening that aren't games yet.
 */
export function nextOpening(white: string, black: string, planned: Seen[] = []): string {
  const played: Seen[] = [...games.values()].filter((g) => g.setOpening && g.termination !== "aborted").map((g) => ({ white: g.white.id, black: g.black.id, opening: g.setOpening!.id }));
  const same = new Map<string, number>();
  const reversed = new Map<string, number>();
  for (const x of [...played, ...planned]) {
    if (!x.opening) continue;
    const into = x.white === white && x.black === black ? same : x.white === black && x.black === white ? reversed : null;
    into?.set(x.opening, (into.get(x.opening) ?? 0) + 1);
  }
  const pair = [white, black].sort().join("|");
  const key = (id: string) => [same.get(id) ?? 0, -(reversed.get(id) ?? 0), hash(`${pair}|${id}`)];
  return [...OPENINGS].sort((a, b) => {
    const ka = key(a.id);
    const kb = key(b.id);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  })[0].id;
}

/** Each opening's handover position (the key transpositions match on). */
const handovers = new Map(
  OPENINGS.map((o) => {
    const c = newRules(START_FEN, "standard");
    for (const san of o.moves) c.move(san);
    return [posKey(c.fen()), o.id];
  }),
);

/** The opening a finished standard game started from, or reached on its own: its set opening, else the first handover position it passed through. */
export function openingOf(g: Game): string | undefined {
  if (g.setOpening) return g.setOpening.id;
  if (variantOf(g) !== "standard") return undefined;
  for (const m of g.moves) {
    const id = handovers.get(posKey(m.fenAfter));
    if (id) return id;
  }
  return undefined;
}

const emptyRecord = (): OpeningRecord => ({ games: 0, wins: 0, draws: 0, losses: 0, accuracy: null });

/**
 * Every opening's numbers for the new-game form: the two seats' games against each other from it, each one's
 * own record from it, and every game from it. Without seats (a tournament), only the last.
 */
export function openingStats(white?: string, black?: string): OpeningStats[] {
  const byId = new Map<string, Game[]>();
  for (const g of games.values()) {
    if (!g.result) continue;
    const id = openingOf(g);
    if (id) byId.set(id, [...(byId.get(id) ?? []), g]);
  }
  const record = (list: Game[], player: string): OpeningRecord => {
    const r = emptyRecord();
    const accs: number[] = [];
    for (const g of list) {
      const c = g.white.id === player ? "w" : g.black.id === player ? "b" : null;
      if (!c) continue;
      r.games++;
      if (g.result === "1/2-1/2") r.draws++;
      else if ((g.result === "1-0") === (c === "w")) r.wins++;
      else r.losses++;
      const acc = g.review?.[c].accuracy;
      if (acc != null) accs.push(acc);
    }
    r.accuracy = accs.length ? Math.round((accs.reduce((a, b) => a + b, 0) / accs.length) * 10) / 10 : null;
    return r;
  };
  return OPENINGS.map((o) => {
    const list = byId.get(o.id) ?? [];
    const all = { games: list.length, white: 0, draws: 0, black: 0 };
    for (const g of list) g.result === "1-0" ? all.white++ : g.result === "0-1" ? all.black++ : all.draws++;
    if (!white || !black) return { id: o.id, pair: null, players: null, all };
    const pair = { games: 0, a: 0, draws: 0, b: 0 };
    for (const g of list) {
      const ids = [g.white.id, g.black.id];
      if (!ids.includes(white) || !ids.includes(black)) continue;
      pair.games++;
      const winner = g.result === "1-0" ? g.white.id : g.result === "0-1" ? g.black.id : null;
      if (!winner) pair.draws++;
      else if (winner === white) pair.a++;
      else pair.b++;
    }
    return { id: o.id, pair, players: { w: record(list, white), b: record(list, black) }, all };
  });
}
