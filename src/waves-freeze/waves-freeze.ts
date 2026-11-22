import { appFeatures } from '@/app-features';
import { CompetitionCapability } from '@/entities/ICompetition';
import { env } from '@/env';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { Time } from '@/time';

/**
 * Waves, groups and decisions move to the 6529 chain. From the waves freeze
 * 6529.io stops changing them: the chain imports them as they stand at the
 * freeze, and from switch-on people change them on the chain through this
 * site. Frozen: wave create and edit, replacing a group a wave or decision
 * uses, decision create, edit and actions, decision pauses, entries, votes,
 * wave REP, polls and poll votes, and the decision loop's results. Chat
 * (posting, editing and deleting chat drops, reactions, DMs) stays open.
 *
 * The freeze is on when FEATURE_WAVES_FROZEN is `true`, or from the time in
 * WAVES_FREEZE_AT (ISO 8601 UTC such as `2026-11-24T06:00:00Z`, or Unix
 * milliseconds). The time lets a deployment made before the freeze start it
 * at the exact second, with no restart.
 *
 * FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE=true keeps the Main Stage decision
 * running here through the freeze: its entries, votes, pauses and results
 * go on as before, for one more cycle. Everything else stays frozen.
 */
export const WAVES_FROZEN_CODE = 'WAVES_FROZEN';

export const WAVES_FROZEN_STATUS = 423;

export const WAVES_FREEZE_AT_ENV = 'WAVES_FREEZE_AT';

export const MAIN_STAGE_WAVE_ID_ENV = 'MAIN_STAGE_WAVE_ID';

export const WAVES_FROZEN_MESSAGE =
  `Waves and decisions are moving to the 6529 Network. ` +
  `Until the move is done, waves, their groups, decisions, entries, votes, ` +
  `wave REP and polls can't be changed here. Chat works as usual.`;

export const WAVES_FROZEN_GROUP_MESSAGE =
  `This group is used by a wave or a decision, and waves are moving to the ` +
  `6529 Network, so it can't be replaced right now. ` +
  `You can save it as a new group instead.`;

const logger = Logger.get('WAVES_FREEZE');

export class WavesFrozenException extends CustomApiCompliantException {
  constructor(message: string = WAVES_FROZEN_MESSAGE) {
    super(WAVES_FROZEN_STATUS, message, WAVES_FROZEN_CODE);
  }
}

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

/**
 * The freeze start from WAVES_FREEZE_AT: `undefined` when unset, `null` when
 * set to something that is not a UTC time (which freezes: whoever set it
 * meant a freeze).
 */
export function parseWavesFreezeAt(
  raw: string | undefined
): number | null | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d{1,16}$/.test(value)) {
    return Number(value);
  }
  if (ISO_UTC.test(value)) {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

let warnedAboutBadFreezeAt = false;

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

/** Throws WavesFrozenException while waves are frozen. */
export function assertWavesNotFrozen(
  message: string = WAVES_FROZEN_MESSAGE
): void {
  if (isWavesFrozen()) {
    throw new WavesFrozenException(message);
  }
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
 * The Main Stage decision: the one with the MAIN_STAGE capability, or any
 * decision of the wave named in MAIN_STAGE_WAVE_ID.
 */
export function isMainStageDecision(decision: FreezeDecisionRef): boolean {
  if (decision.capabilities?.includes(CompetitionCapability.MAIN_STAGE)) {
    return true;
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
 * Whether the freeze holds this decision: always while waves are frozen,
 * except the Main Stage when FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE is on.
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

/**
 * Throws WavesFrozenException when the freeze holds this decision: its
 * entries, votes, pauses, edits and actions are refused.
 */
export function assertDecisionNotFrozen(
  decision: FreezeDecisionRef,
  message: string = WAVES_FROZEN_MESSAGE
): void {
  if (isDecisionFrozen(decision)) {
    throw new WavesFrozenException(message);
  }
}
