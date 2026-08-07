import { REP_CATEGORY_PATTERN } from '@/entities/IAbusivenessDetectionResult';

const MAX_LENGTH = 100;

// One character of the allowed alphabet, anywhere in the string. Kept in
// sync with REP_CATEGORY_PATTERN (which additionally forbids a leading
// dash); used to point out exactly which characters a rejected input used.
// Constructor form: /.../u literals are TS1501 at the repo's es5 target.
const ALLOWED_CHAR = new RegExp("^[\\p{L}\\p{N}?!,.'() -]$", 'u');

const ALLOWED_CHARS_SUMMARY = `letters, numbers, spaces, dashes and , . ? ! ' ( )`;

const describeChar = (char: string): string => {
  switch (char) {
    case '\n':
    case '\r':
      return 'line break';
    case '\t':
      return 'tab';
    default:
      return `"${char}"`;
  }
};

/**
 * Explains exactly which rep-category rule a given text violates, or null
 * when the text is valid. Callers surface the returned sentence directly to
 * the user, so each rule produces one specific, actionable message instead
 * of a catch-all listing every rule at once.
 */
export const explainRepCategoryViolation = (text: string): string | null => {
  // Count code points, not UTF-16 units, to stay exactly equivalent to the
  // pattern's `u`-flag length quantifier (verified by a property test).
  const length = Array.from(text).length;
  if (length === 0) {
    return `Category can't be empty.`;
  }
  if (length > MAX_LENGTH) {
    return `Category is ${length} characters long - the maximum is ${MAX_LENGTH}.`;
  }
  if (text.startsWith('-')) {
    return `Category can't start with a dash.`;
  }
  const disallowed = Array.from(
    new Set(Array.from(text).filter((char) => !ALLOWED_CHAR.test(char)))
  );
  if (disallowed.length > 0) {
    return `Category contains disallowed characters: ${disallowed
      .map(describeChar)
      .join(', ')}. Allowed characters are ${ALLOWED_CHARS_SUMMARY}.`;
  }
  if (!REP_CATEGORY_PATTERN.test(text)) {
    // Unreachable by construction of the checks above; kept as a safety net
    // so the explainer can never disagree with the authoritative pattern.
    return `Category is invalid. Allowed characters are ${ALLOWED_CHARS_SUMMARY}, and it can't start with a dash.`;
  }
  return null;
};
