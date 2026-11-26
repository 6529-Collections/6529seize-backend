import { Logger } from '@/logging';
import { Time } from '@/time';

/**
 * Whether waves have switched on on the 6529 chain, read on every call:
 * FEATURE_WAVES_ON_CHAIN is `true`, or the time in WAVES_SWITCH_ON_AT has
 * come. The time is ISO 8601 UTC (such as `2026-11-28T00:00:00Z`; 24:00 is
 * the next day's 00:00) or Unix milliseconds, from 2020 up to 2100. Any
 * other value (`0`, `false`, seconds, microseconds, a local time, a day
 * that doesn't exist, a time past 24:00) never switches on, and is logged
 * once: until the switch-on waves writes stay closed, which is the safe
 * side. Unset never switches on.
 *
 * These are the rules the waves freeze reads its times by (WAVES_FREEZE_AT
 * and WAVES_SWITCH_ON_AT in waves-freeze.ts), kept here in a file of its own
 * so that code without the freeze reads the switch-on the same way.
 */
export const WAVES_SWITCH_ON_AT_ENV = 'WAVES_SWITCH_ON_AT';

const WAVES_ON_CHAIN_FLAG = 'FEATURE_WAVES_ON_CHAIN';

const logger = Logger.get('WAVES_SWITCH_ON');

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

/** Earlier than any switch-on: a smaller number is seconds or a mistake. */
const EARLIEST_MS = Date.UTC(2020, 0, 1);

/** Later than any switch-on: microseconds by mistake, or year 9999. */
const LATEST_MS = Date.UTC(2100, 0, 1);

const isSwitchOnTime = (millis: number) =>
  Number.isFinite(millis) && millis >= EARLIEST_MS && millis < LATEST_MS;

/** 24:00, the end of the written day (ISO 8601), with no seconds past it. */
const END_OF_DAY = /T24:00(?::00(?:\.0{1,3})?)?(?:Z|[+-]00:00)$/;

/** The UTC midnight starting `day` (YYYY-MM-DD). */
function utcMidnight(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date);
}

/**
 * A waves time setting: `undefined` when unset, `null` when set to
 * something that is not a UTC time from 2020 to 2099.
 */
export function parseWavesTime(
  raw: string | undefined
): number | null | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d{1,16}$/.test(value)) {
    const millis = Number(value);
    return isSwitchOnTime(millis) ? millis : null;
  }
  if (ISO_UTC.test(value)) {
    const millis = Date.parse(value);
    const day = value.slice(0, 10);
    // Date.parse moves a day that doesn't exist (2026-11-31) into the next
    // month; such a value is not the time that was meant.
    if (
      !isSwitchOnTime(millis) ||
      new Date(utcMidnight(day)).toISOString().slice(0, 10) !== day
    )
      return null;
    // 24:00 is the next day's 00:00, as Date.parse reads it; any other time
    // stays on its day.
    if (END_OF_DAY.test(value)) return millis;
    return new Date(millis).toISOString().slice(0, 10) === day ? millis : null;
  }
  return null;
}

let warnedAboutBadSwitchOnAt = false;

/** Whether waves have switched on (see the top of this file). */
export function wavesSwitchedOn(
  nowMillis: number = Time.currentMillis()
): boolean {
  if (process.env[WAVES_ON_CHAIN_FLAG] === 'true') {
    return true;
  }
  const raw = process.env[WAVES_SWITCH_ON_AT_ENV];
  const start = parseWavesTime(raw);
  if (start === undefined) {
    return false;
  }
  if (start === null) {
    if (!warnedAboutBadSwitchOnAt) {
      warnedAboutBadSwitchOnAt = true;
      logger.error(
        `[${WAVES_SWITCH_ON_AT_ENV} IS NOT A UTC TIME] [VALUE ${raw}] [NOT SWITCHED ON]`
      );
    }
    return false;
  }
  return nowMillis >= start;
}
