// Longest canonical meme id accepted in rememe filters; keeps ids well inside
// Number.MAX_SAFE_INTEGER so they compare exactly as JSON numbers.
export const MAX_REMEME_MEME_ID_DIGITS = 15;

/**
 * Returns the canonical decimal form of a meme id ("007" -> "7"), or null when
 * the piece is not a plain non-negative integer of acceptable length. The
 * canonical form is a valid JSON number, which JSON_CONTAINS requires.
 */
export function canonicalRememeMemeId(piece: string): string | null {
  if (!/^\d+$/.test(piece)) {
    return null;
  }
  const canonical = piece.replace(/^0+(?=\d)/, '');
  return canonical.length <= MAX_REMEME_MEME_ID_DIGITS ? canonical : null;
}
