import {
  E2EE_CIPHERSUITE_AES128,
  E2EE_CIPHERSUITES
} from '@/e2ee/e2ee.constants';
import { Logger } from '@/logging';

// Which MLS ciphersuites a device may use (D172). A device's grant names
// its suites: a v1 grant one `ciphersuite`, a v2 grant a set `ciphersuites`
// (P35 section 2.3 `MlsDevice.suites`, at most 4). A device may join a
// group, upload KeyPackages for it and be listed for it only when the
// group's suite is in the device's effective set:
//
//   v1: {0x004F} while the transition window is open, else nothing;
//   v2: (signed set ∩ accepted suites) ∪ aliases of the signed set, where
//       the accepted suites are {0x004F, 0x004E} while the window is open
//       and {0x004E} afterwards.
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

/** A malformed transition setting (see `currentE2eeSuiteTransition`). */
export class E2eeSuiteTransitionConfigError extends Error {
  constructor(name: string, value: string, expected: string) {
    super(`${name}=${JSON.stringify(value)} is not ${expected}`);
    this.name = 'E2eeSuiteTransitionConfigError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const START_ENV = 'E2EE_SUITE_TRANSITION_START';
const DAYS_ENV = 'E2EE_SUITE_TRANSITION_DAYS';
/**
 * Unix milliseconds must fall in this range. It rejects seconds (which
 * would read as January 1970 and close the window at once) and typos.
 */
const MIN_START_MS = Date.UTC(2026, 0, 1);
const MAX_START_MS = Date.UTC(2100, 0, 1);
const MAX_TRANSITION_DAYS = 365;
/** ISO 8601 with a time and an explicit zone, e.g. 2026-11-20T00:00:00Z. */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_FIELDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;
const NOT_STARTED: E2eeSuiteTransition = {
  startMs: null,
  days: DEFAULT_TRANSITION_DAYS
};

/**
 * Whether the date and time fields exist on the calendar: Date.parse rolls
 * 2026-11-31 over to 2026-12-01 instead of refusing it.
 */
function isCalendarInstant(text: string): boolean {
  const fields = ISO_FIELDS.exec(text);
  if (!fields) return false;
  const [year, month, day, hour, minute, second] = fields
    .slice(1)
    .map((field) => Number(field ?? 0));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function startMsOf(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  return ISO_INSTANT.test(text) && isCalendarInstant(text)
    ? Date.parse(text)
    : Number.NaN;
}

function parseStart(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const ms = startMsOf(text);
  if (!Number.isFinite(ms) || ms < MIN_START_MS || ms >= MAX_START_MS) {
    throw new E2eeSuiteTransitionConfigError(
      START_ENV,
      text,
      'an ISO 8601 date-time with a zone or unix milliseconds from 2026 on'
    );
  }
  return ms;
}

function parseDays(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return DEFAULT_TRANSITION_DAYS;
  const days = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!(days >= 1 && days <= MAX_TRANSITION_DAYS)) {
    throw new E2eeSuiteTransitionConfigError(
      DAYS_ENV,
      text,
      `a whole number of days from 1 to ${MAX_TRANSITION_DAYS}`
    );
  }
  return days;
}

/**
 * `E2EE_SUITE_TRANSITION_START`: when clients started moving off 0x004F,
 * as an ISO 8601 date-time with a zone (a real calendar date) or unix
 * milliseconds (not seconds); unset means not started.
 * `E2EE_SUITE_TRANSITION_DAYS`: whole days (1-365, default 14) after the
 * start during which the server still accepts 0x004F. Strict: anything else
 * throws E2eeSuiteTransitionConfigError. The policy reads it through
 * `currentE2eeSuiteTransition`, which falls back to "not started".
 */
export function readE2eeSuiteTransition(
  env: Env = process.env
): E2eeSuiteTransition {
  return {
    startMs: parseStart(env[START_ENV]),
    days: parseDays(env[DAYS_ENV])
  };
}

const logger = Logger.get('E2EE_SUITE_POLICY');
const reportedConfigErrors = new Set<string>();

/**
 * A malformed setting, once per process and value: an ERROR log and an EMF
 * metric (`6529/E2EE` `SuiteWindowConfigInvalid`) to alarm on.
 */
function reportConfigError(error: E2eeSuiteTransitionConfigError): void {
  if (reportedConfigErrors.has(error.message)) return;
  reportedConfigErrors.add(error.message);
  logger.error(
    `[E2EE SUITE WINDOW CONFIG INVALID] ${error.message} [USING NOT STARTED]`
  );
  try {
    process.stdout.write(
      `${JSON.stringify({
        _type: '6529.e2ee_suite_window_config.v1',
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/E2EE',
              Dimensions: [[]],
              Metrics: [{ Name: 'SuiteWindowConfigInvalid', Unit: 'Count' }]
            }
          ]
        },
        SuiteWindowConfigInvalid: 1
      })}\n`
    );
  } catch {
    // Telemetry must never change a request.
  }
}

/**
 * The window the policy applies. A malformed setting fails safe: it is
 * reported (`reportConfigError`) and the policy behaves exactly as if
 * `E2EE_SUITE_TRANSITION_START` were unset (v1 grants honoured, both
 * suites accepted). Nothing else in the API is affected.
 */
export function currentE2eeSuiteTransition(
  env: Env = process.env
): E2eeSuiteTransition {
  try {
    return readE2eeSuiteTransition(env);
  } catch (error) {
    if (!(error instanceof E2eeSuiteTransitionConfigError)) throw error;
    reportConfigError(error);
    return NOT_STARTED;
  }
}

/** When 0x004F stops being accepted (unix ms), or null while not started. */
export function e2eeV1WindowEndMs(
  transition: E2eeSuiteTransition
): number | null {
  return transition.startMs === null
    ? null
    : transition.startMs + transition.days * DAY_MS;
}

/**
 * The effective window for the start-up log (never throws; a malformed
 * setting is reported and described as not started).
 */
export function describeE2eeSuiteTransition(env: Env = process.env): string {
  const transition = currentE2eeSuiteTransition(env);
  const end = e2eeV1WindowEndMs(transition);
  return transition.startMs === null || end === null
    ? '[E2EE SUITE WINDOW NOT STARTED] [BOTH SUITES ACCEPTED]'
    : `[E2EE SUITE WINDOW START ${new Date(transition.startMs).toISOString()}] ` +
        `[END ${new Date(end).toISOString()}] [DAYS ${transition.days}]`;
}

/**
 * Whether the transition window is still open at `nowMs`: v1 grants are
 * honoured and 0x004F is accepted (D172). Afterwards only 0x004E is.
 */
export function isE2eeV1GrantAccepted(
  nowMs: number,
  transition: E2eeSuiteTransition = currentE2eeSuiteTransition()
): boolean {
  const end = e2eeV1WindowEndMs(transition);
  return end === null || nowMs < end;
}

/**
 * The suites the server accepts at `nowMs` (D172): 0x004F and 0x004E while
 * the transition window is open, then 0x004E only, for every grant form,
 * registrations, KeyPackages, listings, eligibility, claims and roster
 * checks. Reads (logs, Welcomes, blobs) do not consult it.
 */
export function e2eeAcceptedSuites(
  nowMs: number,
  transition?: E2eeSuiteTransition
): number[] {
  return isE2eeV1GrantAccepted(nowMs, transition)
    ? [...E2EE_CIPHERSUITES]
    : E2EE_CIPHERSUITES.filter((suite) => suite !== E2EE_CIPHERSUITE_AES128);
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
 * open; after it a v2 set counts only for 0x004E.
 */
export function e2eeDeviceSuites(
  grant: E2eeSuiteGrantFields,
  nowMs: number,
  options: E2eeSuitePolicyOptions = {}
): number[] {
  const accepted =
    options.accepted ?? e2eeAcceptedSuites(nowMs, options.transition);
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
