import {
  MembershipCriteriaDimension,
  MembershipRefreshProducer,
  MembershipRefreshReason
} from './membership-refresh.producer';
import { SqlExecutor } from '@/sql-executor';

function buildProducer(
  executeImplementation: (
    sql: string,
    params?: Record<string, unknown>
  ) => Promise<unknown[]> = async () => []
) {
  const execute = jest.fn(executeImplementation);
  const producer = new MembershipRefreshProducer(
    () => ({ execute }) as unknown as SqlExecutor
  );
  return { execute, producer };
}

describe('MembershipRefreshProducer', () => {
  it('deduplicates profile targets into one coalescing upsert', async () => {
    const { execute, producer } = buildProducer();
    await producer.markProfilesDirty(
      ['profile-1', 'profile-1', 'profile-2'],
      MembershipRefreshReason.RATING_CHANGED
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('on duplicate key update');
    expect(params).toMatchObject({
      scope: 'PROFILE',
      reason: 'RATING_CHANGED',
      targetId0: 'profile-1',
      targetId1: 'profile-2'
    });
  });

  it('maps changed wallets to profiles before marking them dirty', async () => {
    const { execute, producer } = buildProducer(async (sql) => {
      if (sql.includes('from address_consolidation_keys')) {
        return [{ profile_id: 'profile-1' }, { profile_id: 'profile-2' }];
      }
      return [];
    });

    await producer.markProfilesForWalletsDirty(
      ['0xABC', '0xabc'],
      MembershipRefreshReason.NFT_OWNERSHIP_CHANGED
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1]).toEqual({ wallets: ['0xabc'] });
    expect(execute.mock.calls[1][1]).toMatchObject({
      scope: 'PROFILE',
      targetId0: 'profile-1',
      targetId1: 'profile-2'
    });
  });

  it('limits dimension refreshes to wave-related groups', async () => {
    const { execute, producer } = buildProducer();
    await producer.markGroupsByDimensionDirty(
      MembershipCriteriaDimension.TDH_LEVEL,
      MembershipRefreshReason.TDH_XTDH_CHANGED
    );

    const sql = execute.mock.calls[0][0] as string;
    expect(sql).toContain('community_group.tdh_min is not null');
    expect(sql).toContain('from waves waves');
    expect(sql).toContain('from wave_curation_groups curations');
  });
});
