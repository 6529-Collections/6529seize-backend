import { fetchPaginated } from '@/db-api';
import { DISTRIBUTION_NORMALIZED_TABLE } from '@/constants';
import { fetchDistributions } from '@/api/distributions/api.distributions.db';

jest.mock('@/db-api', () => ({
  fetchPaginated: jest.fn()
}));

jest.mock('@/api/distributions/api.distributions.service', () => ({
  checkIsNormalized: jest.fn()
}));

const fetchPaginatedMock = fetchPaginated as jest.MockedFunction<
  typeof fetchPaginated
>;

function mockPage() {
  fetchPaginatedMock.mockResolvedValue({
    count: 0,
    page: 1,
    next: null,
    data: []
  });
}

describe('fetchDistributions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPage();
  });

  it('returns an empty page without any filters', async () => {
    await expect(
      fetchDistributions(
        {
          search: undefined,
          cards: undefined,
          contracts: undefined,
          wallets: undefined,
          phases: undefined,
          minted: undefined
        },
        2000,
        1
      )
    ).resolves.toEqual({
      count: 0,
      page: 1,
      next: null,
      data: []
    });

    expect(fetchPaginatedMock).not.toHaveBeenCalled();
  });

  it('keeps existing card, contract, and wallet filters', async () => {
    await fetchDistributions(
      {
        search: '',
        cards: '440, 441',
        contracts: '0xContractA, 0xContractB',
        wallets: '0xWalletA, 0xWalletB',
        phases: '',
        minted: undefined
      },
      2000,
      1
    );

    expect(fetchPaginatedMock).toHaveBeenCalledWith(
      DISTRIBUTION_NORMALIZED_TABLE,
      {
        cards: ['440', '441'],
        contracts: ['0xContractA', '0xContractB'],
        wallets: ['0xwalleta', '0xwalletb']
      },
      expect.any(String),
      2000,
      1,
      expect.stringContaining(
        `${DISTRIBUTION_NORMALIZED_TABLE}.card_id in (:cards)`
      )
    );
  });

  it('filters minted distributions', async () => {
    await fetchDistributions(
      {
        search: '',
        cards: '440',
        contracts: '',
        wallets: '',
        phases: '',
        minted: true
      },
      2000,
      1
    );

    expect(fetchPaginatedMock).toHaveBeenCalledWith(
      DISTRIBUTION_NORMALIZED_TABLE,
      { cards: ['440'] },
      expect.any(String),
      2000,
      1,
      expect.stringContaining(`${DISTRIBUTION_NORMALIZED_TABLE}.minted > 0`)
    );
  });

  it('filters unminted distributions', async () => {
    await fetchDistributions(
      {
        search: '',
        cards: '440',
        contracts: '',
        wallets: '',
        phases: '',
        minted: false
      },
      2000,
      1
    );

    expect(fetchPaginatedMock).toHaveBeenCalledWith(
      DISTRIBUTION_NORMALIZED_TABLE,
      { cards: ['440'] },
      expect.any(String),
      2000,
      1,
      expect.stringContaining(`${DISTRIBUTION_NORMALIZED_TABLE}.minted = 0`)
    );
  });

  it('filters by distribution phases', async () => {
    await fetchDistributions(
      {
        search: '',
        cards: '440',
        contracts: '',
        wallets: '',
        phases: 'Phase 1, Public',
        minted: undefined
      },
      2000,
      1
    );

    expect(fetchPaginatedMock).toHaveBeenCalledWith(
      DISTRIBUTION_NORMALIZED_TABLE,
      {
        cards: ['440'],
        phase_0: 'Phase 1',
        phase_1: 'Public'
      },
      expect.any(String),
      2000,
      1,
      expect.stringContaining(
        `JSON_CONTAINS(${DISTRIBUTION_NORMALIZED_TABLE}.phases, JSON_QUOTE(:phase_0)) OR JSON_CONTAINS(${DISTRIBUTION_NORMALIZED_TABLE}.phases, JSON_QUOTE(:phase_1))`
      )
    );
  });
});
