import { Interface, JsonRpcProvider, Transaction, ZeroAddress } from 'ethers';
import { claimAbi, EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import * as payment from '@/drop-forge/drop-forge.payment';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
const recipient = '0x' + '77'.repeat(20);
const adminAbi = new Interface([
  'function isAdmin(address) view returns (bool)'
]);
function setup(cap = BigInt(1000)) {
  const data = testLaunchData();
  const action = data.actions.find((it) => it.kind === 'PAY_ARTIST')!;
  const phase = data.phases.at(-1)!;
  const tuple = [
    10,
    data.edition_size,
    0,
    phase.start,
    phase.end,
    2,
    phase.root,
    data.metadata,
    data.claim_id,
    phase.price_wei,
    data.receiver,
    ZeroAddress,
    ZeroAddress
  ];
  const provider = {
    getBlockNumber: jest.fn().mockResolvedValue(100),
    call: jest.fn(async ({ data: calldata }: { data: string }) =>
      calldata.startsWith(adminAbi.getFunction('isAdmin')!.selector)
        ? adminAbi.encodeFunctionResult('isAdmin', [true])
        : claimAbi.encodeFunctionResult('getClaim', [tuple])
    ),
    getTransactionCount: jest.fn().mockResolvedValue(0),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: BigInt(100),
      maxPriorityFeePerGas: BigInt(1)
    }),
    estimateGas: jest.fn().mockResolvedValue(BigInt(21000)),
    getBalance: jest.fn().mockResolvedValue(testConfig.maxCost),
    getTransaction: jest.fn().mockResolvedValue({
      chainId: BigInt(data.chain_id),
      to: recipient,
      from: data.signer,
      value: BigInt(1000),
      data: '0x'
    })
  };
  const chain = new EthereumLaunchChain(
    { ...testConfig, maxArtistPayment: cap },
    provider as unknown as JsonRpcProvider
  );
  jest.spyOn(chain, 'now').mockResolvedValue(action.due + 60);
  jest.spyOn(payment, 'artistPaymentQuote').mockResolvedValue({
    recipient,
    amount_wei: '1000',
    paid_count: 2,
    subscriptions_count: 0
  });
  return { data, action, provider, chain };
}
afterEach(() => jest.restoreAllMocks());
it('prepares the exact ETH payment with empty calldata and includes principal in its balance check', async () => {
  const f = setup();
  const tx = Transaction.from(await f.chain.prepare(f.data, f.action));
  expect(tx.to!.toLowerCase()).toBe(recipient);
  expect(tx.value).toBe(BigInt(1000));
  expect(tx.data).toBe('0x');
  expect(f.action.payment?.amount_wei).toBe('1000');
  f.provider.getBalance.mockResolvedValue(BigInt(2520000));
  await expect(f.chain.prepare(f.data, f.action)).rejects.toThrow(
    'insufficient'
  );
});
it('refuses an artist payment above its separate cap before gas estimation', async () => {
  const f = setup(BigInt(999));
  await expect(f.chain.prepare(f.data, f.action)).rejects.toThrow(
    'payment limit'
  );
  expect(f.provider.estimateGas).not.toHaveBeenCalled();
});
it('rejects manual transfers with an incorrect value or recipient', async () => {
  const f = setup();
  f.provider.getTransaction.mockResolvedValueOnce({
    chainId: BigInt(f.data.chain_id),
    from: f.data.signer,
    to: recipient,
    value: BigInt(999),
    data: '0x'
  });
  await expect(
    f.chain.inspectPayment(f.data, f.action, 'hash')
  ).rejects.toThrow('exact chain');
  f.provider.getTransaction.mockResolvedValueOnce({
    chainId: BigInt(f.data.chain_id),
    from: f.data.signer,
    to: f.data.signer,
    value: BigInt(1000),
    data: '0x'
  });
  await expect(
    f.chain.inspectPayment(f.data, f.action, 'hash')
  ).rejects.toThrow('exact chain');
});

it('accepts only a direct payment from the authenticated manual wallet', async () => {
  const f = setup();
  await expect(
    f.chain.inspectPaymentSubmission('hash', f.data.signer)
  ).resolves.toBeUndefined();
  await expect(
    f.chain.inspectPaymentSubmission('hash', recipient)
  ).rejects.toThrow('direct ETH transfer');
  f.provider.getTransaction.mockResolvedValueOnce({
    chainId: BigInt(f.data.chain_id),
    from: f.data.signer,
    to: recipient,
    value: BigInt(1000),
    data: '0x1234'
  });
  await expect(
    f.chain.inspectPaymentSubmission('hash', f.data.signer)
  ).rejects.toThrow('direct ETH transfer');
});
