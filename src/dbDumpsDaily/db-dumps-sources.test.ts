import { planDumps } from './db-dumps-sources';

const NOW = Date.UTC(2026, 10, 25, 3, 0, 0);
const TABLES = ['transactions', 'delegations', 'consolidations'] as const;

/** Answers the planner's three reads; `mirror` undefined means no table. */
function query(mirror?: Record<string, unknown> | null) {
  return jest.fn(async (sql: string): Promise<any[]> => {
    if (sql.includes('identity_chain_mirror_state')) {
      if (mirror === undefined) {
        throw Object.assign(new Error('no table'), {
          code: 'ER_NO_SUCH_TABLE'
        });
      }
      return mirror ? [mirror] : [];
    }
    if (sql.includes('FROM transactions')) return [{ block: '23800000' }];
    if (sql.includes('FROM nftdelegation_blocks')) return [{ block: 23700000 }];
    throw new Error(`unexpected ${sql}`);
  });
}

describe('planDumps', () => {
  it('reads delegations and consolidations from NFTDelegation before the mirror exists', async () => {
    for (const mirror of [undefined, null]) {
      expect(await planDumps(query(mirror), TABLES, NOW)).toEqual([
        {
          table: 'transactions',
          source: { kind: 'ethereum', max_block: 23800000 }
        },
        {
          table: 'delegations',
          source: { kind: 'nftdelegation', last_block: 23700000 }
        },
        {
          table: 'consolidations',
          source: { kind: 'nftdelegation', last_block: 23700000 }
        }
      ]);
    }
  });

  it('reads them from the mirror once it has passed and keeps moving', async () => {
    const plans = await planDumps(
      query({
        next_height: '4521',
        sync_phase: null,
        updated_at: String(NOW - 60_000)
      }),
      TABLES,
      NOW
    );
    expect(plans[1]).toEqual({
      table: 'delegations',
      source: {
        kind: 'identity_chain_mirror',
        next_height: 4521,
        updated_at: NOW - 60_000
      }
    });
    expect(plans[2]).toMatchObject({ table: 'consolidations' });
  });

  it.each([
    [
      'before its first pass',
      { next_height: null, sync_phase: null, updated_at: NOW },
      'has not finished a full pass'
    ],
    [
      'part way through a full pass',
      { next_height: 4521, sync_phase: 'IDENTITIES', updated_at: NOW },
      'has not finished a full pass'
    ],
    [
      'after it stopped moving',
      { next_height: 4521, sync_phase: null, updated_at: NOW - 31 * 60_000 },
      'has not moved for 30 minutes'
    ]
  ])('skips them while the mirror is %s', async (_, mirror, reason) => {
    const plans = await planDumps(query(mirror), TABLES, NOW);
    expect(plans[0]).toMatchObject({ table: 'transactions' });
    expect(plans.slice(1)).toEqual([
      { table: 'delegations', skip: expect.stringContaining(reason) },
      { table: 'consolidations', skip: expect.stringContaining(reason) }
    ]);
  });

  it('refuses a table it has no source for', async () => {
    await expect(planDumps(query(null), ['drops'], NOW)).rejects.toThrow(
      'drops'
    );
  });
});
