import {
  E2EE_CIPHERSUITE_AES128,
  E2EE_CIPHERSUITES
} from '@/e2ee/e2ee.constants';

// Which MLS ciphersuites a device may use (D172). A device's grant names
// its suites: a v1 grant one `ciphersuite`, a v2 grant a set `ciphersuites`
// (P35 section 2.3 `MlsDevice.suites`, at most 4). A device may join a
// group, upload KeyPackages for it and be listed for it only when the
// group's suite is in the device's effective set:
//
//   v1: {0x004F} while the transition window is open, else nothing;
//   v2: (signed set ∩ accepted suites) ∪ aliases of the signed set.
//
// A signed set may name suites the server does not accept yet; they grant
// nothing until the server accepts them, and then need no new signature.

type Env = Readonly<Record<string, string | undefined>>;

/** At most this many suites in a v2 grant (P35 `MlsDevice.suites`). */
export const E2EE_GRANT_MAX_SUITES = 4;

/** The only suite a v1 grant (one `ciphersuite`) is honoured for. */
export const E2EE_V1_GRANT_SUITE = E2EE_CIPHERSUITE_AES128;

const MAX_UINT16 = 0xffff;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TRANSITION_DAYS = 14;

/** A grant naming `from` also admits `to` (both code points). */
export interface E2eeSuiteAlias {
  readonly from: number;
  readonly to: number;
}

/**
 * Whether a grant naming a provisional code point also covers the code point
 * the RFC assigns to the same algorithms is an owner decision (D172, open).
 * Empty until decided; a yes is one entry here, e.g. `{ from: 0x004e, to: <final> }`
 * (plus `<final>` in E2EE_CIPHERSUITES once clients use it).
 */
export const E2EE_SUITE_ALIASES: readonly E2eeSuiteAlias[] = [];

/** 1 to 4 code points (1-65535), strictly ascending: one encoding per set. */
export function isCanonicalE2eeSuiteSet(
  value: unknown
): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  if (value.length < 1 || value.length > E2EE_GRANT_MAX_SUITES) return false;
  let previous = 0;
  for (const suite of value) {
    if (
      typeof suite !== 'number' ||
      !Number.isInteger(suite) ||
      suite <= previous ||
      suite > MAX_UINT16
    ) {
      return false;
    }
    previous = suite;
  }
  return true;
}

/** The stored form of a canonical set: decimal codes joined by ".". */
export function encodeE2eeSuiteSet(suites: readonly number[]): string {
  return suites.join('.');
}

/** A stored set back as numbers; null unless it is canonical. */
export function decodeE2eeSuiteSet(
  text: string | null | undefined
): number[] | null {
  if (!text || !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(text)) return null;
  const suites = text.split('.').map(Number);
  return isCanonicalE2eeSuiteSet(suites) ? suites : null;
}

export interface E2eeSuiteTransition {
  /** When clients started moving off 0x004F (unix ms); null: not started. */
  readonly startMs: number | null;
  /** How long v1 grants stay honoured after `startMs`. */
  readonly days: number;
}

function parseInstant(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function parseDays(value: string | undefined): number {
  const text = value?.trim();
  if (!text || !/^\d+$/.test(text)) return DEFAULT_TRANSITION_DAYS;
  return Number(text);
}

/**
 * `E2EE_SUITE_TRANSITION_START`: an ISO date-time or unix milliseconds;
 * unset (or unreadable) means the transition has not started and v1 grants
 * are honoured until further notice. `E2EE_SUITE_TRANSITION_DAYS`: whole
 * days (default 14) after the start during which v1 grants stay honoured.
 */
export function readE2eeSuiteTransition(
  env: Env = process.env
): E2eeSuiteTransition {
  return {
    startMs: parseInstant(env.E2EE_SUITE_TRANSITION_START),
    days: parseDays(env.E2EE_SUITE_TRANSITION_DAYS)
  };
}

/** Whether v1 grants (0x004F only) are still honoured at `nowMs`. */
export function isE2eeV1GrantAccepted(
  nowMs: number,
  transition: E2eeSuiteTransition = readE2eeSuiteTransition()
): boolean {
  return (
    transition.startMs === null ||
    nowMs < transition.startMs + transition.days * DAY_MS
  );
}

/** What a device row (or a grant) says about its suites. */
export interface E2eeSuiteGrantFields {
  /** 1 (or null, rows written before versions) or 2. */
  readonly grant_version?: number | null;
  /** v1: the suite; v2: the lowest of the set. */
  readonly ciphersuite: number;
  /** v2: the set, as stored ("78.79") or as numbers. */
  readonly ciphersuites?: string | readonly number[] | null;
}

export interface E2eeSuitePolicyOptions {
  readonly transition?: E2eeSuiteTransition;
  readonly accepted?: readonly number[];
  readonly aliases?: readonly E2eeSuiteAlias[];
}

function signedSuites(grant: E2eeSuiteGrantFields): readonly number[] {
  if (Number(grant.grant_version ?? 1) !== 2) {
    return [Number(grant.ciphersuite)];
  }
  const set = grant.ciphersuites;
  if (typeof set === 'string' || set === null || set === undefined) {
    return decodeE2eeSuiteSet(set) ?? [];
  }
  return isCanonicalE2eeSuiteSet(set) ? set : [];
}

/**
 * The suites a device may use now, ascending: see the module comment. A v1
 * grant counts only for 0x004F, and only while the transition window is
 * open.
 */
export function e2eeDeviceSuites(
  grant: E2eeSuiteGrantFields,
  nowMs: number,
  options: E2eeSuitePolicyOptions = {}
): number[] {
  const accepted = options.accepted ?? E2EE_CIPHERSUITES;
  const aliases = options.aliases ?? E2EE_SUITE_ALIASES;
  if (Number(grant.grant_version ?? 1) !== 2) {
    const suite = Number(grant.ciphersuite);
    return suite === E2EE_V1_GRANT_SUITE &&
      accepted.includes(suite) &&
      isE2eeV1GrantAccepted(nowMs, options.transition)
      ? [suite]
      : [];
  }
  const signed = signedSuites(grant);
  const effective = new Set(signed.filter((suite) => accepted.includes(suite)));
  for (const alias of aliases) {
    if (signed.includes(alias.from) && accepted.includes(alias.to)) {
      effective.add(alias.to);
    }
  }
  return Array.from(effective).sort((a, b) => a - b);
}

/** Whether a device may join (and be offered for) groups of `groupSuite`. */
export function canE2eeDeviceJoin(
  grant: E2eeSuiteGrantFields,
  groupSuite: number,
  nowMs: number,
  options: E2eeSuitePolicyOptions = {}
): boolean {
  return e2eeDeviceSuites(grant, nowMs, options).includes(groupSuite);
}
