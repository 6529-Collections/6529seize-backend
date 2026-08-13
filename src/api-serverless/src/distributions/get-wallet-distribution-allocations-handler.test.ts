const mockGetWalletDistributionAllocations = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('./get-wallet-distribution-allocations.service', () => ({
  getWalletDistributionAllocations: mockGetWalletDistributionAllocations
}));

jest.mock('@/time', () => ({
  Timer: { getFromRequest: mockGetFromRequest }
}));

import { handleGetWalletDistributionAllocations } from './get-wallet-distribution-allocations.handler';

describe('handleGetWalletDistributionAllocations', () => {
  const contract = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
  const wallet = '0x0000000000000000000000000000000000000001';

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFromRequest.mockReturnValue({ marker: 'timer' });
    mockGetWalletDistributionAllocations.mockResolvedValue({
      has_distribution: true,
      allocations: []
    });
  });

  it('normalizes addresses before fetching allocations', async () => {
    const request = {
      params: { contract, card_id: '534' },
      query: { wallet }
    } as any;

    await expect(
      handleGetWalletDistributionAllocations(request)
    ).resolves.toEqual({ has_distribution: true, allocations: [] });
    expect(mockGetWalletDistributionAllocations).toHaveBeenCalledWith(
      contract.toLowerCase(),
      534,
      wallet.toLowerCase(),
      { timer: { marker: 'timer' } }
    );
  });

  it.each([
    { contract: 'not-an-address', card_id: '534', wallet },
    { contract, card_id: '0', wallet },
    { contract, card_id: '534', wallet: 'not-an-address' }
  ])('rejects invalid request data %#', async (input) => {
    await expect(
      handleGetWalletDistributionAllocations({
        params: { contract: input.contract, card_id: input.card_id },
        query: { wallet: input.wallet }
      } as any)
    ).rejects.toThrow();
    expect(mockGetWalletDistributionAllocations).not.toHaveBeenCalled();
  });
});
