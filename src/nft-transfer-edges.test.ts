import * as fc from 'fast-check';
import {
  extractNftTransferEdgesFromLog,
  getNftTransferKey,
  NFT_TRANSFER_TOPICS
} from './nft-transfer-edges';
import {
  erc1155TransferBatchLog,
  erc1155TransferSingleLog,
  erc721TransferLog
} from './tests/fixtures/nft-transfer-log.fixture';

const CONTRACT = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
const FROM = '0x2222222222222222222222222222222222222222';
const TO = '0x3333333333333333333333333333333333333333';
const POSITION = {
  blockNumber: 100,
  transactionHash: `0x${'a'.repeat(64)}`,
  logIndex: 1
};

describe('extractNftTransferEdgesFromLog', () => {
  it('decodes an ERC-721 Transfer as one edge of amount 1', () => {
    const log = erc721TransferLog(CONTRACT, FROM, TO, 42, POSITION);
    expect(log.topics[0]).toBe(NFT_TRANSFER_TOPICS.ERC721_TRANSFER);
    const edges = extractNftTransferEdgesFromLog(log);
    expect(edges).toHaveLength(1);
    expect(edges[0].from.toLowerCase()).toBe(FROM);
    expect(edges[0].to.toLowerCase()).toBe(TO);
    expect(edges[0].contract).toBe(CONTRACT);
    expect(edges[0].tokenId).toBe('42');
    expect(edges[0].amount).toBe(BigInt(1));
  });

  it('decodes an ERC-1155 TransferSingle with its quantity', () => {
    const log = erc1155TransferSingleLog(CONTRACT, FROM, TO, 7, 5, POSITION);
    const edges = extractNftTransferEdgesFromLog(log);
    expect(edges).toHaveLength(1);
    expect(edges[0].tokenId).toBe('7');
    expect(edges[0].amount).toBe(BigInt(5));
  });

  it('decodes an ERC-1155 TransferBatch into one edge per id', () => {
    const log = erc1155TransferBatchLog(
      CONTRACT,
      FROM,
      TO,
      [1, 2, 3],
      [10, 20, 30],
      POSITION
    );
    const edges = extractNftTransferEdgesFromLog(log);
    expect(edges.map((edge) => [edge.tokenId, edge.amount.toString()])).toEqual(
      [
        ['1', '10'],
        ['2', '20'],
        ['3', '30']
      ]
    );
  });

  it('ignores the three-topic ERC-20 Transfer and malformed data', () => {
    const erc721 = erc721TransferLog(CONTRACT, FROM, TO, 1, POSITION);
    expect(
      extractNftTransferEdgesFromLog({
        ...erc721,
        topics: erc721.topics.slice(0, 3),
        data: `0x${'0'.repeat(64)}`
      })
    ).toEqual([]);
    const single = erc1155TransferSingleLog(CONTRACT, FROM, TO, 1, 1, POSITION);
    expect(
      extractNftTransferEdgesFromLog({ ...single, data: '0x1234' })
    ).toEqual([]);
  });

  it('keys edges case-insensitively with decimal token ids', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 40, maxLength: 40 }),
        fc.hexaString({ minLength: 40, maxLength: 40 }),
        fc.bigUint(),
        (from, to, tokenId) => {
          const lower = getNftTransferKey(
            `0x${from.toLowerCase()}`,
            `0x${to.toLowerCase()}`,
            CONTRACT.toLowerCase(),
            tokenId.toString()
          );
          const upper = getNftTransferKey(
            `0x${from.toUpperCase()}`,
            `0x${to.toUpperCase()}`,
            CONTRACT.toUpperCase(),
            `0x${tokenId.toString(16)}`
          );
          expect(upper).toBe(lower);
          expect(lower.split(':')[3]).toBe(tokenId.toString());
        }
      )
    );
  });
});
