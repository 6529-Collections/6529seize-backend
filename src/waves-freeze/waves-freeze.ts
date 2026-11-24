import { appFeatures } from '@/app-features';
import { CompetitionCapability } from '@/entities/ICompetition';
import { env } from '@/env';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { Time } from '@/time';

/**
 * Waves, groups and decisions move to the 6529 chain, except those that
 * stay on 6529.io: src/waves-scope/waves-scope.ts holds the rule, with
 * every reason a wave or a group stays.
 * From the waves freeze 6529.io stops changing
 * what moves: the chain imports it as it stands at the freeze, and from
 * switch-on people change it on the chain through this site. Frozen, for a
 * wave that moves: wave create and edit, its pinned (description) drop,
 * replacing, hiding or showing a group it, its decisions or curations use,
 * decision create, edit, clone and actions, decision pauses, entries,
 * votes, wave REP, polls and poll votes, and the decision loop's results.
 * Chat (posting, editing and deleting chat drops, reactions, DMs) stays
 * open, except that a chat drop with a poll can't be edited or deleted:
 * that would delete the poll. A wave that stays keeps everything working.
 * While frozen, no write may move a wave from one side to the other.
 * The checks that read a wave's side are in waves-freeze-scope.ts.
 *
 * The freeze is on when FEATURE_WAVES_FROZEN is `true`, or from the time in
 * WAVES_FREEZE_AT (ISO 8601 UTC such as `2026-11-25T00:00:00Z`, or Unix
 * milliseconds). The time lets a deployment made before the freeze start it
 * at the exact second, with no restart. To turn the freeze off, remove both:
 * any WAVES_FREEZE_AT that is not such a time (`0`, `false`, seconds,
 * microseconds, a local time, a day that doesn't exist, a time past 24:00,
 * a time before 2020 or from 2100) freezes at once, and is logged. 24:00 is
 * the next day's 00:00.
 *
 * FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE=true keeps the Main Stage decision
 * running here through the freeze: its entries, votes, pauses and results
 * go on as before, for one more cycle. Everything else stays frozen.
 *
 * The export starts no earlier than WAVES_FREEZE_AT + 5 minutes. Each write
 * path checks the freeze early and again inside its transaction, after the
 * locks it waits on and right before it writes; an entry edit checks once
 * more in its delete step, after that step's locks and before the old rows
 * go. Paths without a transaction check right before the write. A check and
 * a commit are still two steps: a request let in before the freeze can
 * commit just after it. Each lock wait is bounded (the server's default
 * innodb_lock_wait_timeout is 50 s; API post and reaction transactions set
 * 10 s, and the API Lambda stops at 30 s). The margin covers that.
 */
export const WAVES_FROZEN_CODE = 'WAVES_FROZEN';

export const WAVES_FROZEN_STATUS = 423;

export const WAVES_FREEZE_AT_ENV = 'WAVES_FREEZE_AT';

export const MAIN_STAGE_WAVE_ID_ENV = 'MAIN_STAGE_WAVE_ID';

export const WAVES_SWITCH_ON_AT_ENV = 'WAVES_SWITCH_ON_AT';

export const WAVES_FROZEN_MESSAGE =
  `Waves and decisions are moving to the 6529 Network. ` +
  `Until the move is done, waves, their groups, decisions, entries, votes, ` +
  `wave REP and polls can't be changed here. Chat works as usual.`;

export const WAVES_FROZEN_GROUP_MESSAGE =
  `This group is used by a wave, a decision or a curation, and waves are ` +
  `moving to the 6529 Network, so it can't be replaced right now. ` +
  `You can save it as a new group instead.`;

export const WAVES_FROZEN_GROUP_VISIBILITY_MESSAGE =
  `This group is used by a wave, a decision or a curation, and waves are ` +
  `moving to the 6529 Network, so it can't be hidden or shown right now.`;

export const WAVES_FROZEN_POLL_MESSAGE =
  `This message has a poll, and polls can't be changed while waves move ` +
  `to the 6529 Network.`;

const logger = Logger.get('WAVES_FREEZE');

export class WavesFrozenException extends CustomApiCompliantException {
  constructor(message: string = WAVES_FROZEN_MESSAGE) {
    super(WAVES_FROZEN_STATUS, message, WAVES_FROZEN_CODE);
  }
}

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

/** Earlier than any freeze: a smaller number is seconds or a mistake. */
const EARLIEST_FREEZE_AT_MS = Date.UTC(2020, 0, 1);

/**
 * Later than any freeze: a larger time (microseconds by mistake, year 9999)
 * would mean the freeze never comes, so it is a mistake too.
 */
const LATEST_FREEZE_AT_MS = Date.UTC(2100, 0, 1);

const isFreezeTime = (millis: number) =>
  Number.isFinite(millis) &&
  millis >= EARLIEST_FREEZE_AT_MS &&
  millis < LATEST_FREEZE_AT_MS;

/** 24:00, the end of the written day (ISO 8601), with no seconds past it. */
const END_OF_DAY = /T24:00(?::00(?:\.0{1,3})?)?(?:Z|[+-]00:00)$/;

/** The UTC midnight starting `day` (YYYY-MM-DD). */
function utcMidnight(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date);
}

/**
 * The freeze start from WAVES_FREEZE_AT: `undefined` when unset, `null` when
 * set to something that is not a UTC time from 2020 to 2099 (which freezes:
 * whoever set it meant a freeze).
 */
export function parseWavesFreezeAt(
  raw: string | undefined
): number | null | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d{1,16}$/.test(value)) {
    const millis = Number(value);
    return isFreezeTime(millis) ? millis : null;
  }
  if (ISO_UTC.test(value)) {
    const millis = Date.parse(value);
    const day = value.slice(0, 10);
    // Date.parse moves a day that doesn't exist (2026-11-31) into the next
    // month; such a value is not the time that was meant.
    if (
      !isFreezeTime(millis) ||
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

let warnedAboutBadFreezeAt = false;

/**
 * The waves freeze's time from WAVES_FREEZE_AT, in milliseconds, or null
 * when it is unset or not a valid time (FEATURE_WAVES_FROZEN alone has no
 * time). The waves scope reads it for "made after the freeze".
 */
export function wavesFreezeAtMs(): number | null {
  return parseWavesFreezeAt(process.env[WAVES_FREEZE_AT_ENV]) ?? null;
}

export function isWavesFrozen(
  nowMillis: number = Time.currentMillis()
): boolean {
  if (appFeatures.isWavesFrozen()) {
    return true;
  }
  const raw = process.env[WAVES_FREEZE_AT_ENV];
  const start = parseWavesFreezeAt(raw);
  if (start === undefined) {
    return false;
  }
  if (start === null) {
    if (!warnedAboutBadFreezeAt) {
      warnedAboutBadFreezeAt = true;
      logger.error(
        `[${WAVES_FREEZE_AT_ENV} IS NOT A UTC TIME] [VALUE ${raw}] [TREATED AS FROZEN]`
      );
    }
    return true;
  }
  return nowMillis >= start;
}

/**
 * Whether any waves setting is configured: WAVES_FREEZE_AT or
 * WAVES_SWITCH_ON_AT set, or FEATURE_WAVES_FROZEN or FEATURE_WAVES_ON_CHAIN
 * on. Until one is, a missing setting the waves need is only a warning, not
 * an operational error.
 */
export function wavesConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return (
    !!env[WAVES_FREEZE_AT_ENV]?.trim() ||
    !!env[WAVES_SWITCH_ON_AT_ENV]?.trim() ||
    env.FEATURE_WAVES_FROZEN === 'true' ||
    env.FEATURE_WAVES_ON_CHAIN === 'true'
  );
}

let warnedAboutBadSwitchOnAt = false;

/**
 * Whether waves have switched on on the 6529 chain: FEATURE_WAVES_ON_CHAIN
 * is `true`, or the time in WAVES_SWITCH_ON_AT (written as WAVES_FREEZE_AT
 * is) has come. From then a wave stays on 6529.io unless the chain holds it
 * (src/waves-scope/waves-scope.ts). A WAVES_SWITCH_ON_AT that is not such a
 * time does not switch on, and is logged: before the switch-on the rule
 * keeps every moving wave frozen, which is the safe side.
 */
export function isWavesSwitchedOn(
  nowMillis: number = Time.currentMillis()
): boolean {
  if (appFeatures.isWavesOnChain()) {
    return true;
  }
  const raw = process.env[WAVES_SWITCH_ON_AT_ENV];
  const start = parseWavesFreezeAt(raw);
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

/**
 * What the freeze needs to know of a decision: its capabilities when known,
 * and its wave (a migrated decision also names its legacy wave).
 */
export interface FreezeDecisionRef {
  readonly capabilities?: readonly string[] | null;
  readonly wave_id?: string | null;
  readonly legacy_wave_id?: string | null;
}

/**
 * The Main Stage decision: the one with the MAIN_STAGE capability. Where a
 * path knows only the wave (legacy entries, which act on their wave's
 * primary decision), the decision of the wave named in MAIN_STAGE_WAVE_ID.
 */
export function isMainStageDecision(decision: FreezeDecisionRef): boolean {
  if (decision.capabilities) {
    return decision.capabilities.includes(CompetitionCapability.MAIN_STAGE);
  }
  const mainStageWaveId = env.getStringOrNull(MAIN_STAGE_WAVE_ID_ENV);
  if (!mainStageWaveId) {
    return false;
  }
  return (
    decision.wave_id === mainStageWaveId ||
    decision.legacy_wave_id === mainStageWaveId
  );
}

/** Whether the Main Stage keeps running here through the waves freeze. */
export function isMainStageKeptDuringWavesFreeze(): boolean {
  return appFeatures.isWavesFreezeKeepingMainStage();
}

/**
 * Whether the freeze holds this decision, before its wave's side is read:
 * always while waves are frozen, except the Main Stage when
 * FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE is on. A decision of a wave that
 * stays on 6529.io is let through by waves-freeze-scope.ts.
 */
export function isDecisionFrozen(
  decision: FreezeDecisionRef,
  nowMillis: number = Time.currentMillis()
): boolean {
  if (!isWavesFrozen(nowMillis)) {
    return false;
  }
  return !(isMainStageKeptDuringWavesFreeze() && isMainStageDecision(decision));
}
