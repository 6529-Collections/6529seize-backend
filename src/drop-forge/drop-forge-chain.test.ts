import { JsonRpcProvider, Transaction, ZeroAddress } from 'ethers';
import { claimAbi, EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';

describe('Drop Forge transaction boundary', () => {
  function setup() {
    const provider = {
      call: jest
        .fn()
        .mockResolvedValue(claimAbi.getError('ClaimNotInitialized')!.selector),
      getTransactionCount: jest.fn().mockResolvedValue(0),
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
