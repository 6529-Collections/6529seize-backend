import { appFeatures } from '@/app-features';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { Time } from '@/time';

/**
 * Identities move to the 6529 chain. From the freeze 6529.io stops changing
 * profiles, handles, profile statements, REP and NIC ratings and REP/NIC
 * proxy allocations: the chain imports them as they stand at the freeze,
 * and from switch-on people change them on the chain through this site.
 * Waves, drops and wave proxies are not frozen.
 *
 * The freeze is on when FEATURE_IDENTITY_FROZEN is `true`, or from the time
 * in IDENTITY_FREEZE_AT (ISO 8601 UTC such as `2026-11-24T00:00:00Z`, or Unix
 * milliseconds). The time lets a deployment made before the freeze start it
 * at the exact second, with no restart.
 *
 * From switch-on (FEATURE_IDENTITY_ON_CHAIN, or the time in
 * IDENTITY_SWITCH_ON_AT) the chain holds identities for good: the same writes
 * stay refused, whatever the freeze settings, and the refusals say where the
 * change is made now. No profile is ever made here implicitly again.
 */
export const IDENTITY_FROZEN_CODE = 'IDENTITY_FROZEN';

export const IDENTITY_FROZEN_STATUS = 423;

export const IDENTITY_FREEZE_AT_ENV = 'IDENTITY_FREEZE_AT';

export const IDENTITY_SWITCH_ON_AT_ENV = 'IDENTITY_SWITCH_ON_AT';

export const IDENTITY_FROZEN_MESSAGE =
  `Profiles, handles, REP and NIC are moving to the 6529 Network, ` +
  `so they can't be changed here right now. ` +
  `Soon you will change them on the 6529 Network, through this site.`;

export const IDENTITY_FROZEN_NOMINATION_MESSAGE =
  `This wallet has no profile yet, and new profiles can't be made here ` +
  `while profiles move to the 6529 Network. ` +
  `Nominate a wallet that already has a profile, or try again later.`;

export const IDENTITY_ON_CHAIN_MESSAGE =
  `Profiles, handles, REP and NIC now live on the 6529 Network. ` +
  `Change them on the 6529 Network, through this site.`;

export const IDENTITY_ON_CHAIN_NOMINATION_MESSAGE =
  `This wallet has no identity on the 6529 Network yet. ` +
  `Nominate a wallet that has one.`;

/** What a refused write was: a profile/REP/NIC write, or a nomination. */
export type IdentityRefusal = 'write' | 'nomination';

const logger = Logger.get('IDENTITY_FREEZE');

export class IdentityFrozenException extends CustomApiCompliantException {
  constructor(message: string = identityRefusalMessage('write')) {
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

const warnedAboutBadTime = new Set<string>();

/** Whether the time in `env` has come; a malformed time counts as come. */
function timeHasCome(env: string, nowMillis: number): boolean {
  const raw = process.env[env];
  const start = parseIdentityFreezeAt(raw);
  if (start === undefined) {
    return false;
  }
  if (start === null) {
    if (!warnedAboutBadTime.has(env)) {
      warnedAboutBadTime.add(env);
      logger.error(
        `[${env} IS NOT A UTC TIME] [VALUE ${raw}] [TREATED AS COME]`
      );
    }
    return true;
  }
  return nowMillis >= start;
}

/** From switch-on the 6529 chain holds identities for good. */
export function isIdentityOnChain(
  nowMillis: number = Time.currentMillis()
): boolean {
  return (
    appFeatures.isIdentityOnChain() ||
    timeHasCome(IDENTITY_SWITCH_ON_AT_ENV, nowMillis)
  );
}

/** Identity writes are refused: frozen, or on the chain since switch-on. */
export function isIdentityFrozen(
  nowMillis: number = Time.currentMillis()
): boolean {
  return (
    appFeatures.isIdentityFrozen() ||
    timeHasCome(IDENTITY_FREEZE_AT_ENV, nowMillis) ||
    isIdentityOnChain(nowMillis)
  );
}

export function identityRefusalMessage(
  kind: IdentityRefusal,
  nowMillis: number = Time.currentMillis()
): string {
  if (isIdentityOnChain(nowMillis)) {
    return kind === 'nomination'
      ? IDENTITY_ON_CHAIN_NOMINATION_MESSAGE
      : IDENTITY_ON_CHAIN_MESSAGE;
  }
  return kind === 'nomination'
    ? IDENTITY_FROZEN_NOMINATION_MESSAGE
    : IDENTITY_FROZEN_MESSAGE;
}

/** Throws IdentityFrozenException while identity writes are refused. */
export function assertIdentityNotFrozen(kind: IdentityRefusal = 'write'): void {
  const now = Time.currentMillis();
  if (isIdentityFrozen(now)) {
    throw new IdentityFrozenException(identityRefusalMessage(kind, now));
  }
}
