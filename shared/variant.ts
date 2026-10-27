/*
 * The variants by name, apart from their rules (shared/rules.ts, which re-exports these), so a page that only names
 * a game's variant doesn't load the rules libraries.
 */

export type Variant = "standard" | "chess960";

/** A game's variant (old games have none: standard). */
export const variantOf = (g: { variant?: Variant } | null | undefined): Variant => g?.variant ?? "standard";
/** Every variant: each has its own ratings and leaderboard, so a Chess960 result never moves a standard rating. */
export const VARIANTS: Variant[] = ["standard", "chess960"];
export const VARIANT_NAME: Record<Variant, string> = { standard: "Standard", chess960: "Chess960" };
/** What a rating is called where it's shown: "Chess960 rating" for Chess960, plain "rating" otherwise. */
export const ratingName = (v: Variant) => (v === "chess960" ? "Chess960 rating" : "rating");
