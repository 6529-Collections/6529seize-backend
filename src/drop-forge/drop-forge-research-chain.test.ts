import { JsonRpcProvider, Transaction, ZeroAddress } from 'ethers';
import { claimAbi, EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
import {
  isResearchAirdrop,
  RESEARCH_AIRDROP_ADDRESS
} from '@/drop-forge/drop-forge.research';

function setup(total = 287, edition = 305) {
  const data = testLaunchData();
  data.edition_size = edition;
  const action = data.actions.find(isResearchAirdrop)!;
  const phase = data.phases[action.phase];
  const tuple = [
    total,
    edition,
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
  jest.spyOn(chain, 'now').mockResolvedValue(action.due);
  return { chain, data, action, tuple, provider };
}
it('prepares exactly eighteen research tokens for a 305 edition with 287 already minted', async () => {
  const { chain, data, action } = setup();
  expect(await chain.completed(data, action)).toBeNull();
  const tx = Transaction.from(await chain.prepare(data, action));
  const args = claimAbi.decodeFunctionData('airdrop', tx.data);
  expect(args[2]).toEqual([RESEARCH_AIRDROP_ADDRESS]);
  expect(args[3]).toEqual([BigInt(18)]);
  action.state = 'RESERVED';
  await expect(chain.verify(data, action)).resolves.toBeUndefined();
});
it.each([
  [305, 305],
  [400, 500]
])(
  'observes target satisfaction without preparing a transaction (total %i, max %i)',
  async (total, edition) => {
    const { chain, data, action, provider } = setup(total, edition);
    expect(await chain.completed(data, action)).toEqual({ total });
    expect(provider.estimateGas).not.toHaveBeenCalled();
  }
);
it('rejects early execution, Craft/max mismatches and changed supply after reservation', async () => {
  const { chain, data, action, tuple } = setup();
  jest.spyOn(chain, 'now').mockResolvedValue(action.due - 1);
  await expect(chain.completed(data, action)).rejects.toThrow(
    'fifteen minutes'
  );
  await expect(chain.prepare(data, action)).rejects.toThrow('fifteen minutes');
  jest.spyOn(chain, 'now').mockResolvedValue(action.due);
  tuple[1] = 310;
  await expect(chain.completed(data, action)).rejects.toThrow(
    'configuration changed'
  );
  await expect(chain.prepare(data, action)).rejects.toThrow(
    'configuration changed'
  );
  tuple[1] = 305;
  await chain.prepare(data, action);
  action.state = 'RESERVED';
  tuple[0] = 288;
  await expect(chain.verify(data, action)).rejects.toThrow('supply changed');
});
