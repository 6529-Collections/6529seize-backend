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
  // Unix milliseconds have 13 digits until the year 2286. Seconds, a date
  // written as digits or 0 would land in 1970, which for switch-on can't be
  // undone: anything else is not a time.
  if (/^\d{13}$/.test(value)) {
    return Number(value);
  }
  if (ISO_UTC.test(value)) {
    const millis = Date.parse(value);
    // A date that doesn't exist (30 Feb) rolls over silently: not a time.
    const real =
      Number.isFinite(millis) &&
      new Date(millis).toISOString().slice(0, 10) === value.slice(0, 10);
    return real ? millis : null;
  }
  return null;
}

const warnedAboutBadTime = new Set<string>();

/**
 * Whether the time in `env` has come. A malformed time is logged once and
 * counts as `malformed` says: come for the freeze (refusing writes is the
 * safe side), not come for switch-on, whose effects can't be undone.
 */
function timeHasCome(
  env: string,
  nowMillis: number,
  malformed: 'come' | 'not_come'
): boolean {
  const raw = process.env[env];
  const start = parseIdentityFreezeAt(raw);
  if (start === undefined) {
    return false;
  }
  if (start === null) {
    if (!warnedAboutBadTime.has(env)) {
      warnedAboutBadTime.add(env);
      logger.error(
        `[${env} IS NOT A UTC TIME] [VALUE ${raw}] [TREATED AS ${
          malformed === 'come' ? 'COME' : 'NOT COME, WRITES FROZEN'
        }]`
      );
    }
    return malformed === 'come';
  }
  return nowMillis >= start;
}

const EARLIEST_SWITCH_ON_MS = Date.UTC(2026, 10, 24);

/**
 * A switch-on time that is set but can't be used: not a time, or earlier
 * than the freeze time (a wrong year or month would otherwise switch on at
 * deploy, which can't be undone).
 */
function switchOnTimeMalformed(): boolean {
  const raw = process.env[IDENTITY_SWITCH_ON_AT_ENV];
  const switchOn = parseIdentityFreezeAt(raw);
  if (switchOn === undefined) return false;
  if (switchOn === null) {
    return refuseSwitchOnTime(raw, 'IS NOT A UTC TIME');
  }
  // No switch-on comes before the freeze day: a wrong year or month set
  // without IDENTITY_FREEZE_AT would otherwise switch on at deploy. Test
  // stages switch on earlier with FEATURE_IDENTITY_ON_CHAIN.
  if (switchOn < EARLIEST_SWITCH_ON_MS) {
    return refuseSwitchOnTime(raw, 'IS BEFORE 2026-11-24T00:00:00Z');
  }
  const freeze = parseIdentityFreezeAt(process.env[IDENTITY_FREEZE_AT_ENV]);
  if (typeof freeze === 'number' && switchOn < freeze) {
    return refuseSwitchOnTime(raw, `IS BEFORE ${IDENTITY_FREEZE_AT_ENV}`);
  }
  return false;
}

/** Logs, once per value and reason, why a switch-on time is refused. */
function refuseSwitchOnTime(raw: string | undefined, reason: string): true {
  const key = `${IDENTITY_SWITCH_ON_AT_ENV}|${raw}|${reason}`;
  if (!warnedAboutBadTime.has(key)) {
    warnedAboutBadTime.add(key);
    logger.error(
      `[${IDENTITY_SWITCH_ON_AT_ENV} ${reason}] [VALUE ${raw}] [NOT SWITCHING ON, WRITES FROZEN]`
    );
  }
  return true;
}

/** From switch-on the 6529 chain holds identities for good. */
export function isIdentityOnChain(
  nowMillis: number = Time.currentMillis()
): boolean {
  return (
    appFeatures.isIdentityOnChain() ||
    (!switchOnTimeMalformed() &&
      timeHasCome(IDENTITY_SWITCH_ON_AT_ENV, nowMillis, 'not_come'))
  );
}

/** Identity writes are refused: frozen, or on the chain since switch-on. */
export function isIdentityFrozen(
  nowMillis: number = Time.currentMillis()
): boolean {
  return (
    appFeatures.isIdentityFrozen() ||
    timeHasCome(IDENTITY_FREEZE_AT_ENV, nowMillis, 'come') ||
    // A switch-on time that can't be read doesn't switch on, but it does
    // freeze: whoever set it meant identity writes to stop.
    switchOnTimeMalformed() ||
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
