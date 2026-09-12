const mockFindByWallet = jest.fn();

jest.mock('./wallet-distribution-allocations.db', () => ({
  walletDistributionAllocationsDb: { findByWallet: mockFindByWallet }
}));

import { ApiWalletDistributionAllocationPhaseEnum } from '@/api/generated/models/ApiWalletDistributionAllocation';
import { getWalletDistributionAllocations } from './get-wallet-distribution-allocations.service';

describe('getWalletDistributionAllocations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only nonzero allocations in display order', async () => {
    mockFindByWallet.mockResolvedValue({
      hasDistribution: true,
      phaseAllocations: [
        { phase: 'Phase 2', spots_airdrop: 0, spots_allowlist: '1' },
        { phase: 'Phase 0', spots_airdrop: '11', spots_allowlist: 0 },
        { phase: 'Phase 1', spots_airdrop: 0, spots_allowlist: 0 },
        { phase: 'Automatic Airdrop', spots_airdrop: 99, spots_allowlist: 0 }
      ],
      publicAirdropCount: 2
    });

    await expect(
      getWalletDistributionAllocations('0xcontract', 534, '0xwallet', {})
    ).resolves.toEqual({
      has_distribution: true,
      allocations: [
        {
          phase: ApiWalletDistributionAllocationPhaseEnum.Phase0,
          spots_airdrop: 11,
          spots_allowlist: 0
        },
        {
          phase: ApiWalletDistributionAllocationPhaseEnum.Phase2,
          spots_airdrop: 0,
          spots_allowlist: 1
        },
        {
          phase: ApiWalletDistributionAllocationPhaseEnum.Public,
          spots_airdrop: 2,
          spots_allowlist: 0
        }
      ]
    });
  });

  it('derives Public only from finalized subscription allocations', async () => {
    mockFindByWallet.mockResolvedValue({
      hasDistribution: true,
      phaseAllocations: [
        { phase: 'Public', spots_airdrop: 50, spots_allowlist: 50 }
      ],
      publicAirdropCount: 2
    });

    await expect(
      getWalletDistributionAllocations('0xcontract', 534, '0xwallet', {})
    ).resolves.toEqual({
      has_distribution: true,
      allocations: [
        {
          phase: ApiWalletDistributionAllocationPhaseEnum.Public,
          spots_airdrop: 2,
          spots_allowlist: 0
        }
      ]
    });
  });

  it('distinguishes unpublished distribution from a published empty allocation', async () => {
    mockFindByWallet.mockResolvedValue({
      hasDistribution: false,
      phaseAllocations: [],
      publicAirdropCount: 0
    });

    await expect(
      getWalletDistributionAllocations('0xcontract', 534, '0xwallet', {})
    ).resolves.toEqual({ has_distribution: false, allocations: [] });
  });
});
