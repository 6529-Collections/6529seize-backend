import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2EE_CIPHERSUITES } from '@/e2ee/e2ee.constants';
import {
  e2eeDeviceSuites,
  isE2eeV1GrantAccepted
} from '@/e2ee/e2ee-suite-policy';
import { Logger } from '@/logging';

// Upgrade numbers for the 0x004F -> 0x004E move (D172), so the owner can pick
// when the transition window ends: device registrations by grant version, and
// a census of active devices per usable suite. EMF lines on stdout (no
// CloudWatch API call or IAM change).

const NAMESPACE = '6529/E2EE';
const logger = Logger.get('E2EE_SUITE_METRICS');

/** At most one census per process in this interval. */
const CENSUS_INTERVAL_MS = 10 * 60 * 1000;
let lastCensusAt = 0;

function emit(line: Record<string, unknown>): void {
  try {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  } catch {
    // Telemetry must never change a request.
    logger.error('E2EE suite metric could not be emitted');
  }
}

/** One registered (or renewed) device, by grant version and how it came. */
export function recordE2eeDeviceRegistration(record: {
  readonly grantVersion: 1 | 2;
  readonly via: 'grant' | 'login_grant';
}): void {
  emit({
    _type: '6529.e2ee_device_registration.v1',
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [['GrantVersion'], ['GrantVersion', 'Via']],
          Metrics: [{ Name: 'DeviceRegistrations', Unit: 'Count' }]
        }
      ]
    },
    GrantVersion: String(record.grantVersion),
    Via: record.via,
    DeviceRegistrations: 1
  });
}

export interface E2eeSuiteCensus {
  /** Active devices that can join groups of each accepted suite. */
  readonly bySuite: Readonly<Record<string, number>>;
  /** Active devices by grant version. */
  readonly byGrantVersion: Readonly<Record<string, number>>;
  /** Active v1 devices no longer honoured (the window has closed). */
  readonly v1NotHonoured: number;
}

/** Counts active devices from the grouped census rows. */
export async function takeE2eeSuiteCensus(
  deps: Pick<E2eeServiceDeps, 'db' | 'now'>
): Promise<E2eeSuiteCensus> {
  const nowMs = deps.now();
  const rows = await deps.db.getActiveDeviceSuiteCensus(
    Math.floor(nowMs / 1000)
  );
  const bySuite: Record<string, number> = Object.fromEntries(
    E2EE_CIPHERSUITES.map((suite) => [String(suite), 0])
  );
  const byGrantVersion: Record<string, number> = { '1': 0, '2': 0 };
  const v1Open = isE2eeV1GrantAccepted(nowMs);
  let v1NotHonoured = 0;
  for (const row of rows) {
    const count = Number(row.cnt);
    const version = Number(row.grant_version ?? 1) === 2 ? '2' : '1';
    byGrantVersion[version] += count;
    if (version === '1' && !v1Open) v1NotHonoured += count;
    for (const suite of e2eeDeviceSuites(row, nowMs)) {
      bySuite[String(suite)] = (bySuite[String(suite)] ?? 0) + count;
    }
  }
  return { bySuite, byGrantVersion, v1NotHonoured };
}

/**
 * About once per CENSUS_INTERVAL_MS per process, on the opportunistic write
 * path: emits the census as EMF and, once the window has closed, logs how
 * many active v1 devices are no longer honoured.
 */
export async function maybeRecordE2eeSuiteCensus(
  deps: Pick<E2eeServiceDeps, 'db' | 'now'>
): Promise<void> {
  const nowMs = deps.now();
  if (nowMs - lastCensusAt < CENSUS_INTERVAL_MS) return;
  lastCensusAt = nowMs;
  try {
    const census = await takeE2eeSuiteCensus(deps);
    for (const [suite, count] of Object.entries(census.bySuite)) {
      emit({
        _type: '6529.e2ee_suite_census.v1',
        _aws: {
          Timestamp: nowMs,
          CloudWatchMetrics: [
            {
              Namespace: NAMESPACE,
              Dimensions: [['Suite']],
              Metrics: [{ Name: 'ActiveDevices', Unit: 'Count' }]
            }
          ]
        },
        Suite: suite,
        ActiveDevices: count
      });
    }
    for (const [version, count] of Object.entries(census.byGrantVersion)) {
      emit({
        _type: '6529.e2ee_grant_census.v1',
        _aws: {
          Timestamp: nowMs,
          CloudWatchMetrics: [
            {
              Namespace: NAMESPACE,
              Dimensions: [['GrantVersion']],
              Metrics: [{ Name: 'ActiveDevicesByGrant', Unit: 'Count' }]
            }
          ]
        },
        GrantVersion: version,
        ActiveDevicesByGrant: count
      });
    }
    if (census.v1NotHonoured > 0) {
      logger.info(
        `[E2EE SUITE WINDOW CLOSED] [V1 DEVICES NOT HONOURED ${census.v1NotHonoured}]`
      );
    }
  } catch (error) {
    logger.warn(
      `E2EE suite census failed: ${(error as Error)?.message ?? 'unknown'}`
    );
  }
}

/** Tests: forget the last census time. */
export function resetE2eeSuiteCensusClock(): void {
  lastCensusAt = 0;
}
