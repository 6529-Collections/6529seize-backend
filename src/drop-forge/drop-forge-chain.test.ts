import { Interface, JsonRpcProvider, Transaction, ZeroAddress } from 'ethers';
import { claimAbi, EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import { LaunchRpcUnavailableError } from '@/drop-forge/drop-forge.types';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';

describe('Drop Forge transaction boundary', () => {
  function setup() {
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(100),
      call: jest
        .fn()
        .mockResolvedValue(claimAbi.getError('ClaimNotInitialized')!.selector),
      getTransactionCount: jest.fn().mockResolvedValue(0),
      getTransactionReceipt: jest.fn().mockResolvedValue(null),
      getFeeData: jest.fn().mockResolvedValue({
        maxFeePerGas: BigInt(100),
        maxPriorityFeePerGas: BigInt(1)
      }),
      estimateGas: jest.fn().mockResolvedValue(BigInt(50000)),
      getBalance: jest.fn().mockResolvedValue(testConfig.maxCost),
      getBlock: jest
        .fn()
        .mockResolvedValue({ timestamp: Math.floor(Date.now() / 1000) })
    };
    const chain = new EthereumLaunchChain(
      testConfig,
      provider as unknown as JsonRpcProvider
    );
    jest.spyOn(chain, 'verify').mockResolvedValue();
    return { chain, provider };
  }
  it('restricts signing intent to the pinned proxy, chain, zero ETH value and gas budgets', async () => {
    const { chain, provider } = setup();
    const data = testLaunchData();
    const tx = Transaction.from(await chain.prepare(data, data.actions[0]));
    expect(tx.chainId).toBe(BigInt(testConfig.chainId));
    expect(tx.to?.toLowerCase()).toBe(testConfig.proxy);
    expect(tx.value).toBe(BigInt(0));
    expect(tx.gasLimit).toBe(BigInt(60000));
    expect(
      claimAbi.decodeFunctionData('initializeClaim', tx.data)[2].erc20
    ).toBe(ZeroAddress);
    expect(provider.estimateGas.mock.calls[0][0].from).toBe(testConfig.signer);
  });
  it('refuses untracked pending nonces, unaffordable gas, and fee caps before signing', async () => {
    const { chain, provider } = setup();
    const data = testLaunchData();
    provider.getTransactionCount.mockImplementation((_: string, tag: string) =>
      Promise.resolve(tag === 'pending' ? 1 : 0)
    );
    await expect(chain.prepare(data, data.actions[0])).rejects.toThrow(
      'untracked'
    );
    provider.getTransactionCount.mockResolvedValue(0);
    provider.estimateGas.mockRejectedValueOnce(
      Object.assign(new Error('provider gas allowance'), {
        code: 'INSUFFICIENT_FUNDS'
      })
    );
    await expect(chain.prepare(data, data.actions[0])).rejects.toThrow(
      'insufficient gas funds'
    );
    provider.getBalance.mockResolvedValue(BigInt(0));
    await expect(chain.prepare(data, data.actions[0])).rejects.toThrow(
      'insufficient'
    );
    provider.getFeeData.mockResolvedValue({
      maxFeePerGas: testConfig.maxFee + BigInt(1),
      maxPriorityFeePerGas: BigInt(1)
    });
    await expect(chain.prepare(data, data.actions[0])).rejects.toThrow(
      'fee exceeds'
    );
  });
  it('checks runtime binding and creator permission before inspecting the claim', async () => {
    const { chain, provider } = setup();
    jest.restoreAllMocks();
    const data = testLaunchData();
    await expect(
      chain.verify({ ...data, receiver: testConfig.signer }, data.actions[0])
    ).rejects.toThrow('configuration differs');
    provider.call.mockResolvedValue('0x' + '0'.repeat(64));
    await expect(chain.verify(data, data.actions[0])).rejects.toThrow(
      'lacks creator-admin'
    );
  });
  it('allows only the recognized uninitialized response and preserves unexpected RPC reverts', async () => {
    const { chain, provider } = setup();
    jest.restoreAllMocks();
    const data = testLaunchData();
    const rejected = Object.assign(new Error('Claim not initialized'), {
      code: 'CALL_EXCEPTION',
      data: claimAbi.getError('ClaimNotInitialized')!.selector
    });
    provider.call.mockImplementation(({ data: calldata }: { data: string }) =>
      calldata.startsWith(claimAbi.getFunction('getClaim')!.selector)
        ? Promise.reject(rejected)
        : Promise.resolve('0x' + '0'.repeat(63) + '1')
    );
    await expect(chain.verify(data, data.actions[0])).resolves.toBeUndefined();
    rejected.data = '0xdeadbeef';
    await expect(chain.verify(data, data.actions[0])).rejects.toBe(rejected);
  });
  it('rejects a receipt from a block removed by a reorg', async () => {
    const { chain, provider } = setup();
    const confirmations = jest.fn().mockResolvedValue(12);
    provider.getTransactionReceipt.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: 'old-block',
      confirmations
    });
    provider.getBlock.mockResolvedValue({
      timestamp: Math.floor(Date.now() / 1000),
      hash: 'new-block'
    });
    expect(await chain.receipt('tx')).toBeNull();
    expect(confirmations).not.toHaveBeenCalled();
    provider.getBlock.mockResolvedValue({
      timestamp: Math.floor(Date.now() / 1000),
      hash: 'old-block'
    });
    expect(await chain.receipt('tx')).toEqual({
      status: 1,
      blockNumber: 100,
      blockHash: 'old-block',
      confirmations: 12
    });
  });
  it.each([null, { hash: null }])(
    'retries unavailable receipt blocks without reporting a reorg: %j',
    async (block) => {
      const { chain, provider } = setup();
      const confirmations = jest.fn().mockResolvedValue(12);
      provider.getTransactionReceipt.mockResolvedValue({
        status: 1,
        blockNumber: 100,
        blockHash: 'canonical',
        confirmations
      });
      provider.getBlock.mockResolvedValueOnce(block);
      await expect(chain.receipt('tx')).rejects.toBeInstanceOf(
        LaunchRpcUnavailableError
      );
      expect(confirmations).not.toHaveBeenCalled();
      provider.getBlock.mockResolvedValue({ hash: 'canonical' });
      expect(await chain.receipt('tx')).toMatchObject({
        blockHash: 'canonical',
        confirmations: 12
      });
    }
  );
  it('requires exactly the previously confirmed batch supply before the next airdrop', async () => {
    const { chain, provider } = setup();
    jest.restoreAllMocks();
    const data = testLaunchData();
    const phase = data.phases[0];
    const first = data.actions[1];
    const second = { ...first, id: 'airdrop-2', state: 'PENDING' as const };
    first.state = 'CONFIRMED';
    data.actions.splice(2, 0, second);
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
    provider.call.mockImplementation(({ data: calldata }: { data: string }) =>
      Promise.resolve(
        calldata.startsWith(claimAbi.getFunction('getClaim')!.selector)
          ? claimAbi.encodeFunctionResult('getClaim', [claim])
          : '0x' + '0'.repeat(63) + '1'
      )
    );
    await expect(chain.verify(data, second)).resolves.toBeUndefined();
    claim[0] = 2;
    await expect(chain.verify(data, second)).rejects.toThrow('supply changed');
    claim[0] = 0;
    await expect(chain.verify(data, second)).rejects.toThrow('supply changed');
  });
  it('snapshots legitimate preceding-phase mints and rejects changes after reservation or between phase batches', async () => {
    const { chain, provider } = setup();
    jest.restoreAllMocks();
    jest.spyOn(chain, 'now').mockResolvedValue(5100);
    const data = testLaunchData();
    const previous = data.phases[0];
    const update = data.actions[2];
    const batch = {
      ...data.actions[1],
      id: 'phase-1-airdrop-0',
      phase: 1,
      due: update.due,
      deadline: update.deadline
    };
    data.actions.push(batch);
    const claim = [
      35,
      data.edition_size,
      0,
      previous.start,
      previous.end,
      2,
      previous.root,
      data.metadata,
      data.claim_id,
      previous.price_wei,
      data.receiver,
      ZeroAddress,
      ZeroAddress
    ];
    provider.call.mockImplementation(({ data: calldata }: { data: string }) =>
      Promise.resolve(
        calldata.startsWith(claimAbi.getFunction('getClaim')!.selector)
          ? claimAbi.encodeFunctionResult('getClaim', [claim])
          : '0x' + '0'.repeat(63) + '1'
      )
    );
    await chain.prepare(data, update);
    expect(update.expected_supply).toBe(35);
    update.state = 'RESERVED';
    claim[0] = 36;
    await expect(chain.verify(data, update)).rejects.toThrow('supply changed');
    claim[0] = 35;
    await expect(chain.verify(data, update)).resolves.toBeUndefined();
    update.state = 'CONFIRMED';
    claim[3] = data.phases[1].start;
    claim[4] = data.phases[1].end;
    claim[6] = data.phases[1].root;
    await chain.prepare(data, batch);
    expect(batch.expected_supply).toBe(35);
    batch.state = 'CONFIRMED';
    const second = {
      ...batch,
      id: 'phase-1-airdrop-1',
      state: 'PENDING' as const,
      expected_supply: undefined
    };
    data.actions.push(second);
    claim[0] = 36;
    await expect(chain.verify(data, second)).resolves.toBeUndefined();
    claim[0] = 37;
    await expect(chain.verify(data, second)).rejects.toThrow('supply changed');
  });
  it('does not reserve an update while the previous window is live or a batch after its mint window starts', async () => {
    const { chain, provider } = setup();
    jest.restoreAllMocks();
    const data = testLaunchData();
    const phase = data.phases[0];
    const claim = [
      0,
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
    provider.call.mockImplementation(({ data: calldata }: { data: string }) =>
      Promise.resolve(
        calldata.startsWith(claimAbi.getFunction('getClaim')!.selector)
          ? claimAbi.encodeFunctionResult('getClaim', [claim])
          : '0x' + '0'.repeat(63) + '1'
      )
    );
    jest.spyOn(chain, 'now').mockResolvedValue(phase.end);
    await expect(chain.prepare(data, data.actions[2])).rejects.toThrow(
      'closed minting gap'
    );
    jest.spyOn(chain, 'now').mockResolvedValue(phase.start);
    await expect(chain.prepare(data, data.actions[1])).rejects.toThrow(
      'closed minting gap'
    );
  });
  it('checks edition headroom against legitimate mints before the next phase airdrops', async () => {
    const { chain, provider } = setup();
    jest.restoreAllMocks();
    const data = testLaunchData();
    const phase = data.phases[0];
    data.actions.push({ ...data.actions[1], phase: 1, id: 'next-airdrop' });
    const claim = [
      100,
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
    provider.call.mockImplementation(({ data: calldata }: { data: string }) =>
      Promise.resolve(
        calldata.startsWith(claimAbi.getFunction('getClaim')!.selector)
          ? claimAbi.encodeFunctionResult('getClaim', [claim])
          : '0x' + '0'.repeat(63) + '1'
      )
    );
    await expect(chain.prepare(data, data.actions[2])).rejects.toThrow(
      'available edition'
    );
  });
  it('rejects initialization adoption and a token ID different from the prepared card', async () => {
    const { chain, provider } = setup();
    jest.restoreAllMocks();
    const data = testLaunchData();
    const phase = data.phases[0];
    const claim = [
      0,
      data.edition_size,
      0,
      phase.start,
      phase.end,
      2,
      phase.root,
      data.metadata,
      data.claim_id + 1,
      phase.price_wei,
      data.receiver,
      ZeroAddress,
      ZeroAddress
    ];
    provider.call.mockImplementation(({ data: calldata }: { data: string }) =>
      Promise.resolve(
        calldata.startsWith(claimAbi.getFunction('getClaim')!.selector)
          ? claimAbi.encodeFunctionResult('getClaim', [claim])
          : '0x' + '0'.repeat(63) + '1'
      )
    );
    await expect(chain.verify(data, data.actions[0])).rejects.toThrow(
      'already initialized'
    );
    await expect(chain.verify(data, data.actions[1])).rejects.toThrow(
      'configuration changed'
    );
    claim[8] = data.claim_id;
    await expect(chain.verify(data, data.actions[1])).resolves.toBeUndefined();
  });
});

describe('Drop Forge metadata and manual observation', () => {
  function setup() {
    const data = testLaunchData();
    const phase = data.phases[0];
    const tuple = [
      0,
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
      call: jest
        .fn()
        .mockImplementation(({ data: calldata }: { data: string }) =>
          Promise.resolve(
            calldata.startsWith(claimAbi.getFunction('getClaim')!.selector)
              ? claimAbi.encodeFunctionResult('getClaim', [tuple])
              : '0x' + '0'.repeat(63) + '1'
          )
        ),
      getTransactionCount: jest.fn().mockResolvedValue(0),
      getFeeData: jest.fn().mockResolvedValue({
        maxFeePerGas: BigInt(100),
        maxPriorityFeePerGas: BigInt(1)
      }),
      estimateGas: jest.fn().mockResolvedValue(BigInt(50000)),
      getBalance: jest.fn().mockResolvedValue(testConfig.maxCost)
    };
    const chain = new EthereumLaunchChain(
      testConfig,
      provider as unknown as JsonRpcProvider
    );
    return { data, tuple, provider, chain };
  }
  it('recognizes a matching manual initialization without sending another initialize call', async () => {
    const { chain, data, provider } = setup();
    expect(await chain.completed(data, data.actions[0])).toEqual(
      expect.objectContaining({ total: 0 })
    );
    expect(provider.call).toHaveBeenCalledWith(
      expect.objectContaining({ blockTag: 89 })
    );
  });
  it('advances a compatible earlier configuration when an intermediate scheduled group was missed', async () => {
    const { chain, data } = setup();
    data.phases.push({
      ...data.phases[1],
      name: 'Later',
      start: 8000,
      end: 9000
    });
    const action = { ...data.actions[2], phase: 2, due: 7001, deadline: 8000 };
    jest.spyOn(chain, 'now').mockResolvedValue(7001);
    await expect(chain.verify(data, action, true)).resolves.toBeUndefined();
    expect(action.airdrop_baseline).toBe(0);
  });
  it('skips a matching manual metadata update against the current phase when an earlier group was missed', async () => {
    const { chain, data, tuple } = setup();
    const phase = data.phases[1];
    tuple[0] = 35;
    tuple[3] = phase.start;
    tuple[4] = phase.end;
    tuple[6] = phase.root;
    tuple[7] = 'new-metadata';
    const action = {
      ...data.actions[0],
      kind: 'METADATA' as const,
      target_metadata: 'new-metadata'
    };
    await expect(chain.completed(data, action)).resolves.toEqual({ total: 35 });
    expect(action.phase).toBe(1);
  });
  it('encodes metadata updates with the current mint window, root, receiver and cost preserved', async () => {
    const { chain, data, tuple } = setup();
    tuple[0] = 35;
    const action = {
      ...data.actions[0],
      id: 'metadata',
      kind: 'METADATA' as const,
      target_metadata: 'new-metadata'
    };
    const tx = Transaction.from(await chain.prepare(data, action));
    const args = claimAbi.decodeFunctionData('updateClaim', tx.data)[2];
    expect(args.location).toBe('new-metadata');
    expect(args.startDate.toString()).toBe(String(tuple[3]));
    expect(args.endDate.toString()).toBe(String(tuple[4]));
    expect(args.merkleRoot).toBe(tuple[6]);
    expect(args.paymentReceiver.toLowerCase()).toBe(data.receiver);
    expect(args.cost.toString()).toBe('100');
  });
});

it('reconstructs signed EIP-1559 recovery evidence from an RPC response without substituting its effective gas price', async () => {
  const { testWallet } = await import('@/drop-forge/drop-forge.test-fixtures');
  const raw = await testWallet.signTransaction({
    type: 2,
    chainId: 11155111,
    nonce: 7,
    to: testConfig.proxy,
    data: '0x',
    value: BigInt(0),
    gasLimit: BigInt(21000),
    maxFeePerGas: BigInt(100),
    maxPriorityFeePerGas: BigInt(2)
  });
  const tx = Transaction.from(raw);
  const provider = {
    getBlockNumber: jest.fn().mockResolvedValue(100),
    getTransaction: jest.fn().mockResolvedValue({
      type: tx.type,
      to: tx.to,
      chainId: tx.chainId,
      nonce: tx.nonce,
      value: tx.value,
      data: tx.data,
      gasLimit: tx.gasLimit,
      gasPrice: BigInt(5),
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      accessList: tx.accessList,
      signature: tx.signature
    })
  };
  const chain = new EthereumLaunchChain(
    testConfig,
    provider as unknown as JsonRpcProvider
  );
  expect(await chain.inspectRecovery(tx.hash!)).toBe(raw);
});

it('credits manual airdrops only when canonical mint events match every recipient and amount', async () => {
  const data = testLaunchData();
  const recipients = data.actions[1].recipients;
  const logs: Array<{ address: string; topics: string[]; data: string }> = [];
  const receipt = {
    status: 1,
    blockNumber: 10,
    blockHash: 'canonical',
    logs,
    confirmations: jest.fn().mockResolvedValue(12)
  };
  const provider = {
    getTransaction: jest.fn().mockResolvedValue({
      chainId: BigInt(data.chain_id),
      to: data.proxy,
      from: data.signer,
      value: BigInt(0),
      data: claimAbi.encodeFunctionData('airdrop', [
        data.contract,
        data.claim_id,
        recipients.map((row) => row.address),
        recipients.map((row) => row.amount)
      ])
    }),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getBlock: jest.fn().mockResolvedValue({ hash: 'canonical' })
  };
  const chain = new EthereumLaunchChain(
    testConfig,
    provider as unknown as JsonRpcProvider
  );
  await expect(
    chain.inspectTransaction(data.contract, data.claim_id, 'manual')
  ).rejects.toThrow('mint events');
  const events = new Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)'
  ]);
  const event = events.encodeEventLog('TransferSingle', [
    data.signer,
    ZeroAddress,
    recipients[0].address,
    data.claim_id,
    recipients[0].amount
  ]);
  logs.push({ address: data.contract, ...event });
  await expect(
    chain.inspectTransaction(data.contract, data.claim_id, 'manual')
  ).resolves.toEqual(
    expect.objectContaining({ receipt: expect.objectContaining({ status: 1 }) })
  );
});
