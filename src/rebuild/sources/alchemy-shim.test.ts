import { AbiCoder } from 'ethers';
import {
  selectTransfers,
  startAlchemyShim,
  TRANSFER_BATCH_TOPIC,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_TOPIC,
  transferOfTransaction,
  transfersOfLog
} from '@/rebuild/sources/alchemy-shim';

const coder = AbiCoder.defaultAbiCoder();
const word = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const CONTRACT = '0x00000000000000000000000000000000000000c1';
const TIME = '2026-01-01T00:00:00.000Z';

function log(topics: string[], data: string, block: number, index: number) {
  return {
    address: CONTRACT,
    topics,
    data,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex: `0x${index.toString(16)}`
  };
}

describe('Alchemy shim', () => {
  it('reads ERC-721, ERC-20 and ERC-1155 transfers from logs', () => {
    const erc721 = transfersOfLog(
      log(
        [TRANSFER_TOPIC, word(A), word(B), `0x${'0'.repeat(63)}7`],
        '0x',
        5,
        1
      ),
      TIME
    );
    expect(erc721).toEqual([
      expect.objectContaining({
        category: 'erc721',
        from: A,
        to: B,
        erc721TokenId: '0x7',
        uniqueId: `0x${'ab'.repeat(32)}:log:1`,
        metadata: { blockTimestamp: TIME }
      })
    ]);
    const erc20 = transfersOfLog(
      log(
        [TRANSFER_TOPIC, word(A), word(B)],
        coder.encode(['uint256'], [5]),
        5,
        2
      ),
      TIME
    );
    expect(erc20[0]).toMatchObject({ category: 'erc20', value: 5 });
    const single = transfersOfLog(
      log(
        [TRANSFER_SINGLE_TOPIC, word(A), word(A), word(B)],
        coder.encode(['uint256', 'uint256'], [3, 2]),
        5,
        3
      ),
      TIME
    );
    expect(single[0]).toMatchObject({
      category: 'erc1155',
      from: A,
      to: B,
      erc1155Metadata: [{ tokenId: '0x3', value: '0x2' }]
    });
    const batch = transfersOfLog(
      log(
        [TRANSFER_BATCH_TOPIC, word(A), word(A), word(B)],
        coder.encode(
          ['uint256[]', 'uint256[]'],
          [
            [1, 2],
            [10, 20]
          ]
        ),
        5,
        4
      ),
      TIME
    );
    expect(batch[0].erc1155Metadata).toEqual([
      { tokenId: '0x1', value: '0xa' },
      { tokenId: '0x2', value: '0x14' }
    ]);
    expect(transfersOfLog(log(['0x01'], '0x', 5, 5), TIME)).toEqual([]);
  });

  it('filters, orders and pages like alchemy_getAssetTransfers', () => {
    const transfers = [
      transferOfTransaction(
        { hash: '0x1', from: A, to: B, value: '0xde0b6b3a7640000' },
        '0x2',
        TIME,
        0
      ),
      transferOfTransaction(
        { hash: '0x2', from: B, to: A, value: '0x0' },
        '0x2',
        TIME,
        1
      ),
      ...transfersOfLog(
        log(
          [TRANSFER_TOPIC, word(A), word(B), `0x${'0'.repeat(63)}1`],
          '0x',
          1,
          0
        ),
        TIME
      ),
      ...transfersOfLog(
        log(
          [TRANSFER_TOPIC, word(B), word(A), `0x${'0'.repeat(63)}2`],
          '0x',
          3,
          0
        ),
        TIME
      )
    ];
    const all = selectTransfers(transfers, {});
    expect(all.transfers.map((t) => t.blockNum)).toEqual(['0x1', '0x2', '0x3']);
    expect(all.transfers[1]).toMatchObject({ category: 'external', value: 1 });
    expect(all.transfers[1]).not.toHaveProperty('order');
    expect(
      selectTransfers(transfers, {
        excludeZeroValue: false,
        category: ['external']
      }).transfers
    ).toHaveLength(2);
    expect(
      selectTransfers(transfers, {
        fromAddress: B,
        category: ['erc721']
      }).transfers.map((t) => t.erc721TokenId)
    ).toEqual(['0x2']);
    const desc = selectTransfers(transfers, { order: 'desc', maxCount: '0x2' });
    expect(desc.transfers.map((t) => t.blockNum)).toEqual(['0x3', '0x2']);
    expect(desc.pageKey).toBe('2');
    expect(
      selectTransfers(transfers, {
        order: 'desc',
        maxCount: '0x2',
        pageKey: '2'
      })
    ).toEqual({ transfers: [expect.objectContaining({ blockNum: '0x1' })] });
    expect(
      selectTransfers(transfers, {
        contractAddresses: [CONTRACT.toUpperCase()]
      }).transfers
    ).toHaveLength(2);
  });
});

describe('the Alchemy stand-in', () => {
  it('refuses and reports the NFT API and other alchemy_ methods', async () => {
    // The node is never reached for these calls.
    const shim = await startAlchemyShim('http://127.0.0.1:9');
    try {
      const post = (url: string, body: unknown) =>
        fetch(`${shim.url}${url}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
      const nft = await post('/nft/v3/key/getNFTMetadataBatch', {
        tokens: []
      });
      expect(nft.status).toBe(501);
      const balances = await post('/v2/key', {
        jsonrpc: '2.0',
        id: 7,
        method: 'alchemy_getTokenBalances',
        params: []
      });
      expect(await balances.json()).toMatchObject({
        id: 7,
        error: { code: -32601 }
      });
      expect(shim.problems()).toEqual([
        "ethereum: 2 Alchemy calls the run doesn't serve (the NFT API or enhanced methods); first POST /nft/v3/key/getNFTMetadataBatch, alchemy_getTokenBalances"
      ]);
    } finally {
      await shim.stop();
    }
  });
});
