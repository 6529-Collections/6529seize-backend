import {
  countActiveProfiles,
  countSignedInIdentities,
  replaceUniquesDaily
} from '@/api/telemetry/telemetry-uniques.db';
import { utcDay } from '@/api/telemetry/telemetry-daily-salt';

/**
 * Signed-in actives (C52 D2), counts only, from data the backend already has:
 * - `signed_in_*`: distinct identities whose wallet session was used (sign-in
 *   or session refresh) in the window;
 * - `active_profiles_*`: distinct identities with authenticated write
 *   activity (drops, reactions, votes, waves, groups) in the window.
 * Windows end at the close of the UTC day: 1 day (DAU), 7 days (WAU) and
 * 30 days (MAU).
 */
export const ACTIVE_WINDOWS = [
  { suffix: 'dau', days: 1 },
  { suffix: 'wau', days: 7 },
  { suffix: 'mau', days: 30 }
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SignedInActives {
  readonly [metric: string]: number;
}

export function utcDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Counts for the windows that end at `end` (exclusive). */
export async function computeSignedInActives(
  end: Date
): Promise<SignedInActives> {
  const result: Record<string, number> = {};
  for (const { suffix, days } of ACTIVE_WINDOWS) {
    const start = new Date(end.getTime() - days * DAY_MS);
    const [signedIn, activeProfiles] = await Promise.all([
      countSignedInIdentities(start, end),
      countActiveProfiles(start, end)
    ]);
    result[`signed_in_${suffix}`] = signedIn;
    result[`active_profiles_${suffix}`] = activeProfiles;
  }
  return result;
}

/**
 * Stores the actives of a finished UTC day. Session activity only keeps the
 * latest use per session, so this snapshot runs soon after midnight; the
 * write-activity counts are exact at any time.
 */
export async function rollUpSignedInActives(day: string): Promise<void> {
  const end = new Date(utcDayStart(day).getTime() + DAY_MS);
  const actives = await computeSignedInActives(end);
  for (const [metric, count] of Object.entries(actives)) {
    await replaceUniquesDaily(day, metric, count);
  }
}

export function previousUtcDay(now: Date): string {
  return utcDay(new Date(utcDayStart(utcDay(now)).getTime() - DAY_MS));
}
