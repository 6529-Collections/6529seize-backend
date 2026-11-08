import {
  maybeRecordE2eeSuiteCensus,
  recordE2eeDeviceRegistration,
  resetE2eeSuiteCensusClock,
  takeE2eeSuiteCensus
} from '@/api/e2ee/e2ee-suite-metrics';
import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';

// After a window that started on 2026-11-10 (14 days).
const NOW = Date.UTC(2026, 11, 1);
const DAY = 24 * 60 * 60 * 1000;

const rows = [
  { grant_version: 1, ciphersuite: 79, ciphersuites: null, cnt: 300 },
  { grant_version: 2, ciphersuite: 78, ciphersuites: '78', cnt: 40 },
  { grant_version: 2, ciphersuite: 78, ciphersuites: '78.4660', cnt: 2 }
];

const depsWith = (census = rows) =>
  ({
    now: () => NOW,
    db: { getActiveDeviceSuiteCensus: jest.fn(async () => census) }
  }) as unknown as Pick<E2eeServiceDeps, 'db' | 'now'>;

describe('E2EE suite metrics (D172)', () => {
  const previous = process.env.E2EE_SUITE_TRANSITION_START;
  let write: jest.SpyInstance;

  beforeEach(() => {
    resetE2eeSuiteCensusClock();
    write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    write.mockRestore();
    if (previous === undefined) delete process.env.E2EE_SUITE_TRANSITION_START;
    else process.env.E2EE_SUITE_TRANSITION_START = previous;
  });

  const lines = () =>
    write.mock.calls.map(([line]) => JSON.parse(String(line)));

  it('counts active devices per usable suite and per grant version', async () => {
    expect(await takeE2eeSuiteCensus(depsWith())).toEqual({
      bySuite: { '79': 300, '78': 42 },
      byGrantVersion: { '1': 300, '2': 42 },
      v1NotHonoured: 0
    });
  });

  it('counts v1 devices as unusable once the window has closed', async () => {
    process.env.E2EE_SUITE_TRANSITION_START = '2026-11-10T00:00:00Z';
    expect(await takeE2eeSuiteCensus(depsWith())).toEqual({
      bySuite: { '79': 0, '78': 42 },
      byGrantVersion: { '1': 300, '2': 42 },
      v1NotHonoured: 300
    });
  });

  it('emits the census as EMF at most once per interval', async () => {
    const deps = depsWith();
    await maybeRecordE2eeSuiteCensus(deps);
    await maybeRecordE2eeSuiteCensus(deps);
    expect(deps.db.getActiveDeviceSuiteCensus).toHaveBeenCalledTimes(1);
    const emitted = lines();
    expect(
      emitted
        .filter((line) => line._type === '6529.e2ee_suite_census.v1')
        .map((line) => [line.Suite, line.ActiveDevices])
    ).toEqual([
      ['78', 42],
      ['79', 300]
    ]);
    expect(emitted[0]._aws.CloudWatchMetrics[0].Namespace).toBe('6529/E2EE');
  });

  it('records a registration with its grant version', () => {
    recordE2eeDeviceRegistration({ grantVersion: 2, via: 'login_grant' });
    expect(lines()).toEqual([
      expect.objectContaining({
        _type: '6529.e2ee_device_registration.v1',
        GrantVersion: '2',
        Via: 'login_grant',
        DeviceRegistrations: 1
      })
    ]);
  });

  it('never throws when the census query fails', async () => {
    const deps = {
      now: () => NOW,
      db: {
        getActiveDeviceSuiteCensus: jest.fn(async () => {
          throw new Error('db down');
        })
      }
    } as unknown as Pick<E2eeServiceDeps, 'db' | 'now'>;
    await expect(maybeRecordE2eeSuiteCensus(deps)).resolves.toBeUndefined();
  });
});
