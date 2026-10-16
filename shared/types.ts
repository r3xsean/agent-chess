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
  /** "chess960" for Fischer Random; absent on standard games. */
  variant?: "standard" | "chess960";
  /** Chess960 starting position number (0–959; 518 is the normal setup). */
  chess960?: number;
  /** The starting position, when it isn't the normal one. */
  startFen?: string;
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
  /** Version of the move-classification rules the stored verdicts came from. */
  classifierVersion?: number;
  /** The broadcaster's picks for the video replay, made after the game. */
  video?: VideoPlan;
  interviewsCompleteAt: number | null;
  /** On the public mirror: when each ply (and "end", the result) happened by the mirror's clock — prediction cut-offs. */
  mirrorCutoffs?: Record<string, number>;
}

/** Two models' record against each other, keyed by this game's colours. */
export interface Rivalry {
  /** Before this game started. */
  before: { w: number; b: number; draws: number };
  /** Including this game, once it's over. */
  after: { w: number; b: number; draws: number };
  /** Their most recent earlier game: who won it (null = draw), how, and its replay headline if any. */
  last?: { gameId: string; endedAt: number; winner: Color | null; termination: string; headline?: string };
}

/** A moment the video slows down for. */
export interface VideoMoment {
  ply: number;
  /** Why it matters (for the editor and chapter titles; not shown in the video). */
  why: string;
  /** 3 = headline, 2 = strong (both cuts), 1 = minor (YouTube only). */
  importance: 1 | 2 | 3;
  /** Verbatim excerpt of the mover's thinking on this move, shown as a speech bubble before it. */
  thought?: string;
  /** How the quote is spoken, as a few words of direction ("smug, unbothered"); becomes the voice's audio tag. */
  delivery?: string;
  /** A short label for this moment as a YouTube chapter (headline moments only). */
  chapter?: string;
}

/** The cold open: the payoff moment, played first, before "how did we get here?". */
export interface VideoHook {
  /** The move whose position, quote and verdict open the video. */
  ply: number;
  /** Verbatim excerpt of that move's commentary (omitted for a human's move). */
  quote?: string;
  delivery?: string;
  /** The on-screen hook, a dozen words at most ("Sonnet thinks it's winning. It's mate in one."). */
  caption: string;
}

/** A pre-game line replayed as a flashback right after the move that proves it wrong (or right). */
export interface VideoCallback {
  color: Color;
  /** Verbatim excerpt of that player's pre-game interview. */
  line: string;
  ply: number;
}

export interface VideoPackaging {
  /** YouTube title. */
  title: string;
  /** TikTok caption, hashtags included. */
  caption: string;
  /** The thumbnail: the position after this move, with a few words of big text. */
  thumbnail: { ply: number; text: string };
}

export interface VideoPlan {
  moments: VideoMoment[];
  /** The best verbatim line from each interview, for the short cut. */
  interviewLines: { pre: Partial<Record<Color, string>>; post: Partial<Record<Color, string>> };
  /** How each interview line is spoken (see VideoMoment.delivery). */
  interviewDelivery?: { pre: Partial<Record<Color, string>>; post: Partial<Record<Color, string>> };
  hook?: VideoHook;
  callback?: VideoCallback;
  packaging?: VideoPackaging;
  createdAt: number;
}

export interface PlayerStats {
  id: string;
  ref: PlayerRef;
  /** Glicko-2 rating, rounded for display. */
  rating: number;
  /** Rating deviation (uncertainty), rounded. Above 110 the rating is provisional. */
  rd: number;
  /** Full-precision Glicko-2 state the next game updates from. */
  glicko: { rating: number; rd: number; vol: number };
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
  /** Every game is Chess960; each pairing carries its start position (shared by a double round-robin's return game). */
  chess960?: boolean;
  pairings: { white: string; black: string; gameId?: string; chess960?: number }[];
  status: "running" | "finished";
  /** Games played at once (default 1). Above 1, no model ever plays two games at the same time, in or out of the tournament. */
  boards?: number;
  /** Last time the server asked T3 to start more pairings (so it doesn't ask twice in a row). */
  lastKickAt?: number;
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
  /** "No personality": the model plays as itself — no style, voice or risk instructions in its prompt. */
  plain?: boolean;
}

export interface ModelOption {
  provider: string;
  model: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
}
