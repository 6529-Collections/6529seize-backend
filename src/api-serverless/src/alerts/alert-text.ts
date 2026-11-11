/**
 * Makes externally supplied text safe to place in an alert drop: collapses
 * whitespace and escapes the characters drop markup gives meaning to
 * (mention and link brackets, angle brackets).
 */
export function sanitizeAlertText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[[\]<>]/g, (character) => `\\${character}`)
    .trim();
}
