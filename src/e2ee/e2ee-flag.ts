/**
 * `E2EE_DMS_ENABLED`: `'true'` turns encrypted messaging on and `'false'`
 * turns it off. When unset it is on for `local` and `development` (staging)
 * and off everywhere else, including production.
 */
export function isE2eeEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const flag = env.E2EE_DMS_ENABLED?.trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return env.NODE_ENV === 'local' || env.NODE_ENV === 'development';
}
