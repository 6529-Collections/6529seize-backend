import { Interface, JsonRpcProvider, Transaction, ZeroAddress } from 'ethers';
import {
  RecoveryChain,
  verifyRecoveryMints,
  validateRecoveryTransaction
} from '@/drop-forge/drop-forge.recovery-chain';
import { encodeLaunchAction, claimAbi } from '@/drop-forge/drop-forge.chain';
import { originalRecovery } from '@/drop-forge/drop-forge.recovery';
import { LaunchRpcUnavailableError } from '@/drop-forge/drop-forge.types';
import {
  testConfig,
  testLaunchData,
  testWallet
} from '@/drop-forge/drop-forge.test-fixtures';
const events = new Interface([
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'
]);
function setup() {
  const data = testLaunchData();
  const action = data.actions[1];
  const phase = data.phases[action.phase];
  const claim = [
    1,
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
  const logs = () => [
    {
      address: data.contract,
      ...events.encodeEventLog(events.getEvent('TransferSingle')!, [
        data.proxy,
        ZeroAddress,
        action.recipients[0].address,
        data.claim_id,
        1
      ])
    }
  ];
  let finalized = 99;
  let canonical = 'block';
  const receipt = {
    status: 1,
    blockNumber: 100,
    blockHash: 'block',
    confirmations: async () => 12,
    logs: logs()
  };
  const provider = {
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: BigInt(100),
      maxPriorityFeePerGas: BigInt(1)
    }),
    getCode: jest.fn().mockResolvedValue('0x'),
    getBalance: jest.fn().mockResolvedValue(testConfig.maxCost),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getBlock: jest.fn(async (tag: number | string) =>
      tag === 'finalized'
        ? { number: finalized, hash: 'final' }
        : { number: 100, hash: canonical }
    ),
    call: jest
      .fn()
      .mockResolvedValue(claimAbi.encodeFunctionResult('getClaim', [claim]))
  };
  const chain = new RecoveryChain(
    testConfig,
    provider as unknown as JsonRpcProvider
  );
  const start = async () => {
    action.signed_tx = await testWallet.signTransaction({
      type: 2,
      to: data.proxy,
      data: encodeLaunchAction(data, action),
      nonce: 7,
      chainId: data.chain_id,
      value: BigInt(0),
      gasLimit: BigInt(50000),
      maxFeePerGas: BigInt(80),
      maxPriorityFeePerGas: BigInt(2)
    });
    action.hash = Transaction.from(action.signed_tx).hash!;
    action.recovery = originalRecovery(action);
  };
  return {
    data,
    action,
    chain,
    provider,
    receipt,
    logs,
    start,
    finalize: () => {
      finalized = 100;
    },
    reorg: () => {
      canonical = 'replacement-block';
    }
  };
}

it('preserves the exact ETH recipient/value for payment speed-up and sends zero for cancellation', async () => {
  const f = setup();
  f.action.kind = 'PAY_ARTIST';
  f.action.payment = {
    recipient: '0x' + '77'.repeat(20),
    amount_wei: '1000000000000000',
    paid_count: 1,
    subscriptions_count: 0
  };
  f.action.signed_tx = await testWallet.signTransaction({
    type: 2,
    to: f.action.payment.recipient,
    value: BigInt(f.action.payment.amount_wei),
    data: '0x',
    nonce: 7,
    chainId: f.data.chain_id,
    gasLimit: 21000,
    maxFeePerGas: 80,
    maxPriorityFeePerGas: 2
  });
  f.action.hash = Transaction.from(f.action.signed_tx).hash!;
  f.action.recovery = originalRecovery(f.action);
  const speed = Transaction.from(
    await f.chain.prepare(f.data, f.action, 'SPEED_UP')
  );
  expect(speed.value).toBe(BigInt(f.action.payment.amount_wei));
  expect(speed.to!.toLowerCase()).toBe(
    f.action.payment.recipient.toLowerCase()
  );
  expect(speed.nonce).toBe(7);
  const cancel = Transaction.from(
    await f.chain.prepare(f.data, f.action, 'CANCEL')
  );
  expect(cancel.value).toBe(BigInt(0));
  expect(cancel.to!.toLowerCase()).toBe(f.data.signer.toLowerCase());
  expect(cancel.nonce).toBe(7);
  const raw = await testWallet.signTransaction(speed);
  expect(() =>
    validateRecoveryTransaction(f.data, f.action, {
      id: 'payment-speed',
      operation: 'SPEED_UP',
      requested_by: 'admin',
      requested_at: 0,
      hash: Transaction.from(raw).hash!,
      signed_tx: raw
    })
  ).not.toThrow();
  const changed = await testWallet.signTransaction({
    ...speed.toJSON(),
    value: BigInt(1)
  });
  expect(() =>
    validateRecoveryTransaction(f.data, f.action, {
      id: 'bad-payment',
      operation: 'SPEED_UP',
      requested_by: 'admin',
      requested_at: 0,
      hash: Transaction.from(changed).hash!,
      signed_tx: changed
    })
  ).toThrow('differs');
});
it('bumps both fees above every tracked attempt and preserves original nonce/calldata', async () => {
  const f = setup();
  await f.start();
  const raw = await f.chain.prepare(f.data, f.action, 'SPEED_UP');
  const tx = Transaction.from(raw);
  expect(tx.nonce).toBe(7);
  expect(tx.data).toBe(encodeLaunchAction(f.data, f.action));
  expect(tx.maxFeePerGas).toBe(BigInt(101));
  expect(tx.maxPriorityFeePerGas).toBe(BigInt(3));
  const cancelled = Transaction.from(
    await f.chain.prepare(f.data, f.action, 'CANCEL')
  );
  expect(cancelled.to).toBe(testWallet.address);
  expect(cancelled.data).toBe('0x');
  expect(cancelled.value).toBe(BigInt(0));
});
it('enforces recovery gas budgets and funding', async () => {
  const f = setup();
  await f.start();
  f.provider.getBalance.mockResolvedValue(BigInt(0));
  await expect(f.chain.prepare(f.data, f.action, 'CANCEL')).rejects.toThrow(
    'insufficient'
  );
  f.provider.getFeeData.mockResolvedValue({
    maxFeePerGas: testConfig.maxFee + BigInt(1),
    maxPriorityFeePerGas: BigInt(1)
  });
  await expect(f.chain.prepare(f.data, f.action, 'CANCEL')).rejects.toThrow(
    'budget'
  );
});
it('requires canonical finality and exact mint evidence; reads supply at the winning block', async () => {
  const f = setup();
  await f.start();
  const attempt = f.action.recovery!.attempts[0];
  expect((await f.chain.evidence(f.data, f.action, attempt))!.finalized).toBe(
    false
  );
  f.finalize();
  expect((await f.chain.evidence(f.data, f.action, attempt))!.total).toBe(1);
  expect(f.provider.call).toHaveBeenCalledWith(
    expect.objectContaining({ blockTag: 100 })
  );
  f.reorg();
  expect(await f.chain.evidence(f.data, f.action, attempt)).toBeNull();
});
it.each([1, 2])(
  'retries an unavailable receipt block at canonical read %i',
  async (read) => {
    const f = setup();
    await f.start();
    f.finalize();
    const getBlock = jest.spyOn(
      f.provider as unknown as JsonRpcProvider,
      'getBlock'
    );
    if (read === 2) {
      getBlock.mockResolvedValueOnce({ hash: 'block', number: 100 } as Awaited<
        ReturnType<JsonRpcProvider['getBlock']>
      >);
      getBlock.mockResolvedValueOnce({ hash: 'final', number: 100 } as Awaited<
        ReturnType<JsonRpcProvider['getBlock']>
      >);
    }
    getBlock.mockResolvedValueOnce(null);
    const attempt = f.action.recovery!.attempts[0];
    await expect(
      f.chain.evidence(f.data, f.action, attempt)
    ).rejects.toBeInstanceOf(LaunchRpcUnavailableError);
    expect(await f.chain.evidence(f.data, f.action, attempt)).toMatchObject({
      finalized: true,
      total: 1
    });
  }
);
it('rejects equal total supply credited to the wrong recipient or a non-mint transfer', () => {
  const f = setup();
  expect(() => verifyRecoveryMints(f.data, f.action, f.logs())).not.toThrow();
  const wrong = [
    {
      address: f.data.contract,
      ...events.encodeEventLog(events.getEvent('TransferSingle')!, [
        f.data.proxy,
        ZeroAddress,
        testWallet.address,
        1,
        1
      ])
    }
  ];
  expect(() => verifyRecoveryMints(f.data, f.action, wrong)).toThrow(
    'allocations'
  );
  const transferred = [
    {
      address: f.data.contract,
      ...events.encodeEventLog(events.getEvent('TransferSingle')!, [
        f.data.proxy,
        testWallet.address,
        f.action.recipients[0].address,
        1,
        1
      ])
    }
  ];
  expect(() => verifyRecoveryMints(f.data, f.action, transferred)).toThrow(
    'allocations'
  );
});
it('counts batch mint events and rejects extra or missing quantities', () => {
  const f = setup();
  const make = (amount: number) => [
    {
      address: f.data.contract,
      ...events.encodeEventLog(events.getEvent('TransferBatch')!, [
        f.data.proxy,
        ZeroAddress,
        f.action.recipients[0].address,
        [1],
        [amount]
      ])
    }
  ];
  expect(() => verifyRecoveryMints(f.data, f.action, make(1))).not.toThrow();
  expect(() => verifyRecoveryMints(f.data, f.action, make(2))).toThrow(
    'allocations'
  );
  expect(() => verifyRecoveryMints(f.data, f.action, [])).toThrow(
    'allocations'
  );
});
it('rejects changed nonce, recipient quantities and mismatched raw/hash evidence', async () => {
  const f = setup();
  await f.start();
  const attempt = f.action.recovery!.attempts[0];
  expect(() =>
    validateRecoveryTransaction(f.data, f.action, { ...attempt, hash: 'wrong' })
  ).toThrow('reserved');
  f.action.recipients[0].amount = 2;
  const changedRaw = await testWallet.signTransaction({
    type: 2,
    to: f.data.proxy,
    data: encodeLaunchAction(f.data, f.action),
    nonce: 7,
    chainId: f.data.chain_id,
    value: BigInt(0),
    gasLimit: BigInt(50000),
    maxFeePerGas: BigInt(120),
    maxPriorityFeePerGas: BigInt(3)
  });
  expect(() =>
    validateRecoveryTransaction(f.data, f.action, {
      ...attempt,
      signed_tx: changedRaw,
      hash: Transaction.from(changedRaw).hash!
    })
  ).toThrow('reserved');
});
