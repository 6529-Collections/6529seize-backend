import { appFeatures } from '@/app-features';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { Time } from '@/time';

/**
 * Identities move to the 6529 chain. From the freeze 6529.io stops changing
 * profiles, handles, profile statements, REP and NIC ratings and REP/NIC
 * proxy allocations: the chain imports them as they stand at the freeze,
 * and from switch-on people change them on the chain through this site.
 * Waves, drops and wave proxies are not frozen, nor are the help bot's
 * credits: a 6529.io site feature kept in its own REP category, which the
 * chain does not import.
 *
 * The freeze is on when FEATURE_IDENTITY_FROZEN is `true`, or from the time
 * in IDENTITY_FREEZE_AT (ISO 8601 UTC such as `2026-11-24T00:00:00Z`, or Unix
 * milliseconds). The time lets a deployment made before the freeze start it
 * at the exact second, with no restart.
 */
export const IDENTITY_FROZEN_CODE = 'IDENTITY_FROZEN';

export const IDENTITY_FROZEN_STATUS = 423;

export const IDENTITY_FREEZE_AT_ENV = 'IDENTITY_FREEZE_AT';

export const IDENTITY_FROZEN_MESSAGE =
  `Profiles, handles, REP and NIC are moving to the 6529 Network, ` +
  `so they can't be changed here right now. ` +
  `Soon you will change them on the 6529 Network, through this site.`;

export const IDENTITY_FROZEN_NOMINATION_MESSAGE =
  `This wallet has no profile yet, and new profiles can't be made here ` +
  `while profiles move to the 6529 Network. ` +
  `Nominate a wallet that already has a profile, or try again later.`;

const logger = Logger.get('IDENTITY_FREEZE');

export class IdentityFrozenException extends CustomApiCompliantException {
  constructor(message: string = IDENTITY_FROZEN_MESSAGE) {
    super(IDENTITY_FROZEN_STATUS, message, IDENTITY_FROZEN_CODE);
  }
}

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

/**
 * The freeze start from IDENTITY_FREEZE_AT: `undefined` when unset, `null`
 * when set to something that is not a UTC time (which freezes: whoever set
 * it meant a freeze).
 */
export function parseIdentityFreezeAt(
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

export function isIdentityFrozen(
  nowMillis: number = Time.currentMillis()
): boolean {
  if (appFeatures.isIdentityFrozen()) {
    return true;
  }
  const raw = process.env[IDENTITY_FREEZE_AT_ENV];
  const start = parseIdentityFreezeAt(raw);
  if (start === undefined) {
    return false;
  }
  if (start === null) {
    if (!warnedAboutBadFreezeAt) {
      warnedAboutBadFreezeAt = true;
      logger.error(
        `[${IDENTITY_FREEZE_AT_ENV} IS NOT A UTC TIME] [VALUE ${raw}] [TREATED AS FROZEN]`
      );
    }
    return true;
  }
  return nowMillis >= start;
}

/** Throws IdentityFrozenException while identities are frozen. */
export function assertIdentityNotFrozen(
  message: string = IDENTITY_FROZEN_MESSAGE
): void {
  if (isIdentityFrozen()) {
    throw new IdentityFrozenException(message);
  }
}
