/**
 * Unencrypted ("legacy") DM retention, decided by the owner on 2026-10-31
 * (6529chain D146, P48 MG7 option (b)): members may move or export their own
 * history, then every server copy of unencrypted DM content is deleted on
 * the cutoff. From the cutoff, unencrypted DMs take no new messages and no
 * new unencrypted DM can be started.
 *
 * `LEGACY_DM_DELETION_CUTOFF` overrides the date for rehearsals (staging,
 * local). It must be an ISO 8601 UTC timestamp ending in `Z`; anything else
 * falls back to the decided date, so a typo can never move it silently.
 */
type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_LEGACY_DM_DELETION_CUTOFF = '2026-12-01T00:00:00.000Z';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/** The cutoff in epoch milliseconds. */
export function legacyDmDeletionCutoffMillis(env: Env = process.env): number {
  const raw = env.LEGACY_DM_DELETION_CUTOFF?.trim();
  if (raw && ISO_UTC.test(raw)) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse(DEFAULT_LEGACY_DM_DELETION_CUTOFF);
}

/** The cutoff as a canonical ISO string (milliseconds, `Z`). */
export function legacyDmDeletionCutoffIso(env: Env = process.env): string {
  return new Date(legacyDmDeletionCutoffMillis(env)).toISOString();
}

/** True from the cutoff on: unencrypted DMs are closed to new content. */
export function isLegacyDmClosed(
  nowMillis: number,
  env: Env = process.env
): boolean {
  return nowMillis >= legacyDmDeletionCutoffMillis(env);
}

export const LEGACY_DM_CLOSED_CODE = 'LEGACY_DM_CLOSED';

export function legacyDmClosedMessage(env: Env = process.env): string {
  return `Unencrypted DMs closed on ${legacyDmDeletionCutoffIso(env)}. Start an encrypted chat instead.`;
}
