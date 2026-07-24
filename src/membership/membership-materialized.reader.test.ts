import { MembershipMaterializedReader } from './membership-materialized.reader';
import { SqlExecutor } from '@/sql-executor';

function buildReader(rows: unknown[] | Error) {
  const execute =
    rows instanceof Error
      ? jest.fn().mockRejectedValue(rows)
      : jest.fn().mockResolvedValue(rows);
  const reader = new MembershipMaterializedReader(
    () => ({ execute }) as unknown as SqlExecutor
  );
  return { execute, reader };
}

describe('MembershipMaterializedReader', () => {
  const originalReadMode = process.env.ELIGIBILITY_READ_MODE;

  beforeEach(() => {
    process.env.ELIGIBILITY_READ_MODE = 'materialized';
  });

  afterAll(() => {
    if (originalReadMode === undefined) {
      delete process.env.ELIGIBILITY_READ_MODE;
    } else {
      process.env.ELIGIBILITY_READ_MODE = originalReadMode;
    }
  });

  it('returns null when the materialization is not authoritative', async () => {
    const { reader } = buildReader([{ ready: 0, group_id: null }]);
    await expect(
      reader.getEligibleGroupIdsIfReady('profile-1')
    ).resolves.toBeNull();
  });

  it('distinguishes an authoritative empty result from fallback', async () => {
    const { reader } = buildReader([{ ready: 1, group_id: null }]);
    await expect(
      reader.getEligibleGroupIdsIfReady('profile-1')
    ).resolves.toEqual([]);
  });

  it('returns sorted materialized group ids', async () => {
    const { reader } = buildReader([
      { ready: 1, group_id: 'group-a' },
      { ready: 1, group_id: 'group-b' }
    ]);
    await expect(
      reader.getEligibleGroupIdsIfReady('profile-1')
    ).resolves.toEqual(['group-a', 'group-b']);
  });

  it('falls back when the primary database read fails', async () => {
    const { reader } = buildReader(new Error('database unavailable'));
    await expect(
      reader.getEligibleGroupIdsIfReady('profile-1')
    ).resolves.toBeNull();
  });

  it('does not query materialization tables in legacy mode', async () => {
    process.env.ELIGIBILITY_READ_MODE = 'legacy';
    const { execute, reader } = buildReader([]);
    await expect(
      reader.getEligibleGroupIdsIfReady('profile-1')
    ).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
