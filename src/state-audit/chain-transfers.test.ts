import * as fc from 'fast-check';
import type { Log } from '@/ethereum-rpc/ethereum-rpc-types';
import {
  blockHashOf,
  erc1155TransferBatchLog,
  erc1155TransferSingleLog,
  erc721TransferLog,
  txHashOf
} from '@/tests/fixtures/nft-transfer-log.fixture';
import type { StateAuditRpc } from './block-anchors';
import {
  blockChunks,
  fetchChainTransfers,
  LOG_CHUNK_BLOCKS,
  MAX_LOGS_PER_CHUNK,
  summarizeTransferLogs,
  toHexBlock,
  TRANSFER_TOPIC_FILTER
} from './chain-transfers';

const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const OTHER = '0x4db52a61dc491e15a2f78f5ac001c14ffe3568cb';
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';
const C = '0x4444444444444444444444444444444444444444';

describe('blockChunks', () => {
  it('covers the inclusive window exactly once', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 1, max: 700 }),
        (from, span, size) => {
          const chunks = blockChunks(from, from + span, size);
          expect(chunks[0].from_block).toBe(from);
          expect(chunks[chunks.length - 1].to_block).toBe(from + span);
          chunks.forEach((chunk, index) => {
            expect(chunk.to_block - chunk.from_block + 1).toBeLessThanOrEqual(
              size
            );
            if (index > 0)
              expect(chunk.from_block).toBe(chunks[index - 1].to_block + 1);
          });
        }
      )
    );
  });
});

describe('summarizeTransferLogs', () => {
  it('sums repeated edges of one transaction per from:to:contract:tokenId', () => {
    const tx = txHashOf(1);
    const logs = [
      erc1155TransferSingleLog(CONTRACT, A, B, 5, 2, {
        blockNumber: 10,
        transactionHash: tx,
        logIndex: 0
      }),
      erc1155TransferBatchLog(CONTRACT, A, B, [5, 6], [3, 1], {
        blockNumber: 10,
        transactionHash: tx,
        logIndex: 1
      }),
      erc721TransferLog(CONTRACT, B, C, 9, {
        blockNumber: 10,
        transactionHash: tx,
        logIndex: 2
      })
    ];
    const { transfers, inspected, problems } = summarizeTransferLogs(
      logs,
      CONTRACT.toUpperCase()
    );
    expect(problems).toEqual([]);
    expect(
      transfers.map((t) => [
        t.from_address,
        t.to_address,
        t.token_id,
        t.amount.toString(),
        t.log_indexes
      ])
    ).toEqual([
      [A, B, '5', '5', [0, 1]],
      [A, B, '6', '1', [1]],
      [B, C, '9', '1', [2]]
    ]);
    expect(inspected).toEqual([
      {
        transaction: tx,
        block: 10,
        block_hash: blockHashOf(10),
        transaction_index: 0,
        log_indexes: [0, 1, 2]
      }
    ]);
  });

  it('skips removed logs and reports foreign or undecodable ones', () => {
    const tx = txHashOf(2);
    const removed = erc721TransferLog(CONTRACT, A, B, 1, {
      blockNumber: 11,
      transactionHash: tx,
      logIndex: 0,
      removed: true
    });
    const foreign = erc721TransferLog(OTHER, A, B, 2, {
      blockNumber: 11,
      transactionHash: tx,
      logIndex: 1
    });
    const broken: Log = {
      ...erc1155TransferSingleLog(CONTRACT, A, B, 3, 1, {
        blockNumber: 11,
        transactionHash: tx,
        logIndex: 2
      }),
      data: '0x12'
    };
    const { transfers, problems } = summarizeTransferLogs(
      [removed, foreign, broken],
      CONTRACT
    );
    expect(transfers).toEqual([]);
    expect(problems.map((p) => p.code)).toEqual([
      'foreign_log',
      'unparsed_log'
    ]);
  });

  it('is order independent and sums amounts exactly (fast-check)', () => {
    const wallets = [A, B, C];
    const edgeArb = fc.record({
      from: fc.constantFrom(...wallets),
      to: fc.constantFrom(...wallets),
      tokenId: fc.integer({ min: 1, max: 4 }),
      amount: fc.bigInt({ min: BigInt(1), max: BigInt(1) << BigInt(70) })
    });
    fc.assert(
      fc.property(fc.array(edgeArb, { maxLength: 12 }), (edges) => {
        const tx = txHashOf(3);
        const logs = edges.map((edge, index) =>
          index % 2 === 0
            ? erc1155TransferSingleLog(
                CONTRACT,
                edge.from,
                edge.to,
                edge.tokenId,
                edge.amount,
                { blockNumber: 12, transactionHash: tx, logIndex: index }
              )
            : erc1155TransferBatchLog(
                CONTRACT,
                edge.from,
                edge.to,
                [edge.tokenId],
                [edge.amount],
                { blockNumber: 12, transactionHash: tx, logIndex: index }
              )
        );
        const expected = new Map<string, bigint>();
        edges.forEach((edge) => {
          const key = `${edge.from}:${edge.to}:${edge.tokenId}`;
          expected.set(key, (expected.get(key) ?? BigInt(0)) + edge.amount);
        });
        const forward = summarizeTransferLogs(logs, CONTRACT);
        const reversed = summarizeTransferLogs(
          logs.slice().reverse(),
          CONTRACT
        );
        expect(reversed.transfers).toEqual(forward.transfers);
        expect(forward.transfers).toHaveLength(expected.size);
        forward.transfers.forEach((transfer) => {
          const key = `${transfer.from_address}:${transfer.to_address}:${transfer.token_id}`;
          expect(transfer.amount).toBe(expected.get(key));
        });
      })
    );
  });
});

describe('fetchChainTransfers', () => {
  function rpcWith(
    getLogs: (filter: {
      fromBlock?: string;
      toBlock?: string;
      address?: string | string[];
      topics?: (string | string[] | null)[];
    }) => Log[]
  ): StateAuditRpc {
    return {
      getBlock: jest.fn(),
      getLogs: jest.fn().mockImplementation(async (filter) => getLogs(filter))
    };
  }

  it('queries the contract with the three transfer topics in bounded chunks', async () => {
    const calls: { fromBlock?: string; toBlock?: string }[] = [];
    const rpc = rpcWith((filter) => {
      calls.push(filter);
      expect(filter.address).toBe(CONTRACT);
      expect(filter.topics).toEqual([TRANSFER_TOPIC_FILTER]);
      return [];
    });
    const result = await fetchChainTransfers(
      rpc,
      CONTRACT,
      1000,
      1000 + 2 * LOG_CHUNK_BLOCKS
    );
    expect(calls).toEqual([
      {
        address: CONTRACT,
        topics: [TRANSFER_TOPIC_FILTER],
        fromBlock: toHexBlock(1000),
        toBlock: toHexBlock(1000 + LOG_CHUNK_BLOCKS - 1)
      },
      {
        address: CONTRACT,
        topics: [TRANSFER_TOPIC_FILTER],
        fromBlock: toHexBlock(1000 + LOG_CHUNK_BLOCKS),
        toBlock: toHexBlock(1000 + 2 * LOG_CHUNK_BLOCKS - 1)
      },
      {
        address: CONTRACT,
        topics: [TRANSFER_TOPIC_FILTER],
        fromBlock: toHexBlock(1000 + 2 * LOG_CHUNK_BLOCKS),
        toBlock: toHexBlock(1000 + 2 * LOG_CHUNK_BLOCKS)
      }
    ]);
    expect(result.chunks.map((chunk) => chunk.log_count)).toEqual([0, 0, 0]);
    expect(result.problems).toEqual([]);
  });

  it('flags a chunk at the provider cap and logs outside the chunk', async () => {
    const rpc = rpcWith((filter) => {
      const from = Number(filter.fromBlock);
      const logs: Log[] = [];
      for (let index = 0; index < MAX_LOGS_PER_CHUNK; index += 1) {
        logs.push(
          erc721TransferLog(CONTRACT, A, B, index, {
            blockNumber: from,
            transactionHash: txHashOf(index),
            logIndex: 0
          })
        );
      }
      logs.push(
        erc721TransferLog(CONTRACT, A, B, 1, {
          blockNumber: from + LOG_CHUNK_BLOCKS + 5,
          transactionHash: txHashOf(99),
          logIndex: 0
        })
      );
      return logs;
    });
    const result = await fetchChainTransfers(rpc, CONTRACT, 1, 1);
    expect(result.problems.map((p) => p.code)).toEqual([
      'log_response_capped',
      'foreign_log'
    ]);
  });

  it('propagates RPC errors to the caller', async () => {
    const rpc = rpcWith(() => {
      throw new Error('provider unavailable https://secret.example/key');
    });
    await expect(fetchChainTransfers(rpc, CONTRACT, 1, 10)).rejects.toThrow(
      'provider unavailable'
    );
  });
});
