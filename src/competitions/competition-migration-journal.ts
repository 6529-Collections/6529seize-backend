/** Drivers may return JSON as objects or strings. A corrupt image is an owned
 * stop: never acknowledge its watermark or expose its raw contents in errors. */
export function parseMigrationChangeImage(
  value: unknown
): Record<string, unknown> | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('OWNED_EXCEPTION: malformed migration journal image');
    }
  }
  if (parsed === null) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('OWNED_EXCEPTION: invalid migration journal image');
  return parsed as Record<string, unknown>;
}
