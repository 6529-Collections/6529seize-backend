import { Logger } from '@/logging';

/**
 * The waves freeze as the mirror reads it: the same environment and the
 * same rules as the freeze itself (the freeze flag, #2553:
 * src/waves-freeze/waves-freeze.ts isWavesFrozen, isMainStageDecision). This
 * branch doesn't have that module yet; once both are merged, the mirror
 * should call it instead of this copy.
 *
 * - The freeze is on when FEATURE_WAVES_FROZEN is `true`, or from the time
 *   in WAVES_FREEZE_AT (ISO 8601 UTC such as `2026-11-25T00:00:00Z`, or Unix
 *   milliseconds). Any other WAVES_FREEZE_AT (`0`, `false`, seconds, a
 *   local time) freezes at once, and is logged.
 * - FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE=true keeps the Main Stage decision
 *   running on 6529.io: the decision with the MAIN_STAGE capability, or,
 *   for a path that knows only the wave, the decision of the wave named in
 *   MAIN_STAGE_WAVE_ID.
 */

const logger = Logger.get('WAVES_CHAIN_MIRROR_FREEZE');

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

/** Earlier than any freeze: a smaller number is seconds or a mistake. */
const EARLIEST_FREEZE_AT_MS = Date.UTC(2020, 0, 1);

/**
 * The freeze start from WAVES_FREEZE_AT: `undefined` when unset, `null` when
 * set to something that is not a UTC time (which freezes).
 */
export function parseWavesFreezeAt(
  raw: string | undefined
): number | null | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d{1,16}$/.test(value)) {
    const millis = Number(value);
    return millis >= EARLIEST_FREEZE_AT_MS ? millis : null;
  }
  if (ISO_UTC.test(value)) {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

let warnedAboutBadFreezeAt = false;

/** Whether waves are frozen at `now`, by the freeze flag's rule. */
export function isWavesFrozenAt(env: NodeJS.ProcessEnv, now: number): boolean {
  if (env.FEATURE_WAVES_FROZEN === 'true') return true;
  const raw = env.WAVES_FREEZE_AT;
  const start = parseWavesFreezeAt(raw);
  if (start === undefined) return false;
  if (start === null) {
    if (!warnedAboutBadFreezeAt) {
      warnedAboutBadFreezeAt = true;
      logger.error(
        `[WAVES_FREEZE_AT IS NOT A UTC TIME] [VALUE ${raw}] [TREATED AS FROZEN]`
      );
    }
    return true;
  }
  return now >= start;
}

/**
 * Whether a competition is the Main Stage decision, by the freeze flag's
 * rule.
 */
export function isMainStageDecision(
  competition: {
    readonly capabilities: readonly string[] | null;
    readonly waveId: string;
    readonly legacyWaveId: string | null;
  },
  mainStageWaveId: string | null
): boolean {
  if (competition.capabilities) {
    return competition.capabilities.includes('MAIN_STAGE');
  }
  if (!mainStageWaveId) return false;
  return (
    competition.waveId === mainStageWaveId ||
    competition.legacyWaveId === mainStageWaveId
  );
}
