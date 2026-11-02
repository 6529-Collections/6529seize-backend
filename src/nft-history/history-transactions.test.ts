import { Alchemy } from '@/alchemy-sdk';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { MEMES_CONTRACT, MEMELAB_CONTRACT } from '@/constants';
import { discoverHistoryTransactions } from './history-transactions';

jest.mock('@/alchemy-sdk', () => ({
  ...jest.requireActual('@/alchemy-sdk'),
  Alchemy: jest.fn()
}));
jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
it('discovers all-sender creator events and paginates calls to creators without any fromAddress filter', async () => {
  const transfer = { hash: '0xtx' };
  const getAssetTransfers = jest
    .fn()
    .mockResolvedValueOnce({ transfers: [transfer], pageKey: 'next' })
    .mockResolvedValueOnce({ transfers: [transfer] })
    .mockResolvedValueOnce({ transfers: [] });
  jest
    .mocked(Alchemy)
    .mockImplementation(
      () => ({ core: { getAssetTransfers } }) as unknown as Alchemy
    );
  const rpc = {
    getLogs: jest.fn().mockResolvedValue([]),
    getTransaction: jest.fn().mockResolvedValue({
      hash: '0xtx',
      to: MEMES_CONTRACT,
      from: 'any-wallet',
      blockNumber: 10,
      index: 2
    })
  };
  jest
    .mocked(getEthereumRpcClient)
    .mockReturnValue(rpc as unknown as ReturnType<typeof getEthereumRpcClient>);
  const result = await discoverHistoryTransactions(1, 20, true);
  expect(result).toEqual([
    { hash: '0xtx', block: 10, transactionIndex: 2, logs: [] }
  ]);
  expect(getAssetTransfers).toHaveBeenCalledTimes(3);
  for (const [request] of getAssetTransfers.mock.calls)
    expect(request).not.toHaveProperty('fromAddress');
  expect(
    getAssetTransfers.mock.calls.map(([request]) => request.toAddress)
  ).toEqual([MEMES_CONTRACT, MEMES_CONTRACT, MEMELAB_CONTRACT]);
  expect(rpc.getLogs.mock.calls[2][0]).not.toHaveProperty('address');
});

it('bounds normal claim discovery to verified emitters so forged outside logs cannot stop ingestion', async () => {
  const getAssetTransfers = jest.fn().mockResolvedValue({ transfers: [] });
  jest
    .mocked(Alchemy)
    .mockImplementation(
      () => ({ core: { getAssetTransfers } }) as unknown as Alchemy
    );
  const rpc = { getLogs: jest.fn().mockResolvedValue([]) };
  jest
    .mocked(getEthereumRpcClient)
    .mockReturnValue(rpc as unknown as ReturnType<typeof getEthereumRpcClient>);
  await discoverHistoryTransactions(1, 20);
  expect(rpc.getLogs.mock.calls[2][0]).toHaveProperty('address');
  expect(rpc.getLogs.mock.calls[2][0]).not.toHaveProperty('fromAddress');
});

it.each([{ transfers: [] }, { transfers: [{ hash: '0xtx' }] }])(
  'stops discovery when the budget expires during pagination: %j',
  async ({ transfers }) => {
    let remaining = 900000;
    const getAssetTransfers = jest.fn(() => {
      remaining = 0;
      return Promise.resolve({ transfers, pageKey: 'a-fresh-cursor' });
    });
    jest
      .mocked(Alchemy)
      .mockImplementation(
        () => ({ core: { getAssetTransfers } }) as unknown as Alchemy
      );
    const rpc = {
      getLogs: jest.fn().mockResolvedValue([]),
      getTransaction: jest.fn()
    };
    jest
      .mocked(getEthereumRpcClient)
      .mockReturnValue(
        rpc as unknown as ReturnType<typeof getEthereumRpcClient>
      );
    await expect(
      discoverHistoryTransactions(1, 20, false, () => remaining)
    ).rejects.toThrow('History discovery time budget exhausted');
    expect(getAssetTransfers).toHaveBeenCalledTimes(1);
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  }
);
