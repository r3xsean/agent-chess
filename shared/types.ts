export type Color = "w" | "b";
/** A game's agent seats: the two players, the broadcaster (x) and the video director (d). */
export type SeatRole = Color | "x" | "d";
export type Phase = "pregame" | "playing" | "postgame" | "finished";
export type Result = "1-0" | "0-1" | "1/2-1/2";

export interface GamePause {
  at: number;
  /** Stable reason for behavior; the readable reason is not used as a condition. */
  code: string;
  reason: string;
  seats?: Color[];
  resetAt?: number;
}

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
  /** Stable identity: "model@effort" (a human: "human:name"). Ratings key off this. */
  id: string;
  provider: string;
  model: string;
  modelLabel: string;
  effort: string;
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
  /** The second-best move (UCI), when one exists: an engine line's branch point offers it (see shared/engineLine.ts). */
  secondUci?: string;
  /**
   * The verdict on other moves played here (by UCI), judged as a game move would be: the branches and probes
   * of engine lines play moves the engine wouldn't, and each still gets its badge (see server/lineDepth.ts).
   */
  verdicts?: Record<string, Classification>;
  /**
   * What an engine line's questions are answered from (server/lineQuestions.ts), searched for the points of the
   * lines most worth a video: the side to move's best few moves, each with its line (`options`); what the side
   * that just moved would play if the other passed (`threat`); and the move a quick, shallow search picks
   * (`shallowUci`), the one a human reaches for when it isn't the engine's.
   */
  options?: { uci: string; score: Score; pv: string[] }[];
  threat?: { score: Score; pv: string[] } | null;
  shallowUci?: string;
  /** The engine could not analyze this position (retried on next server start). */
  failed?: boolean;
  /**
   * The verdict on playing `bestUci` here (best, great, brilliant, forced), once the position after it is
   * analysed too: what an engine line's moves are badged with (see server/lineDepth.ts).
   */
  bestVerdict?: Classification;
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
  broadcast: BroadcastLine[];
  broadcasterDone: boolean;
  /** Feed event ids already handed to the broadcaster. */
  bcDelivered: string[];
  /** Last time each seat talked to the server. */
  seen: Partial<Record<SeatRole, number>>;
  pendingIllegal: Record<Color, string[]>;
  /** The full illegal attempts this turn, alongside `pendingIllegal` (missing on older games). */
  pendingTries?: Record<Color, IllegalTry[]>;
  turnStartedAt: number | null;
  /** Freeze thinking time during a provider outage; persisted across restarts. */
  clockPause?: GamePause;
  /** Latest provider failure consumed per seat, so recovery cannot replay an old pause. */
  usageLimitSeen?: Partial<Record<Color, string>>;
  /** Successful game actions only: status checks and long-poll requests are not recovery. */
  lastAgentActionAt?: Partial<Record<Color, number>>;
  analysis: Record<string, PositionAnalysis>;
  /** Which version of the engine-line deepening (server/lineDepth.ts) has analysed this game's lines move by move. */
  linesDepth?: number;
  opening: { eco: string; name: string } | null;
  review: Record<Color, SideReview> | null;
  ratingChange?: Record<Color, number>;
  /** Each side's rating going into this game (after it: plus ratingChange). Fixed when it's rated, so later games never move it. */
  ratingBefore?: Record<Color, number>;
  playStartedAt: number | null;
  endedAt?: number;
  /** All post-game duties completed; used for tournament breaks. */
  finishedAt?: number;
  /** What the agents' briefing includes. Fixed at creation so a running game's conditions never change. */
  options?: { pieceList?: boolean; /** false: the result moves no rating and no leaderboard record. */ rated?: boolean };
  /** When the orchestrator delegated each seat (so a second orchestrator run never double-launches). */
  launched?: Partial<Record<SeatRole, number>>;
  /** Seats the server launched itself, each in its own T3 thread (the server watches these; an orchestrator watches the rest). */
  directLaunch?: Partial<Record<SeatRole, { at: number; relaunches: number }>>;
  /** When the server summoned this broadcast game's video director, once the game was over. */
  directorSummonedAt?: number;
  /** How many times that director was summoned again because it never turned up. */
  directorResummons?: number;
  /** Each seat's last accepted turn (its JSON, hashed), so a retried `move` isn't played again in the next position. */
  lastTurn?: Partial<Record<Color, { hash: string; san: string }>>;
  /** A replayed illegal submission is not evidence that the agent recovered. */
  rejectedTurns?: Partial<Record<Color, { hashes: string[]; ply: number }>>;
  /** How many moves had been played when each seat was last shown the position (a YOUR MOVE brief or `status`). */
  briefedAt?: Partial<Record<Color, number>>;
  /** Last time the website asked T3 to summon agents for this game. */
  summonRequestedAt?: number;
  /** Tournament auto-run: the next pairing has been requested after this game finished. */
  nextTriggered?: boolean;
  /** Version of the move-classification rules the stored verdicts came from. */
  classifierVersion?: number;
  /** The broadcaster's picks for the video replay, made after the game. */
  video?: VideoPlan;
  /** The user's approval of the exact video plan, before voices and rendering. */
  videoApproval?: { revision: string; at: number };
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
   * why the side it favours is better at its end (absent: the line's own plain fact). `refs`: what the
   * caption's words point at, as the director said (see LineRef); `draw`: reaches drawn with it; `rings`:
   * squares it circles.
   * `punish` (an `instead` line only): first, what the move played allowed, played out from it (see
   * ShownLine.punish) and explained in the director's words, before the board winds back for the line.
   */
  line?: {
    kind: "instead" | "after";
    caption?: string;
    refs?: LineRef[];
    draw?: LineReach[];
    rings?: string[];
    punish?: LinePunish;
    /** What the narrator says over the line, step by step (see LineBeat). */
    beats?: LineBeat[];
    /** How many of the line's moves are shown (the director cuts it once its point is made); all when absent. */
    end?: number;
    /**
     * Keep the move's best-move arrow (and "best was") when an `instead` line plays after it. By default they're
     * hidden there, so the narrator's reveal isn't given away the moment the move lands.
     */
    showBest?: true;
    /**
     * Chosen from lines followed move by move (shared/engineLine.ts). Plans saved before that have none and
     * keep their lines as they were then (read off the stored PV).
     */
    deep?: true;
    /**
     * An `instead` line (without `punish`) played before the move rather than after it: the board freezes on
     * the position the player faced, the line plays, and then the player's quote and their real move land.
     */
    first?: boolean;
    /** Other ways the line could go, each played from a point of it and narrated in turn (see LineBranch). */
    branches?: LineBranch[];
  };
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
  /**
   * What the words of this mark's part of the quote point at, as the director said (first and last word):
   * squares, or one of the mark's move arrows (its index). These are the words lit up in the bubble, each
   * in the colour of what it points at. Plans from before refs had them found instead (see markColors).
   */
  refs?: ThoughtRef[];
}

export interface ThoughtRef {
  words: [number, number];
  sqs?: string[];
  move?: number;
}
/**
 * What words of an engine line's caption point at, on the board as it stands when the caption shows:
 * squares (circled, or at the end of a reach, as the director drew them), or one of the moves on the board
 * (an index). The words light up in the colour of what they point at.
 */
export interface LineRef {
  words: [number, number];
  sqs?: string[];
  move?: number;
}

/**
 * One thing the narrator says during an engine line, in the director's own words, spoken in the narrator's
 * voice and shown as the line's comment: `at` is how many of the line's moves are on the board when it's
 * said (0: before the first, while the board holds on where the line starts). The line waits for it.
 */
export interface LineBeat {
  at: number;
  text: string;
  delivery?: string;
  /**
   * The board moving on the words: once the voice reaches word `word` of the text, `moves` of the line's moves
   * are on the board (the ones before it land just ahead, quickly), so a move lands as it's named.
   */
  cues?: { word: number; moves: number }[];
  /** First beat only, at 0: keep the real board until this word, then enter the tinted engine view and rewind if needed. */
  enter?: number;
  /** What the words point at, drawn as they're said: a piece's reach ("f5>h4", from/to) or a circled square. */
  draw?: { word: number; last?: number; from?: string; to?: string; ring?: string }[];
}

/**
 * A branch of an engine line (see shared/engineLine.ts, ShownBranch): once `at` of the line's moves are on the
 * board, another move (`uci`) is played there instead, and the engine's best play after it, cut to `end` moves
 * (the other move included). `when`: "before", the branch plays as the line reaches `at` and the board winds
 * back to it before the line goes on (the natural move that fails, shown before the one that works); "after",
 * once the line has played out the board winds back to `at` for it (what if they try this instead?). `beats`
 * are the narrator's over it, `at` and cues counting the branch's own moves.
 */
export interface LineBranch {
  at: number;
  uci: string;
  /** Moves chosen after `uci` (UCI), played before the engine's best play takes over: a line of the director's own. */
  then?: string[];
  when: "before" | "after";
  end?: number;
  beats?: LineBeat[];
}

/** A piece's attack or defence drawn with a caption ("d4>f3"), up while the piece stays on `from`. */
export interface LineReach {
  from: string;
  to: string;
  color: Color;
}

/**
 * What the move played allowed, as the director tells it: its caption shows once `at` moves of the
 * punishment (the move played included) are on the board, with its reaches and circles (each up while its
 * piece stays on its square).
 */
export interface LinePunish {
  at: number;
  caption: string;
  refs?: LineRef[];
  draw?: LineReach[];
  rings?: string[];
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
  /** YouTube description written by the user, in place of the one made with the YouTube render. */
  description?: string;
  /** The thumbnail: the position after this move, with a few words of big text. */
  thumbnail: { ply: number; text: string };
}

/** The director's choices for the upload, its favourite first: the user picks one of each (VideoPlan.packaging holds the picks). */
export interface VideoPackagingOptions {
  titles: string[];
  captions: string[];
  thumbnails: VideoPackaging["thumbnail"][];
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
  /** When this request's publisher was handed to an orchestrator run (only one run ever gets it). */
  handedOutAt?: number;
  /** Every post made so far, kept across requests: a platform posted once is never posted again. */
  posts: Partial<Record<PublishPlatform, PublishedPost>>;
  /** What went wrong, per platform, in the last request. */
  errors?: Partial<Record<PublishPlatform, string>>;
}

/**
 * A line said in passing while the game plays on (all of them in the YouTube cut, the ones marked `short` in
 * the TikTok cut too): no drawings, and the board doesn't stop for it, so it's a line that holds for a stretch
 * of moves (a plan, a verdict, a worry), not one about a single move. It's said as its move lands, and the
 * board waits for it only where the next line or moment would otherwise cut it off.
 */
export interface VideoAside {
  ply: number;
  /** Verbatim excerpt of the mover's commentary on that move, or of what they wrote with an illegal attempt on it. */
  quote: string;
  delivery?: string;
  /** Said in the TikTok cut too (the YouTube cut has every aside). */
  short?: boolean;
}

export interface VideoPlan {
  moments: VideoMoment[];
  /** Lines said in passing between the moments: the opening's conversation, and what keeps the quiet stretches talking. */
  asides?: VideoAside[];
  /** Plies in stretches the director left quiet on purpose (nothing said there holds beyond its own move). */
  quiet?: number[];
  /** The best verbatim line from each interview, for the short cut. */
  interviewLines: { pre: Partial<Record<Color, string>>; post: Partial<Record<Color, string>> };
  /** How each interview line is spoken (see VideoMoment.delivery). */
  interviewDelivery?: { pre: Partial<Record<Color, string>>; post: Partial<Record<Color, string>> };
  hook?: VideoHook;
  /** What the upload uses: the user's pick of each option (the director's favourite until they pick), or their own wording. */
  packaging?: VideoPackaging;
  /** The director's titles, captions and thumbnails to pick from (none on plans from before there were several). */
  packagingOptions?: VideoPackagingOptions;
  /** How many times a director has given new options for this plan since it was made (each one is a new task). */
  packagingRedos?: number;
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

export interface Tournament {
  id: string;
  name: string;
  createdAt: number;
  players: PlayerRef[];
  doubleRound: boolean;
  broadcaster: Game["broadcaster"];
  /** false: none of its games are rated. */
  rated?: boolean;
  /** Started from the website: each finished game automatically summons the next pairing. */
  autoRun?: boolean;
  /** Every game is Chess960; each pairing carries its start position (shared by a double round-robin's return game). */
  chess960?: boolean;
  pairings: { white: string; black: string; gameId?: string; chess960?: number }[];
  status: "running" | "finished";
  /** Games played at once (default: as many as the players fill, half of them). Above 1, no model is ever in two rated games at the same time, in or out of the tournament; unrated games don't count. */
  boards?: number;
  /** Hours between batches of games, starting when all active boards finish. Default: 0. */
  breakHours?: number;
  /** When a break was last skipped from the website: a break that started before this is over. */
  breakSkippedAt?: number;
  /** Last time the server asked T3 to start more pairings (so it doesn't ask twice in a row). */
  lastKickAt?: number;
}

export interface ModelOption {
  provider: string;
  model: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
}
