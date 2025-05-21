import { jest } from '@jest/globals';
import * as nftHistory from '../nft_history';
import * as db from '../db'; // helpers that nft_history imports
import * as strings from '../strings';

const {
  getAttributeChanges,
  getEditDescription,
  findDeployerTransactions,
  findNFTHistory
} = nftHistory;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('nft_history helpers', () => {
  test('getAttributeChanges detects added, removed and changed traits', () => {
    const oldAttrs = [
      { trait_type: 'Color', value: 'Red' },
      { trait_type: 'Background', value: 'Blue' }
    ];
    const newAttrs = [
      { trait_type: 'Color', value: 'Green' },
      { trait_type: 'NewTrait', value: 'X' }
    ];

    const changes = getAttributeChanges(oldAttrs, newAttrs);

    expect(changes).toEqual([
      { trait_type: 'Color', old_value: 'Red', new_value: 'Green' },
      { trait_type: 'NewTrait (Added)', old_value: '', new_value: 'X' },
      { trait_type: 'Background (Removed)', old_value: 'Blue', new_value: '' }
    ]);
  });

  test('getEditDescription builds edit description from metadata differences', async () => {
    /* ─── mock dependencies that live outside nft_history ─── */
    jest.spyOn(db, 'fetchLatestNftUri').mockResolvedValue('old');

    jest
      .spyOn(strings, 'equalIgnoreCase')
      .mockImplementation((a: string, b: string) => a === b);

    /* ─── stub fetch returning old & new metadata ─── */
    type FakeResponse = { json: () => Promise<any> };

    const fetchMock = jest.fn() as jest.MockedFunction<
      () => Promise<FakeResponse>
    >;

    const oldMeta = {
      name: 'Old',
      attributes: [{ trait_type: 'Color', value: 'Red' }]
    };
    const newMeta = {
      name: 'New',
      attributes: [
        { trait_type: 'Color', value: 'Blue' },
        { trait_type: 'Power', value: 'High' }
      ]
    };

    fetchMock
      .mockResolvedValueOnce({ json: async () => oldMeta })
      .mockResolvedValueOnce({ json: async () => newMeta });

    (globalThis as any).fetch = fetchMock;

    /* ─── call unit under test ─── */
    const desc = await getEditDescription(1, '0xABC', 'new', 123);

    expect(desc).toEqual({
      event: 'Edit',
      changes: [
        { key: 'name', from: 'Old', to: 'New' },
        { key: 'attributes::Color', from: 'Red', to: 'Blue' },
        { key: 'attributes::Power (Added)', from: '', to: 'High' }
      ]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('nft_history high level functions', () => {
  test('findDeployerTransactions resolves paginated calls', async () => {
    const mockGet = jest.spyOn(nftHistory as any, 'getDeployerTransactions');
    mockGet
      .mockResolvedValueOnce({ latestBlock: 10, pageKey: 'key' })
      .mockResolvedValueOnce({ latestBlock: 15, pageKey: undefined });

    const result = await findDeployerTransactions(1);

    expect(result).toBe(15);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  test('findNFTHistory persists history block even after transient error', async () => {
    jest.spyOn(db, 'fetchLatestNftHistoryBlockNumber').mockResolvedValue(5);

    const persistMock = jest
      .spyOn(db, 'persistNftHistoryBlock')
      .mockResolvedValue(undefined);

    const findDeployMock = jest
      .spyOn(nftHistory as any, 'findDeployerTransactions')
      .mockRejectedValueOnce(new Error('timeout')) // first call fails
      .mockResolvedValueOnce(20); // retry succeeds

    await findNFTHistory(false);

    expect(findDeployMock).toHaveBeenCalledTimes(2); // retry happened
    expect(persistMock).toHaveBeenCalledWith(20); // block persisted
  });
});
