import { setSqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { CURRENT_EULA_VERSION, EULA_VALIDITY_MS } from './eula-policy';
import {
  deleteOwnedEULAConsent,
  fetchEULAConsent,
  saveEULAConsent
} from './policies.db';

const NOW = 1_777_000_000_000;

function createSqlExecutor() {
  const executor = {
    execute: jest.fn().mockResolvedValue([]),
    oneOrNull: jest.fn()
  };
  setSqlExecutor(executor as any);
  return executor;
}

describe('EULA policy persistence', () => {
  beforeEach(() => {
    jest.spyOn(Time, 'now').mockReturnValue({
      toMillis: () => NOW
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists the accepted EULA version and acceptance time', async () => {
    const executor = createSqlExecutor();

    await saveEULAConsent('device-1', 'ios', CURRENT_EULA_VERSION);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(
        '(device_id, platform, accepted_at, eula_version, profile_id)'
      ),
      {
        deviceId: 'device-1',
        platform: 'ios',
        acceptedAt: NOW,
        eulaVersion: CURRENT_EULA_VERSION,
        profileId: null
      }
    );
    expect(executor.execute.mock.calls[0]![0]).toContain(
      'eula_version = :eulaVersion'
    );
  });

  it('records the owner on insert and never updates it on re-save', async () => {
    const executor = createSqlExecutor();

    await saveEULAConsent('device-1', 'ios', CURRENT_EULA_VERSION, 'profile-1');

    const [sql, params] = executor.execute.mock.calls[0]!;
    expect(params).toEqual(expect.objectContaining({ profileId: 'profile-1' }));
    expect(sql).toContain(
      'VALUES (:deviceId, :platform, :acceptedAt, :eulaVersion, :profileId)'
    );
    const updateClause = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
    expect(updateClause).toContain('accepted_at = :acceptedAt');
    expect(updateClause).not.toContain('profile_id');
  });

  it('deletes only a record owned by the given profile in one statement', async () => {
    const executor = createSqlExecutor();

    await deleteOwnedEULAConsent('device-1', 'profile-1');

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.oneOrNull).not.toHaveBeenCalled();
    const [sql, params] = executor.execute.mock.calls[0]!;
    expect(sql).toMatch(/^DELETE FROM/);
    expect(sql).toContain('device_id = :deviceId');
    expect(sql).toContain('AND profile_id = :profileId');
    expect(params).toEqual({ deviceId: 'device-1', profileId: 'profile-1' });
  });

  it('never selects the owner when reading consent', async () => {
    const executor = createSqlExecutor();
    executor.oneOrNull.mockResolvedValue(null);

    await fetchEULAConsent('device-1', NOW);

    expect(executor.oneOrNull.mock.calls[0]![0]).not.toContain('profile_id');
  });

  it('retrieves only current, unexpired acceptances', async () => {
    const executor = createSqlExecutor();
    const currentConsent = {
      device_id: 'device-1',
      platform: 'ios',
      accepted_at: NOW - 1_000,
      eula_version: CURRENT_EULA_VERSION
    };
    executor.oneOrNull.mockResolvedValue(currentConsent);

    await expect(fetchEULAConsent('device-1', NOW)).resolves.toEqual(
      currentConsent
    );

    const [sql, params] = executor.oneOrNull.mock.calls[0]!;
    expect(sql).toContain('eula_version = :eulaVersion');
    expect(sql).toContain('accepted_at >= :validAfter');
    expect(params).toEqual({
      deviceId: 'device-1',
      eulaVersion: CURRENT_EULA_VERSION,
      validAfter: NOW - EULA_VALIDITY_MS
    });
  });

  it('returns no consent when the current-version and validity filter misses', async () => {
    const executor = createSqlExecutor();
    executor.oneOrNull.mockResolvedValue(null);

    await expect(fetchEULAConsent('stale-device', NOW)).resolves.toBeNull();
  });
});
