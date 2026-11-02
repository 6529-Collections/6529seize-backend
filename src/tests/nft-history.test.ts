import { jest } from '@jest/globals';
import * as nftHistory from '../nft_history';
import * as db from '../db'; // helpers that nft_history imports
import { describeHistoryEdit } from '@/nft-history/metadata';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import * as ingest from '@/nft-history/source-replay';

const { getAttributeChanges, findNFTHistory } = nftHistory;

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

  test('describeHistoryEdit builds edit description from metadata differences', async () => {
    /* ─── mock dependencies that live outside nft_history ─── */

    /* ─── stub fetch returning old & new metadata ─── */
    const fetchMock = jest.spyOn(globalThis, 'fetch');

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
      .mockResolvedValueOnce(new Response(JSON.stringify(oldMeta)))
      .mockResolvedValueOnce(new Response(JSON.stringify(newMeta)));

    const desc = await describeHistoryEdit(
      'https://arweave.net/IFosq_ZN9_PrDSQmq65JTjeB2GnnfPSFoHxRazxC4PY',
      'https://arweave.net/yEEVNbUIvVuF1Yb_rRUEmdrrGg3Lj7ZZa-4KBYqJsmg'
    );

    expect(desc).toEqual({
      event: 'Edit',
      changes: [
        { key: 'attributes::Color', from: 'Red', to: 'Blue' },
        { key: 'attributes::Power (Added)', from: '', to: 'High' },
        { key: 'name', from: 'Old', to: 'New' }
      ]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('nft_history high level functions', () => {
  test('does not checkpoint a window when claim ingestion fails', async () => {
    jest.spyOn(db, 'fetchLatestNftHistoryBlockNumber').mockResolvedValue(5);
    const checkpoint = jest
      .spyOn(db, 'persistNftHistoryBlock')
      .mockResolvedValue(undefined);
    jest
      .spyOn(getEthereumRpcClient().constructor.prototype, 'getBlock')
      .mockResolvedValue({ number: 20 });
    jest
      .spyOn(ingest, 'ingestHistorySources')
      .mockRejectedValue(new Error('metadata unavailable'));
    await expect(findNFTHistory(false)).rejects.toThrow('metadata unavailable');
    expect(checkpoint).not.toHaveBeenCalled();
  });
});

it('rejects legacy forced resets before reading or changing any checkpoint', async () => {
  const read = jest.spyOn(db, 'fetchLatestNftHistoryBlockNumber');
  const write = jest.spyOn(db, 'persistNftHistoryBlock');
  const discover = jest.spyOn(ingest, 'ingestHistorySources');
  await expect(findNFTHistory(true)).rejects.toThrow(
    'NFT_HISTORY_RESET is unsupported'
  );
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
});
