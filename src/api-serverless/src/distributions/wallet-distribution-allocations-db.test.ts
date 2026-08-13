import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { Timer } from '@/time';
import { WalletDistributionAllocationsDb } from './wallet-distribution-allocations.db';

describe('WalletDistributionAllocationsDb', () => {
  it('returns phase and Public allocations when distribution is published', async () => {
    const oneOrNull = jest
      .fn()
      .mockResolvedValueOnce({ has_distribution: 1 })
      .mockResolvedValueOnce({ spots_airdrop: '2' });
    const execute = jest
      .fn()
      .mockResolvedValue([
        { phase: 'Phase 0', spots_airdrop: '11', spots_allowlist: 0 }
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
        { phase: 'Phase 0', spots_airdrop: '11', spots_allowlist: 0 }
      ],
      publicAirdropCount: 2
    });

    expect(oneOrNull.mock.calls[0][0]).toContain(
      `FROM ${DISTRIBUTION_NORMALIZED_TABLE}`
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining(`FROM ${DISTRIBUTION_TABLE}`),
      {
        contract: '0xcontract',
        cardId: 534,
        wallet: '0xwallet',
        phases: ['Phase 0', 'Phase 1', 'Phase 2']
      },
      undefined
    );
    expect(oneOrNull.mock.calls[1][0]).toContain(
      `FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`
    );
    expect(oneOrNull.mock.calls[1][0]).toContain('phase = :publicPhase');
    expect(timerStart).toHaveBeenCalledWith(
      'WalletDistributionAllocationsDb->findByWallet'
    );
    expect(timerStop).toHaveBeenCalledWith(
      'WalletDistributionAllocationsDb->findByWallet'
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
