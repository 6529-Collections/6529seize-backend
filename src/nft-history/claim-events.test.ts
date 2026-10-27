import { NFT_HISTORY_IFACE } from '@/abis/nft_history';
import {
  MEMES_CONTRACT,
  MEMELAB_CONTRACT,
  MANIFOLD_LAZY_CLAIM_CONTRACT
} from '@/constants';
import { Log } from '@/ethereum-rpc/ethereum-rpc-types';
import {
  CLAIM_EVENT_IFACE,
  claimEventId,
  decodeClaimUpdate,
  discoverClaimUpdates
} from './claim-events';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));

function fixture() {
  const eventLog = CLAIM_EVENT_IFACE.encodeEventLog(
    CLAIM_EVENT_IFACE.getEvent('ClaimUpdated')!,
    [MEMES_CONTRACT, 12345]
  );
  const log: Log = {
    blockNumber: 26254530,
    blockHash: '0xblock',
    transactionHash: '0xtx',
    transactionIndex: 21,
    logIndex: 52,
    address: MANIFOLD_LAZY_CLAIM_CONTRACT,
    removed: false,
    ...eventLog
  };
  const data = NFT_HISTORY_IFACE.encodeFunctionData('0xe505bb01', [
    MEMES_CONTRACT,
    12345,
    [
      328,
      0,
      0,
      0,
      2,
      '0x' + '0'.repeat(64),
      'WzsBy-SqOkS8Pr-jIL9J1LX4KLZmgzuqSu8ee79K234',
      0,
      MEMES_CONTRACT,
      MEMES_CONTRACT,
      MEMES_CONTRACT
    ]
  ]);
  const tx = {
    data,
    to: MANIFOLD_LAZY_CLAIM_CONTRACT,
    from: '0x0187c9a182736ba18b44ee8134ee438374cf87dc',
    blockHash: log.blockHash,
    index: 21
  };
  const receipt = {
    status: 1,
    blockHash: log.blockHash,
    logs: [{ ...log, index: 52 }]
  };
  const rpc = {
    getTransaction: jest.fn().mockResolvedValue(tx),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getBlock: jest
      .fn()
      .mockResolvedValue({ hash: log.blockHash, timestamp: 1792748915 }),
    call: jest
      .fn()
      .mockResolvedValue('0x' + (12345).toString(16).padStart(64, '0')),
    getLogs: jest.fn().mockResolvedValue([log])
  };
  jest
    .mocked(getEthereumRpcClient)
    .mockReturnValue(rpc as unknown as ReturnType<typeof getEthereumRpcClient>);
  return { log, tx, rpc, receipt };
}

it('ingests a non-deployer transaction and resolves token 550 from claim 12345', async () => {
  const { log, rpc } = fixture();
  const resolve = jest.fn().mockResolvedValue([550]);
  const row = await decodeClaimUpdate(log, resolve);
  expect(row.nft_id).toBe(550);
  expect(row.claim_id).toBe('12345');
  expect(row.uri).toBe(
    'https://arweave.net/WzsBy-SqOkS8Pr-jIL9J1LX4KLZmgzuqSu8ee79K234'
  );
  expect(resolve).toHaveBeenCalledWith(MEMES_CONTRACT, '12345');
  expect(rpc.call).toHaveBeenCalledWith(
    expect.objectContaining({ to: MANIFOLD_LAZY_CLAIM_CONTRACT }),
    log.blockNumber
  );
});

it.each([{ ids: [] }, { ids: [550, 551] }])(
  'rejects missing or ambiguous mappings: %j',
  async ({ ids }) => {
    const { log } = fixture();
    await expect(decodeClaimUpdate(log, async () => ids)).rejects.toThrow(
      'Unmapped or ambiguous'
    );
  }
);

it('rejects an extension collision even if a stored mapping exists', async () => {
  const { log, rpc } = fixture();
  rpc.call.mockResolvedValue('0x' + '0'.repeat(64));
  await expect(decodeClaimUpdate(log, async () => [550])).rejects.toThrow(
    'does not match extension'
  );
});

it('does not use current state for forwarded transactions', async () => {
  const { log, tx, rpc } = fixture();
  tx.to = MEMELAB_CONTRACT;
  await expect(decodeClaimUpdate(log, async () => [550])).rejects.toThrow(
    'execution calldata required'
  );
  expect(rpc.call).not.toHaveBeenCalled();
});

it('rejects failed receipts and reorged logs', async () => {
  const { log, receipt } = fixture();
  receipt.status = 0;
  await expect(decodeClaimUpdate(log, async () => [550])).rejects.toThrow(
    'mismatch'
  );
  receipt.status = 1;
  log.blockHash = '0xother';
  await expect(decodeClaimUpdate(log, async () => [550])).rejects.toThrow(
    'mismatch'
  );
});

it('filters live discovery by extension but audits all matching emitters', async () => {
  const { log, rpc } = fixture();
  await discoverClaimUpdates(1, 2000);
  expect(rpc.getLogs).toHaveBeenLastCalledWith(
    expect.objectContaining({
      address: expect.arrayContaining([
        MANIFOLD_LAZY_CLAIM_CONTRACT.toLowerCase()
      ]),
      fromBlock: '0x1',
      toBlock: '0x7d0'
    })
  );
  await discoverClaimUpdates(1, 2000, true);
  expect(rpc.getLogs.mock.calls[1][0]).not.toHaveProperty('address');
  expect(claimEventId(log)).not.toBe(claimEventId({ ...log, logIndex: 53 }));
});

it('accepts word-aligned tuple returns and rejects a malformed ABI tail', async () => {
  const { log, rpc } = fixture();
  const firstWord = '0x' + (12345).toString(16).padStart(64, '0');
  rpc.call.mockResolvedValue(firstWord + '0'.repeat(64));
  await expect(decodeClaimUpdate(log, async () => [550])).resolves.toEqual(
    expect.objectContaining({ nft_id: 550 })
  );
  rpc.call.mockResolvedValue(firstWord + '0');
  await expect(decodeClaimUpdate(log, async () => [550])).rejects.toThrow(
    'does not match extension'
  );
});
