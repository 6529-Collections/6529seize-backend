import { NFT_HISTORY_IFACE } from '@/abis/nft_history';
import { MEMES_CONTRACT } from '@/constants';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { nftHistoryDb } from './history.db';
import { ingestTokenUriUpdate } from './token-uri';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
jest.mock('./history.db', () => ({
  ...jest.requireActual('./history.db'),
  nftHistoryDb: { snapshot: jest.fn(), apply: jest.fn() }
}));
jest.mock('./metadata', () => ({
  describeHistoryEdit: jest.fn(async (from: string, to: string) => ({
    event: 'Edit',
    changes: [{ key: 'uri', from, to }]
  }))
}));

function fixture() {
  const receipt = {
    status: 1,
    blockNumber: 1,
    blockHash: 'block',
    index: 20,
    logs: []
  };
  const tx = {
    to: MEMES_CONTRACT,
    data: NFT_HISTORY_IFACE.encodeFunctionData('setTokenURI', [550, 'B']),
    blockNumber: 1,
    blockHash: 'block',
    index: 20
  };
  const rpc = {
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getBlock: jest.fn().mockResolvedValue({ hash: 'block', timestamp: 1000 }),
    getTransaction: jest.fn(async (hash: string) =>
      hash === 'mint' ? { ...tx, index: 10 } : tx
    )
  };
  jest
    .mocked(getEthereumRpcClient)
    .mockReturnValue(rpc as unknown as ReturnType<typeof getEthereumRpcClient>);
  jest.mocked(nftHistoryDb.snapshot).mockResolvedValue({
    legacy: [
      {
        contract: MEMES_CONTRACT,
        nft_id: 550,
        uri: 'A',
        block: 1,
        transaction_hash: 'mint',
        transaction_date: new Date(0),
        created_at: new Date(0),
        description: { event: 'Mint', changes: [] }
      }
    ],
    events: []
  });
  jest.mocked(nftHistoryDb.apply).mockResolvedValue(undefined);
  return { receipt, tx };
}
beforeEach(() => jest.clearAllMocks());

it('positions direct URI edits from verified calldata even though Manifold emits no URI log', async () => {
  fixture();
  await ingestTokenUriUpdate('uri-edit', MEMES_CONTRACT, 550, 'B');
  expect(jest.mocked(nftHistoryDb.apply).mock.calls[0][0].inserts[0]).toEqual(
    expect.objectContaining({
      claim_id: null,
      transaction_index: 20,
      log_index: -1,
      description: {
        event: 'Edit',
        changes: [{ key: 'uri', from: 'A', to: 'B' }]
      }
    })
  );
});
it('rejects changed calldata before writing history', async () => {
  const { tx } = fixture();
  tx.data = NFT_HISTORY_IFACE.encodeFunctionData('setTokenURI', [551, 'B']);
  await expect(
    ingestTokenUriUpdate('uri-edit', MEMES_CONTRACT, 550, 'B')
  ).rejects.toThrow('calldata mismatch');
  expect(nftHistoryDb.apply).not.toHaveBeenCalled();
});
