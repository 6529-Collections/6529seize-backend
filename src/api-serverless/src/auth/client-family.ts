/** A coarse client family derived from a User-Agent header. */
export type ClientFamily =
  | 'desktop'
  | 'browser'
  | 'node'
  | 'python'
  | 'curl'
  | 'other'
  | 'none';

/**
 * The coarse client family of a User-Agent, for metrics and records that
 * must not keep the header itself. 6529 Desktop is recognised by Electron.
 */
export function clientFamilyOf(
  userAgent: string | null | undefined
): ClientFamily {
  const value = userAgent?.trim().toLowerCase();
  if (!value) {
    return 'none';
  }
  if (value.includes(' electron/')) {
    return 'desktop';
  }
  if (value.startsWith('mozilla/')) {
    return 'browser';
  }
  if (/^(node|node-fetch|undici|axios|got)(\/|\s|$)/.test(value)) {
    return 'node';
  }
  if (/^(python|aiohttp)/.test(value)) {
    return 'python';
  }
  if (value.startsWith('curl/')) {
    return 'curl';
  }
  return 'other';
}
