/** Retained aggregate/voter stream IDs remain unchanged. New native observations
 * use a disjoint safe-integer range while old application versions drain. */
export const NATIVE_SCORE_SEQUENCE_BASE = 2 ** 52;

export function nativeScoreSequence(sequence: number): number {
  const result = NATIVE_SCORE_SEQUENCE_BASE + sequence;
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !Number.isSafeInteger(result)
  ) {
    throw new Error(
      'Native score history sequence exceeds its safe integer range'
    );
  }
  return result;
}
