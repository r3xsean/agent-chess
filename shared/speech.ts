/*
 * Turning a player's written commentary into something a voice can say: chess notation into words
 * ("…Qxf7+!" → "queen takes f7, check!"), so the voice doesn't spell out letters and symbols.
 */

const PIECE: Record<string, string> = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight" };
const PROMO: Record<string, string> = { Q: "queen", R: "rook", B: "bishop", N: "knight" };

/** One SAN move in words. */
function sanWords(piece: string | undefined, from: string | undefined, takes: boolean, to: string, promo: string | undefined, check: string | undefined): string {
  const parts: string[] = [];
  if (piece) parts.push(PIECE[piece]);
  // A pawn capture names its file ("e takes d5"); a piece's disambiguation is left out ("knight d2").
  else if (takes && from) parts.push(from);
  if (takes) parts.push("takes");
  parts.push(to);
  if (promo) parts.push(`promotes to ${PROMO[promo]}`);
  let s = parts.join(" ");
  if (check === "#") s += ", checkmate";
  else if (check === "+") s += ", check";
  return s;
}

// What can come before a move: a move number ("12.", "12...", "12…") or the "..."/"…" of a Black move.
const PREFIX = String.raw`(?:\b\d+\s*(?:\.{1,3}|…)\s*|(?:\.{2,3}|…)\s*)`;
// A SAN move, optionally after a prefix: Nbd2, exd5, Qxf7+, e8=Q#, …
const SAN = new RegExp(String.raw`${PREFIX}?\b([KQRBN])?([a-h]?[1-8]?)(x)?([a-h][1-8])(?:=?([QRBN]))?([+#])?(?![a-z0-9])`, "g");
// Castling with letters is always castling; with zeros ("0-0") only right after a move number ("12. 0-0"),
// since "the score was 0-0" (or "was…0-0") is not a move.
const MOVE_NUMBER = String.raw`\b\d+\s*(?:\.{1,3}|…)\s*`;
const CASTLE = new RegExp(String.raw`(?:${PREFIX}?\b(O-O-O|O-O)|${MOVE_NUMBER}(0-0-0|0-0))([+#])?(?![-\w])`, "g");

/** Commentary as speech: moves in words, move numbers and notation dots dropped. */
export function speakable(text: string): string {
  return (
    text
      .replace(CASTLE, (_m, letters: string | undefined, zeros: string | undefined, check?: string) => {
        const c = letters ?? zeros ?? "";
        let s = c.length > 3 ? "castles long" : "castles";
        if (check === "#") s += ", checkmate";
        else if (check === "+") s += ", check";
        return s;
      })
      .replace(SAN, (m, piece?: string, from?: string, takes?: string, to?: string, promo?: string, check?: string) => {
        // A bare square ("the f7 pawn") reads fine as it is; only a real move gets rewritten.
        if (!piece && !takes && !promo && !check && !/^\s*(?:\d|\.{2,3}|…)/.test(m)) return m;
        return sanWords(piece, from || undefined, !!takes, to!, promo, check);
      })
      // Leftover notation punctuation: "(Nh5, Nd7)" stays readable, but "…" on its own is a pause.
      .replace(/\s*…\s*/g, "… ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}
