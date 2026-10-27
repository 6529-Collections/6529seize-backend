import { Interface, JsonRpcProvider, Transaction, ZeroAddress } from 'ethers';
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
  data.actions
    .filter((it) => it.kind === 'AIRDROP' && !isResearchAirdrop(it))
    .forEach((it) => {
      it.state = 'CONFIRMED';
    });
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
  jest.spyOn(chain, 'now').mockResolvedValue(action.due);
  jest
    .spyOn(chain, 'verifiedSupply')
    .mockImplementation(async (_data, current) => {
      const evidence = {
        status: 'VERIFIED' as const,
        checked_at: 1,
        block_number: 100,
        rpc_total: Number(tuple[0]),
        db_total: Number(tuple[0])
      };
      if (current) current.supply_evidence = evidence;
      return evidence;
    });
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
  await expect(chain.completed(data, action)).rejects.toThrow('one hour');
  await expect(chain.prepare(data, action)).rejects.toThrow('one hour');
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

it('keeps Research from consuming supply owed to outstanding phase allocations', async () => {
  const { data, action, chain } = setup();
  data.actions[1].state = 'PENDING';
  await expect(chain.completed(data, action)).rejects.toThrow(
    'outstanding subscriber'
  );
});

it('never treats a high RPC total as completed when shared DB verification fails', async () => {
  const f = setup(305, 305);
  jest
    .spyOn(f.chain, 'verifiedSupply')
    .mockRejectedValue(new Error('database mismatch'));
  await expect(f.chain.completed(f.data, f.action)).rejects.toThrow(
    'database mismatch'
  );
  expect(f.provider.estimateGas).not.toHaveBeenCalled();
});

it('checks exact Research receipt allocations and finalized indexed supply before settlement', async () => {
  const { chain, data, action, tuple, provider } = setup();
  await chain.prepare(data, action);
  tuple[0] = 305;
  const receipt = {
    status: 1,
    blockHash: 'block',
    blockNumber: 101,
    confirmations: 12
  };
  const events = new Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)'
  ]);
  const log = (recipient: string) => ({
    address: data.contract,
    ...events.encodeEventLog('TransferSingle', [
      data.proxy,
      ZeroAddress,
      recipient,
      data.claim_id,
      18
    ])
  });
  const getTransactionReceipt = jest.fn().mockResolvedValue({
    blockHash: 'block',
    logs: [log(RESEARCH_AIRDROP_ADDRESS)]
  });
  Object.assign(provider, { getTransactionReceipt });
  await expect(
    chain.verifySettlement(data, action, 'hash', receipt)
  ).resolves.toBeUndefined();
  expect(chain.verifiedSupply).toHaveBeenLastCalledWith(data, action, 101);
  getTransactionReceipt.mockResolvedValue({
    blockHash: 'block',
    logs: [log(data.signer)]
  });
  await expect(
    chain.verifySettlement(data, action, 'hash', receipt)
  ).rejects.toThrow('allocations');
  getTransactionReceipt.mockResolvedValue({
    blockHash: 'block',
    logs: [log(RESEARCH_AIRDROP_ADDRESS)]
  });
  tuple[0] = 304;
  await expect(
    chain.verifySettlement(data, action, 'hash', receipt)
  ).rejects.toThrow('expected delivered total');
});

it('requires shared accounting for late Research delivery and speed-up', async () => {
  const { chain, data, action } = setup();
  action.late_delivery = true;
  jest
    .spyOn(chain, 'verifiedSupply')
    .mockRejectedValue(new Error('accounting unavailable'));
  await expect(chain.verify(data, action)).rejects.toThrow(
    'accounting unavailable'
  );
  await expect(chain.prepareRecovery(data, action, 'SPEED_UP')).rejects.toThrow(
    'accounting unavailable'
  );
});
