import { Transaction } from '@/entities/ITransaction';
import { getClosestEthUsdPrice } from '@/ethPriceLoop/db.eth_price';
import { getRpcProvider } from '@/rpc-provider';
import {
  ReceiptLike,
  findDiscoveredTransactionValues,
  reconcileTransactionTokenCounts
} from '@/transaction_values';
import { ethers } from 'ethers';
import fc from 'fast-check';

jest.mock('@/ethPriceLoop/db.eth_price', () => ({
  getClosestEthUsdPrice: jest.fn()
}));

jest.mock('@/rpc-provider', () => ({
  get6529RpcProvider: jest.fn(),
  getRpcProvider: jest.fn()
}));

const CONTRACT = '0x1111111111111111111111111111111111111111';
const OTHER_CONTRACT = '0x4444444444444444444444444444444444444444';
const FROM = '0x2222222222222222222222222222222222222222';
const TO = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'a'.repeat(64)}`;

const NFT_IFACE = new ethers.Interface([
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'
]);

function makeTransaction(
  tokenId: number,
  tokenCount: number,
  contract = CONTRACT
): Transaction {
  return {
    created_at: new Date(),
    transaction: HASH,
    block: 1,
    transaction_date: new Date(),
    from_address: FROM,
    to_address: TO,
    contract,
    token_id: tokenId,
    token_count: tokenCount,
    value: 0,
    primary_proceeds: 0,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0,
    eth_price_usd: 0,
    value_usd: 0,
    gas_usd: 0
  };
}

function makeLog(
  eventName: 'Transfer' | 'TransferSingle' | 'TransferBatch',
  values: readonly unknown[],
  address = CONTRACT
) {
  const event = NFT_IFACE.getEvent(eventName)!;
  const encoded = NFT_IFACE.encodeEventLog(event, values);
  return {
    address,
    topics: encoded.topics,
    data: encoded.data
  };
}

describe('reconcileTransactionTokenCounts', () => {
  it('corrects duplicate provider candidates from the receipt', () => {
    const row = makeTransaction(473, 2);
    const receipt: ReceiptLike = {
      logs: [
        makeLog('TransferSingle', [FROM, FROM, TO, BigInt(473), BigInt(1)])
      ]
    };

    expect(reconcileTransactionTokenCounts([row], receipt)).toBe(1);
    expect(row.token_count).toBe(1);
  });

  it('preserves the sum of legitimate matching transfer logs', () => {
    const row = makeTransaction(473, 3);
    const receipt: ReceiptLike = {
      logs: [
        makeLog('TransferSingle', [FROM, FROM, TO, BigInt(473), BigInt(1)]),
        makeLog('TransferSingle', [FROM, FROM, TO, BigInt(473), BigInt(2)])
      ]
    };

    expect(reconcileTransactionTokenCounts([row], receipt)).toBe(0);
    expect(row.token_count).toBe(3);
  });

  it('reconciles ERC1155 batches and ERC721 transfers', () => {
    const erc1155Row = makeTransaction(473, 8);
    const secondErc1155Row = makeTransaction(474, 5);
    const erc721Row = makeTransaction(99, 2, OTHER_CONTRACT);
    const receipt: ReceiptLike = {
      logs: [
        makeLog('TransferBatch', [
          FROM,
          FROM,
          TO,
          [BigInt(473), BigInt(474)],
          [BigInt(4), BigInt(5)]
        ]),
        makeLog('Transfer', [FROM, TO, BigInt(99)], OTHER_CONTRACT)
      ]
    };

    expect(
      reconcileTransactionTokenCounts(
        [erc1155Row, secondErc1155Row, erc721Row],
        receipt
      )
    ).toBe(2);
    expect(erc1155Row.token_count).toBe(4);
    expect(secondErc1155Row.token_count).toBe(5);
    expect(erc721Row.token_count).toBe(1);
  });

  it('reconciles arbitrary ERC1155 batch token amounts', () => {
    const batchEntriesArb = fc
      .uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), {
        minLength: 1,
        maxLength: 20
      })
      .chain((tokenIds) =>
        fc.tuple(
          fc.constant(tokenIds),
          fc.array(fc.integer({ min: 1, max: 1_000 }), {
            minLength: tokenIds.length,
            maxLength: tokenIds.length
          })
        )
      );

    fc.assert(
      fc.property(batchEntriesArb, ([tokenIds, amounts]) => {
        const rows = tokenIds.map((tokenId, index) =>
          makeTransaction(tokenId, amounts[index] + 1)
        );
        const receipt: ReceiptLike = {
          logs: [
            makeLog('TransferBatch', [
              FROM,
              FROM,
              TO,
              tokenIds.map(BigInt),
              amounts.map(BigInt)
            ])
          ]
        };

        expect(reconcileTransactionTokenCounts(rows, receipt)).toBe(
          rows.length
        );
        expect(rows.map((row) => row.token_count)).toEqual(amounts);
      }),
      { numRuns: 100 }
    );
  });

  it('fails closed when the receipt has no matching transfer', () => {
    const row = makeTransaction(473, 1);
    const receipt: ReceiptLike = {
      logs: [
        makeLog('TransferSingle', [FROM, FROM, TO, BigInt(474), BigInt(1)])
      ]
    };

    expect(() => reconcileTransactionTokenCounts([row], receipt)).toThrow(
      'No matching NFT transfer log'
    );
  });

  it('does not partially mutate rows when reconciliation fails', () => {
    const matchingRow = makeTransaction(473, 2);
    const missingRow = makeTransaction(474, 1);
    const receipt: ReceiptLike = {
      logs: [
        makeLog('TransferSingle', [FROM, FROM, TO, BigInt(473), BigInt(1)])
      ]
    };

    expect(() =>
      reconcileTransactionTokenCounts([matchingRow, missingRow], receipt)
    ).toThrow('No matching NFT transfer log');
    expect(matchingRow.token_count).toBe(2);
    expect(missingRow.token_count).toBe(1);
  });

  it('ignores unrelated receipt transfers that have no Alchemy row', () => {
    const row = makeTransaction(473, 1);
    const receipt: ReceiptLike = {
      logs: [
        makeLog('TransferSingle', [FROM, FROM, TO, BigInt(473), BigInt(1)]),
        makeLog('TransferSingle', [FROM, FROM, TO, BigInt(474), BigInt(1)])
      ]
    };

    expect(reconcileTransactionTokenCounts([row], receipt)).toBe(0);
    expect(row.token_count).toBe(1);
  });

  it('ignores malformed unrelated transfer logs', () => {
    const row = makeTransaction(473, 1);
    const receipt: ReceiptLike = {
      logs: [
        {
          address: OTHER_CONTRACT,
          topics: [NFT_IFACE.getEvent('TransferSingle')!.topicHash],
          data: '0x'
        },
        makeLog('TransferSingle', [FROM, FROM, TO, BigInt(473), BigInt(1)])
      ]
    };

    expect(reconcileTransactionTokenCounts([row], receipt)).toBe(0);
    expect(row.token_count).toBe(1);
  });

  it('reuses the receipt RPC request during value resolution', async () => {
    const row = makeTransaction(473, 2);
    const receipt = {
      gasUsed: BigInt(0),
      logs: [
        makeLog('TransferSingle', [FROM, FROM, TO, BigInt(473), BigInt(1)])
      ]
    };
    const getTransaction = jest.fn().mockResolvedValue({
      hash: HASH,
      value: BigInt(0),
      gasPrice: BigInt(0)
    });
    const getTransactionReceipt = jest.fn().mockResolvedValue(receipt);
    jest.mocked(getRpcProvider).mockReturnValue({
      getTransaction,
      getTransactionReceipt
    } as unknown as ReturnType<typeof getRpcProvider>);
    jest.mocked(getClosestEthUsdPrice).mockResolvedValue(1);

    const [result] = await findDiscoveredTransactionValues([row]);

    expect(result.token_count).toBe(1);
    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
});
