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
  /** Everything sent with each illegal attempt, in the same order (missing on older games). */
  tries?: IllegalTry[];
  offeredDraw: boolean;
  thinkMs: number;
  ts: number;
  analysis?: MoveAnalysis;
}

/** A turn submitted with an illegal move: the move was rejected, but the thinking behind it stays. */
export interface IllegalTry {
  move: string;
  commentary: string;
  selfEval: number | null;
  selfEvalRaw: string;
  /** Calculated from the position it was tried in. */
  lines: CalcLine[];
  /** Time into the turn when it was sent. */
  thinkMs: number;
  ts: number;
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
  /** Mean absolute gap between self-eval and engine eval, in win-percentage points. */
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
  /** The full illegal attempts this turn, alongside `pendingIllegal` (missing on older games). */
  pendingTries?: Record<Color, IllegalTry[]>;
  turnStartedAt: number | null;
  analysis: Record<string, PositionAnalysis>;
  opening: { eco: string; name: string } | null;
  review: Record<Color, SideReview> | null;
  ratingChange?: Record<Color, number>;
  /** Each side's rating going into this game (after it: plus ratingChange). Fixed when it's rated, so later games never move it. */
  ratingBefore?: Record<Color, number>;
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
  /** How many plans were thrown away for a new director (each new director is a new task). */
  videoRedos?: number;
  /** Posting the rendered videos to YouTube and TikTok (server/publish.ts). */
  publish?: PublishState;
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
  /**
   * An engine line played out on the board right after the move (see shared/engineLine.ts): what the
   * engine wanted instead of it, or its best play after it. `caption` is the director's one-liner on
   * why the side it favours is better at its end (absent: the line's own plain fact).
   */
  line?: { kind: "instead" | "after"; caption?: string };
  /** The moves and squares the quote names, drawn on the board as it's said. */
  marks?: ThoughtMark[];
}

/**
 * One beat of a player's calculation, drawn on the board while their quote is spoken, the way a streamer
 * draws arrows: it builds up as the voice reaches its words and clears when the next mark comes, at the
 * end of its sentence (or `until`), or with the move. `word` is an index into the quote's words (split on
 * whitespace), so it can be timed to the voice.
 */
export interface ThoughtMark {
  /** The words of the quote it goes with, as the director wrote them. */
  at: string;
  word: number;
  /** The last word it stays up through, when the director said (otherwise the end of its sentence). */
  until?: number;
  /**
   * In the colour of the side whose piece it is, each drawn as its own words are said, on the board as the
   * mark imagines it: a move named (`san`), played on from the moves before it, or (`hit`) a piece on that
   * board attacking or defending a square ("d4>f3", the knight that has just landed there forking).
   */
  arrows: { san: string; from: string; to: string; color: Color; word: number; hit?: boolean; say?: [number, number] }[];
  /** Squares named, as rings. */
  rings: { sq: string; word: number; say?: [number, number] }[];
}
// `say` on an arrow or ring: the words the director gave for it (first and last word), which it appears on
// and lights up in the bubble; without them, the words are found for it (see markColors).

/** The cold open: the payoff moment, played first, before "how did we get here?". */
export interface VideoHook {
  /** The move whose position, quote and verdict open the video. */
  ply: number;
  /** Verbatim excerpt of that move's commentary (omitted for a human's move). */
  quote?: string;
  delivery?: string;
  marks?: ThoughtMark[];
  /** The on-screen hook, a dozen words at most ("Sonnet thinks it's winning. It's mate in one."). */
  caption: string;
}

export interface VideoPackaging {
  /** YouTube title. */
  title: string;
  /** TikTok caption, hashtags included. */
  caption: string;
  /** The thumbnail: the position after this move, with a few words of big text. */
  thumbnail: { ply: number; text: string };
}

export type PublishPlatform = "youtube" | "tiktok";
/** "test": YouTube unlisted and TikTok only-me, to check a post before anyone sees it. */
export type PublishVisibility = "public" | "test";

export interface PublishedPost {
  /** The post's link (null when the publisher couldn't find it, e.g. TikTok still processing). */
  url: string | null;
  visibility: PublishVisibility;
  at: number;
  note?: string;
}

/** One request to post a game's videos, carried out by a publisher agent in the user's browser. */
export interface PublishState {
  platforms: PublishPlatform[];
  visibility: PublishVisibility;
  status: "requested" | "done" | "failed";
  requestedAt: number;
  /** Counts the requests, so each one's publisher is a new task. */
  attempt: number;
  /** Every post made so far, kept across requests: a platform posted once is never posted again. */
  posts: Partial<Record<PublishPlatform, PublishedPost>>;
  /** What went wrong, per platform, in the last request. */
  errors?: Partial<Record<PublishPlatform, string>>;
}

export interface VideoPlan {
  moments: VideoMoment[];
  /** The best verbatim line from each interview, for the short cut. */
  interviewLines: { pre: Partial<Record<Color, string>>; post: Partial<Record<Color, string>> };
  /** How each interview line is spoken (see VideoMoment.delivery). */
  interviewDelivery?: { pre: Partial<Record<Color, string>>; post: Partial<Record<Color, string>> };
  hook?: VideoHook;
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
