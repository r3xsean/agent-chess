export type Color = "w" | "b";
export type Phase = "pregame" | "playing" | "postgame" | "finished";
export type Result = "1-0" | "0-1" | "1/2-1/2";

export type Classification =
  | "brilliant"
  | "great"
  | "best"
  | "excellent"
  | "good"
  | "book"
  | "forced"
  | "inaccuracy"
  | "mistake"
  | "miss"
  | "blunder";

export interface PlayerRef {
  /** Stable identity: model + effort + personality. Journals and ratings key off this. */
  id: string;
  provider: string;
  model: string;
  modelLabel: string;
  effort: string;
  personality: string;
}

/** Engine score, always from White's point of view. */
export interface Score {
  cp?: number;
  mate?: number;
}

export interface PositionAnalysis {
  depth: number;
  score: Score;
  bestUci?: string;
  bestSan?: string;
  pv: string[];
  /** Second-best line score (White POV), when one exists. */
  second?: Score;
  /** The engine could not analyze this position (retried on next server start). */
  failed?: boolean;
}

export interface CalcLine {
  raw: string;
  note: string;
  /** The SAN moves that were legal, in order. */
  san: string[];
  /** Token at which the line stopped being legal, if any. */
  brokenAt?: string;
}

export interface MoveAnalysis {
  classification: Classification;
  /** Mover's win chance (0-100) before and after. */
  winBefore: number;
  winAfter: number;
  accuracy: number;
  cpLoss: number;
  bestSan?: string;
  bestUci?: string;
  evalAfter: Score;
  /** No real engine data for this move: excluded from accuracy, ratings and counts. */
  unavailable?: boolean;
}

export interface MoveRecord {
  ply: number;
  color: Color;
  san: string;
  uci: string;
  from: string;
  to: string;
  fenBefore: string;
  fenAfter: string;
  commentary: string;
  /** Player's own evaluation in pawns, White POV. */
  selfEval: number | null;
  selfEvalRaw: string;
  lines: CalcLine[];
  illegalAttempts: string[];
  offeredDraw: boolean;
  thinkMs: number;
  ts: number;
  analysis?: MoveAnalysis;
}

export interface Interview {
  text: string;
  ts: number;
}

export interface BroadcastLine {
  id: number;
  ts: number;
  text: string;
  ply: number;
  audio?: string;
}

export interface SideReview {
  /** null when the engine produced no usable data for this side. */
  accuracy: number | null;
  estElo: number | null;
  counts: Partial<Record<Classification, number>>;
  /** Mean absolute gap between self-eval and engine eval, in pawns (capped). */
  selfEvalError: number | null;
}

export interface Game {
  id: string;
  createdAt: number;
  white: PlayerRef;
  black: PlayerRef;
  broadcaster: { enabled: boolean; model: string; provider: string; effort: string } | null;
  tournamentId?: string;
  phase: Phase;
  moves: MoveRecord[];
  drawOffer: Color | null;
  result: Result | null;
  termination: string | null;
  interviews: {
    pre: Partial<Record<Color, Interview>>;
    post: Partial<Record<Color, Interview>>;
  };
  journalDone: Partial<Record<Color, boolean>>;
  broadcast: BroadcastLine[];
  broadcasterDone: boolean;
  /** Feed event ids already handed to the broadcaster. */
  bcDelivered: string[];
  /** Last time each seat talked to the server. */
  seen: Partial<Record<Color | "x", number>>;
  pendingIllegal: Record<Color, string[]>;
  turnStartedAt: number | null;
  analysis: Record<string, PositionAnalysis>;
  opening: { eco: string; name: string } | null;
  review: Record<Color, SideReview> | null;
  ratingChange?: Record<Color, number>;
  playStartedAt: number | null;
  endedAt?: number;
  /** What the agents' briefing includes. Fixed at creation so a running game's conditions never change. */
  options?: { pieceList?: boolean; learning?: boolean };
  lessonsDone?: Partial<Record<Color, boolean>>;
  /** When the orchestrator delegated each seat (so a second orchestrator run never double-launches). */
  launched?: Partial<Record<Color | "x", number>>;
  /** Last time the website asked T3 to summon agents for this game. */
  summonRequestedAt?: number;
  /** Tournament auto-run: the next pairing has been requested after this game finished. */
  nextTriggered?: boolean;
  /** Lessons version each seat was shown in its post-game brief (optimistic concurrency for shared lessons). */
  lessonsSeen?: Partial<Record<Color, number>>;
  interviewsCompleteAt: number | null;
}

export interface PlayerStats {
  id: string;
  ref: PlayerRef;
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface JournalEntry {
  gameId: string;
  ts: number;
  opponent: string;
  color: Color;
  result: string;
  text: string;
}

export interface Tournament {
  id: string;
  name: string;
  createdAt: number;
  players: PlayerRef[];
  doubleRound: boolean;
  broadcaster: Game["broadcaster"];
  learning?: boolean;
  /** Started from the website: each finished game automatically summons the next pairing. */
  autoRun?: boolean;
  pairings: { white: string; black: string; gameId?: string }[];
  status: "running" | "finished";
}

export interface Lessons {
  model: string;
  version: number;
  text: string;
  updatedAt: number | null;
  history: { version: number; ts: number; gameId: string | null; text: string }[];
}

/** How much objective soundness a personality will trade for practical chances. */
export type Risk = "calm" | "bold" | "wild";

export interface Personality {
  id: string;
  name: string;
  emoji: string;
  color: string;
  tagline: string;
  risk: Risk;
  style: string;
  voice: string;
}

export interface ModelOption {
  provider: string;
  model: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
}
