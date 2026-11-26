import { Logger } from '@/logging';
import { ChainGatewayError } from './chain-gateway.client';

/**
 * A 6529 chain gateway on a release without the waves routes answers GET
 * /v1/waves/import with 404 "no such route", which the client gives as
 * not_held. Before the waves switch-on that is "not yet": nothing needs the
 * waves on the chain yet, and a unit that reads them waits, with one
 * warning a process. From the switch-on (WAVES_SWITCH_ON_AT has come, or
 * FEATURE_WAVES_ON_CHAIN is true), read on each call, it is an error again,
 * as every other gateway failure always is.
 */

export const WAVES_IMPORT_PATH = '/v1/waves/import';

/** Whether this is the gateway's "no such route" for /v1/waves/import. */
export function isWavesImportRouteMissing(error: unknown): boolean {
  return (
    error instanceof ChainGatewayError &&
    error.code === 'not_held' &&
    (error.path === WAVES_IMPORT_PATH ||
      error.path.startsWith(`${WAVES_IMPORT_PATH}?`)) &&
    /not_held: no such route/i.test(error.message)
  );
}

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;
const END_OF_DAY = /T24:00(?::00(?:\.0{1,3})?)?(?:Z|[+-]00:00)$/;
const EARLIEST_MS = Date.UTC(2020, 0, 1);
const LATEST_MS = Date.UTC(2100, 0, 1);
const isTime = (millis: number) =>
  Number.isFinite(millis) && millis >= EARLIEST_MS && millis < LATEST_MS;

/**
 * WAVES_SWITCH_ON_AT as the waves freeze reads it (ISO 8601 UTC, or Unix
 * milliseconds, from 2020 to 2099; 24:00 is the next day's 00:00; a day
 * that doesn't exist is no time): `undefined` when unset, `null` when it is
 * not such a time.
 */
function parseSwitchOnAt(raw: string | undefined): number | null | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d{1,16}$/.test(value)) {
    const millis = Number(value);
    return isTime(millis) ? millis : null;
  }
  if (!ISO_UTC.test(value)) return null;
  const millis = Date.parse(value);
  const day = value.slice(0, 10);
  const [year, month, date] = day.split('-').map(Number);
  if (
    !isTime(millis) ||
    new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== day
  ) {
    return null;
  }
  if (END_OF_DAY.test(value)) return millis;
  return new Date(millis).toISOString().slice(0, 10) === day ? millis : null;
}

/**
 * Whether waves have switched on: FEATURE_WAVES_ON_CHAIN is `true`, or the
 * time in WAVES_SWITCH_ON_AT has come. A time that can't be read doesn't
 * switch on (the waves freeze logs it).
 */
export function wavesSwitchedOnAt(
  nowMillis: number,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  if (env.FEATURE_WAVES_ON_CHAIN === 'true') return true;
  const at = parseSwitchOnAt(env.WAVES_SWITCH_ON_AT);
  return typeof at === 'number' && nowMillis >= at;
}

/**
 * One unit's handling of a gateway without /v1/waves/import. `waits` says
 * whether to wait quietly (before the switch-on: true, with one warning a
 * process) or to fail as for any gateway error (from the switch-on: false).
 */
export class WavesImportRouteWait {
  private warned = false;

  constructor(
    private readonly logger: Logger,
    private readonly unit: string
  ) {}

  waits(
    nowMillis: number,
    env: Readonly<Record<string, string | undefined>> = process.env
  ): boolean {
    if (wavesSwitchedOnAt(nowMillis, env)) return false;
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        `[${this.unit} WAITS] [THE CHAIN GATEWAY HAS NO ${WAVES_IMPORT_PATH}] [BEFORE THE SWITCH-ON] it needs a release with the waves routes; this is an error from the switch-on`
      );
    }
    return true;
  }
}
