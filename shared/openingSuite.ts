/*
 * The set openings a game can start from: the arena plays a fixed sequence of first moves, and the players take
 * over from there. Each was picked for a different kind of game, and checked with Stockfish to be roughly level
 * where the players take over (`eval`, in pawns from White's side). Bump SUITE_VERSION when any line changes, so
 * games keep saying which version of a line they were played from.
 */

export const SUITE_VERSION = 1;

export interface SetOpening {
  id: string;
  name: string;
  /** The supplied moves, in SAN from the normal starting position. */
  moves: string[];
  /** What kind of game it sets up. */
  kind: string;
  eval: number;
}

export const OPENINGS: SetOpening[] = [
  { id: "french", name: "French", moves: ["e4", "e6"], kind: "French pawn chain", eval: 0.38 },
  { id: "london", name: "London", moves: ["d4", "d5", "Bf4"], kind: "quiet system", eval: 0.06 },
  { id: "kga", name: "King's Gambit Accepted", moves: ["e4", "e5", "f4", "exf4"], kind: "sharp: a pawn for the open f-file", eval: -0.49 },
  { id: "nimzo", name: "Nimzo-Indian", moves: ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4"], kind: "pin and doubled pawns", eval: 0.12 },
  { id: "scotch", name: "Scotch", moves: ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4"], kind: "open centre", eval: 0.06 },
  { id: "catalan", name: "Catalan", moves: ["d4", "Nf6", "c4", "e6", "g3", "d5", "Bg2"], kind: "pressure down the long diagonal", eval: 0.15 },
  { id: "panov", name: "Caro-Kann Panov", moves: ["e4", "c6", "d4", "d5", "exd5", "cxd5", "c4", "Nf6", "Nc3", "e6", "Nf3"], kind: "isolated queen's pawn", eval: 0.21 },
  {
    id: "kid",
    name: "King's Indian, Classical",
    moves: ["d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6", "Nf3", "O-O", "Be2", "e5"],
    kind: "closed centre, pawn storms on opposite wings",
    eval: 0.51,
  },
  { id: "grunfeld", name: "Grünfeld Exchange", moves: ["d4", "Nf6", "c4", "g6", "Nc3", "d5", "cxd5", "Nxd5", "e4", "Nxc3", "bxc3", "Bg7"], kind: "big centre against piece pressure", eval: 0.23 },
  { id: "stonewall", name: "Stonewall Dutch", moves: ["d4", "f5", "c4", "Nf6", "g3", "e6", "Bg2", "d5", "Nf3", "c6", "O-O", "Bd6"], kind: "Stonewall, weak e5 square", eval: 0.38 },
  { id: "carlsbad", name: "QGD Exchange", moves: ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "cxd5", "exd5", "Bg5", "c6", "e3", "Be7", "Bd3"], kind: "Carlsbad structure, minority attack", eval: 0.2 },
  { id: "kia", name: "King's Indian Attack", moves: ["e4", "e6", "d3", "d5", "Nd2", "Nf6", "Ngf3", "c5", "g3", "Nc6", "Bg2", "Be7", "O-O"], kind: "slow, closed manoeuvring", eval: 0 },
  {
    id: "hedgehog",
    name: "English Hedgehog",
    moves: ["c4", "c5", "Nf3", "Nf6", "Nc3", "e6", "g3", "b6", "Bg2", "Bb7", "O-O", "Be7", "d4", "cxd4", "Qxd4", "d6"],
    kind: "cramped but solid against space",
    eval: 0.22,
  },
  {
    id: "berlin",
    name: "Berlin endgame",
    moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "Nf6", "O-O", "Nxe4", "d4", "Nd6", "Bxc6", "dxc6", "dxe5", "Nf5", "Qxd8+", "Kxd8"],
    kind: "queens off by move 8",
    eval: 0.22,
  },
];

export const openingById = (id: string) => OPENINGS.find((o) => o.id === id);

/** One player's finished games from an opening's handover position, against anyone, in either colour. */
export interface OpeningRecord {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** Mean game accuracy (the players' own moves only). */
  accuracy: number | null;
}

/**
 * What the new-game form shows for an opening: finished standard games that reached its handover position,
 * whether the arena set it or the players got there themselves.
 */
export interface OpeningStats {
  id: string;
  /** The two seats' games against each other from it: `a` the White seat's player's wins, `b` the Black seat's. */
  pair: { games: number; a: number; draws: number; b: number } | null;
  /** Each seat's player's own record from it. */
  players: { w: OpeningRecord; b: OpeningRecord } | null;
  /** Every game from it, by result. */
  all: { games: number; white: number; draws: number; black: number };
}

/** "1.e4 e5 2.f4 exf4" */
export function openingMovesText(moves: string[]): string {
  return moves.map((san, i) => (i % 2 ? san : `${i / 2 + 1}.${san}`)).join(" ");
}
