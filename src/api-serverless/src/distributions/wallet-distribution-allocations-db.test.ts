import {
  DISTRIBUTION_NORMALIZED_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { Timer } from '@/time';
import { WalletDistributionAllocationsDb } from './wallet-distribution-allocations.db';

describe('WalletDistributionAllocationsDb', () => {
  it('returns phase and Public allocations when distribution is published', async () => {
    const oneOrNull = jest
      .fn()
      .mockResolvedValueOnce({ has_distribution: 1 })
      .mockResolvedValueOnce({
        allowlist: JSON.stringify([
          { phase: 'P0', spots: 3, spots_airdrop: 3, spots_allowlist: 0 },
          { phase: 'Phase0', spots: 4, spots_airdrop: 4, spots_allowlist: 0 },
          { phase: 'PHASE 0', spots: 4, spots_airdrop: 4, spots_allowlist: 0 },
          { phase: 'p1', spots: 2, spots_airdrop: 0, spots_allowlist: 2 },
          { phase: 'Phase 2', spots: 2, spots_airdrop: 1, spots_allowlist: 1 },
          { phase: 'Phase3', spots: 18, spots_airdrop: 9, spots_allowlist: 9 },
          { phase: 'Airdrop', spots: 9, spots_airdrop: 9, spots_allowlist: 0 }
        ])
      });
    const execute = jest
      .fn()
      .mockResolvedValue([
        { subscribed_count: '3' },
        { subscribed_count: 2 },
        { subscribed_count: 0 },
        { subscribed_count: null }
      ]);
    const db = new WalletDistributionAllocationsDb(
      () => ({ oneOrNull, execute }) as any
    );
    const timer = new Timer('test');
    const timerStart = jest.spyOn(timer, 'start');
    const timerStop = jest.spyOn(timer, 'stop');

    await expect(
      db.findByWallet('0xcontract', 534, '0xwallet', { timer })
    ).resolves.toEqual({
      hasDistribution: true,
      phaseAllocations: [
        { phase: 'Phase 0', spots_airdrop: 11, spots_allowlist: 0 },
        { phase: 'Phase 1', spots_airdrop: 0, spots_allowlist: 2 },
        { phase: 'Phase 2', spots_airdrop: 1, spots_allowlist: 1 }
      ],
      publicAirdropCount: 5
    });

    expect(oneOrNull.mock.calls[0][0]).toContain(
      `FROM ${DISTRIBUTION_NORMALIZED_TABLE}`
    );
    expect(oneOrNull).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(`FROM ${DISTRIBUTION_NORMALIZED_TABLE}`),
      {
        contract: '0xcontract',
        cardId: 534,
        wallet: '0xwallet'
      },
      undefined
    );
    expect(execute.mock.calls[0][0]).toContain(
      `FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`
    );
    expect(execute.mock.calls[0][0]).toContain('phase = :publicPhase');
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      {
        contract: '0xcontract',
        cardId: 534,
        wallet: '0xwallet',
        publicPhase: 'Public'
      },
      undefined
    );
    expect(timerStart).toHaveBeenCalledWith(
      'WalletDistributionAllocationsDb->findByWallet'
    );
    expect(timerStop).toHaveBeenCalledWith(
      'WalletDistributionAllocationsDb->findByWallet'
    );
  });

  it('normalizes mixed-case addresses before querying', async () => {
    const oneOrNull = jest
      .fn()
      .mockResolvedValueOnce({ has_distribution: 1 })
      .mockResolvedValueOnce({ allowlist: [] });
    const execute = jest.fn().mockResolvedValue([]);
    const db = new WalletDistributionAllocationsDb(
      () => ({ oneOrNull, execute }) as any
    );

    await db.findByWallet('0xConTrAcT', 534, '0xWaLlEt', {});

    expect(oneOrNull.mock.calls[0][1]).toEqual({
      contract: '0xcontract',
      cardId: 534
    });
    expect(execute.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        contract: '0xcontract',
        wallet: '0xwallet'
      })
    );
  });

  it('does not query wallet allocations before distribution is published', async () => {
    const oneOrNull = jest.fn().mockResolvedValue({ has_distribution: 0 });
    const execute = jest.fn();
    const db = new WalletDistributionAllocationsDb(
      () => ({ oneOrNull, execute }) as any
    );

    await expect(
      db.findByWallet('0xcontract', 534, '0xwallet', {})
    ).resolves.toEqual({
      hasDistribution: false,
      phaseAllocations: [],
      publicAirdropCount: 0
    });
    expect(oneOrNull).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});
