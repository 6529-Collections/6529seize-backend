import { Alchemy, AssetTransfersWithMetadataResult } from '@/alchemy-sdk';
import { Transaction } from '@/entities/ITransaction';
import { TransactionsDiscoveryService } from '@/transactions/transactions-discovery.service';
import { TransactionsDiscoveryDb } from '@/transactions/transactions.discovery.db';

jest.mock('@/ens', () => ({
  discoverEns: jest.fn().mockResolvedValue(undefined)
}));

const CONTRACT = '0x1111111111111111111111111111111111111111';
const FROM = '0x2222222222222222222222222222222222222222';
const TO = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'a'.repeat(64)}`;

function makeErc1155Transfer(
  uniqueId: string | undefined,
  metadata: { tokenId: string; value: string }[],
  blockNum = '0x1'
): AssetTransfersWithMetadataResult {
  return {
    blockNum,
    uniqueId,
    hash: HASH,
    from: FROM,
    to: TO,
    metadata: {
      blockTimestamp: '2026-07-27T00:00:00.000Z'
    },
    rawContract: {
      address: CONTRACT
    },
    erc1155Metadata: metadata
  };
}

function createService(pages: AssetTransfersWithMetadataResult[][]) {
  const batchUpsertTransactions = jest.fn().mockResolvedValue(undefined);
  const getAssetTransfers = jest.fn();
  pages.forEach((transfers, index) => {
    getAssetTransfers.mockResolvedValueOnce({
      transfers,
      pageKey: index < pages.length - 1 ? `page-${index + 2}` : undefined
    });
  });
  const enhanceTransactionValues = jest
    .fn<Promise<Transaction[]>, [Transaction[]]>()
    .mockImplementation(async (transactions) => transactions);

  const service = new TransactionsDiscoveryService(
    {
      batchUpsertTransactions
    } as unknown as TransactionsDiscoveryDb,
    () =>
      ({
        core: {
          getAssetTransfers
        }
      }) as unknown as Alchemy,
    enhanceTransactionValues
  );

  return {
    service,
    batchUpsertTransactions,
    enhanceTransactionValues,
    getAssetTransfers
  };
}

describe('TransactionsDiscoveryService', () => {
  it('counts each Alchemy event once while aggregating distinct events in one transaction', async () => {
    const duplicateBatchEvent = makeErc1155Transfer('event-1', [
      { tokenId: '0x87', value: '0x1' },
      { tokenId: '0xfe', value: '0x1' }
    ]);
    const distinctEvent = makeErc1155Transfer('event-2', [
      { tokenId: '0x87', value: '0x2' }
    ]);
    const { service, batchUpsertTransactions, enhanceTransactionValues } =
      createService([
        [duplicateBatchEvent],
        [{ ...duplicateBatchEvent }, distinctEvent]
      ]);

    await service.getAndSaveTransactionsForContract(CONTRACT, 1, 1);

    expect(enhanceTransactionValues).toHaveBeenCalledTimes(1);
    expect(enhanceTransactionValues.mock.calls[0][0]).toHaveLength(3);
    expect(batchUpsertTransactions).toHaveBeenCalledTimes(1);

    const savedTransactions = batchUpsertTransactions.mock.calls[0][0];
    expect(savedTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token_id: 135, token_count: 3 }),
        expect.objectContaining({ token_id: 254, token_count: 1 })
      ])
    );
    expect(savedTransactions).toHaveLength(2);
  });

  it('does not collapse transfers when Alchemy omits event identity', async () => {
    const transferWithoutIdentity = makeErc1155Transfer(undefined, [
      { tokenId: '0x87', value: '0x1' }
    ]);
    const { service, batchUpsertTransactions, enhanceTransactionValues } =
      createService([
        [transferWithoutIdentity, { ...transferWithoutIdentity }]
      ]);

    await service.getAndSaveTransactionsForContract(CONTRACT, 1, 1);

    expect(enhanceTransactionValues.mock.calls[0][0]).toHaveLength(2);
    expect(batchUpsertTransactions.mock.calls[0][0]).toEqual([
      expect.objectContaining({ token_id: 135, token_count: 2 })
    ]);
  });

  it('retains boundary-block identities while pruning committed blocks', async () => {
    const blockOneEvent = makeErc1155Transfer(
      'block-1-event',
      [{ tokenId: '0x87', value: '0x1' }],
      '0x1'
    );
    const blockTwoEvent = makeErc1155Transfer(
      'block-2-event',
      [{ tokenId: '0xfe', value: '0x1' }],
      '0x2'
    );
    const blockThreeEvent = makeErc1155Transfer(
      'block-3-event',
      [{ tokenId: '0x12c', value: '0x1' }],
      '0x3'
    );
    const {
      service,
      batchUpsertTransactions,
      enhanceTransactionValues,
      getAssetTransfers
    } = createService([
      [blockOneEvent, blockTwoEvent],
      [{ ...blockTwoEvent }, blockThreeEvent],
      []
    ]);

    await service.getAndSaveTransactionsForContract(CONTRACT, 1, 3);

    expect(enhanceTransactionValues.mock.calls).toHaveLength(3);
    expect(
      enhanceTransactionValues.mock.calls.map((call) =>
        call[0].map(({ block, token_id, token_count }) => ({
          block,
          token_id,
          token_count
        }))
      )
    ).toEqual([
      [{ block: 1, token_id: 135, token_count: 1 }],
      [{ block: 2, token_id: 254, token_count: 1 }],
      [{ block: 3, token_id: 300, token_count: 1 }]
    ]);
    expect(batchUpsertTransactions).toHaveBeenCalledTimes(3);
    getAssetTransfers.mock.calls.forEach(([params]) => {
      expect(params.order).toBe('asc');
    });
  });

  it('does not reserve an identity for a transfer that maps to no rows', async () => {
    const emptyTransfer = makeErc1155Transfer('event-1', []);
    const validTransfer = makeErc1155Transfer('event-1', [
      { tokenId: '0x87', value: '0x1' }
    ]);
    const { service, batchUpsertTransactions } = createService([
      [emptyTransfer],
      [validTransfer]
    ]);

    await service.getAndSaveTransactionsForContract(CONTRACT, 1, 1);

    expect(batchUpsertTransactions.mock.calls[0][0]).toEqual([
      expect.objectContaining({ token_id: 135, token_count: 1 })
    ]);
  });
});
