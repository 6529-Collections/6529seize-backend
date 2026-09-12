import { DISTRIBUTION_PHASE_AIRDROP_TEAM } from '@/airdrop-phases';
import { DISTRIBUTION_NORMALIZED_TABLE } from '@/constants';
import { Distribution } from '@/entities/IDistribution';
import { sqlExecutor } from '@/sql-executor';
import { populateDistributionNormalized } from './api.distributions.service';
import { WalletDistributionAllocationsDb } from './wallet-distribution-allocations.db';

describe('wallet distribution normalization contract', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serializes wallet-scoped allowlists consumed by the allocation endpoint', async () => {
    const execute = jest.spyOn(sqlExecutor, 'execute');
    const executeNativeQueriesInTransaction = jest.spyOn(
      sqlExecutor,
      'executeNativeQueriesInTransaction'
    );
    const distributions = [
      {
        wallet: '0xAaA',
        phase: 'P0',
        count: 3,
        count_airdrop: 3,
        count_allowlist: 0
      },
      {
        wallet: '0xAAA',
        phase: 'Phase 0',
        count: 4,
        count_airdrop: 0,
        count_allowlist: 4
      },
      {
        wallet: '0xaaa',
        phase: DISTRIBUTION_PHASE_AIRDROP_TEAM,
        count: 2,
        count_airdrop: 2,
        count_allowlist: 0
      },
      {
        wallet: '0xBbB',
        phase: 'Phase 1',
        count: 5,
        count_airdrop: 0,
        count_allowlist: 5
      }
    ] as Distribution[];

    execute
      .mockResolvedValueOnce(distributions)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { name: 'Test card', mint_date: new Date('2026-08-13T00:00:00Z') }
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    executeNativeQueriesInTransaction.mockImplementation(async (callback) =>
      callback({} as never)
    );

    await populateDistributionNormalized('0xContract', 534);

    const insertCall = execute.mock.calls.find(([query]) =>
      String(query).includes(`INSERT INTO ${DISTRIBUTION_NORMALIZED_TABLE}`)
    );
    expect(insertCall).toBeDefined();
    const params = insertCall?.[1] as Record<string, unknown>;
    const walletAIndex = params.wallet_0 === '0xaaa' ? 0 : 1;
    const walletBIndex = walletAIndex === 0 ? 1 : 0;
    const walletAAllowlist = params[`allowlist_${walletAIndex}`] as string;

    expect(params[`wallet_${walletAIndex}`]).toBe('0xaaa');
    expect(params[`contract_${walletAIndex}`]).toBe('0xcontract');
    expect(params[`airdrops_${walletAIndex}`]).toBe(2);
    expect(JSON.parse(walletAAllowlist)).toEqual([
      { phase: 'P0', spots: 3, spots_airdrop: 3, spots_allowlist: 0 },
      {
        phase: 'Phase 0',
        spots: 4,
        spots_airdrop: 0,
        spots_allowlist: 4
      }
    ]);
    expect(params[`wallet_${walletBIndex}`]).toBe('0xbbb');
    expect(params[`contract_${walletBIndex}`]).toBe('0xcontract');
    expect(JSON.parse(params[`allowlist_${walletBIndex}`] as string)).toEqual([
      {
        phase: 'Phase 1',
        spots: 5,
        spots_airdrop: 0,
        spots_allowlist: 5
      }
    ]);

    const oneOrNull = jest
      .fn()
      .mockResolvedValueOnce({ has_distribution: 1 })
      .mockResolvedValueOnce({ allowlist: walletAAllowlist });
    const publicExecute = jest.fn().mockResolvedValue([]);
    const allocationsDb = new WalletDistributionAllocationsDb(
      () => ({ oneOrNull, execute: publicExecute }) as any
    );

    await expect(
      allocationsDb.findByWallet('0xContract', 534, '0xAaA', {})
    ).resolves.toEqual({
      hasDistribution: true,
      phaseAllocations: [
        { phase: 'Phase 0', spots_airdrop: 3, spots_allowlist: 4 }
      ],
      publicAirdropCount: 0
    });
  });
});
