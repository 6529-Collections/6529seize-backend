import {
  concat,
  getAddress,
  Interface,
  keccak256,
  toBeHex,
  zeroPadValue
} from 'ethers';
import { DELEGATIONS_IFACE } from '@/abis/delegations';
import {
  DELEGATION_ALL_ADDRESS,
  DELEGATION_CONTRACT,
  MEMES_CONTRACT,
  NEVER_DATE,
  USE_CASE_CONSOLIDATION,
  USE_CASE_MINTING,
  USE_CASE_SUB_DELEGATION
} from '@/constants';
import {
  fetchDelegationTransaction,
  findDelegationTransactions,
  scanDelegationLogs
} from '@/delegations';
import { runDelegationScopeBackfill } from '@/delegationsLoop/delegation-scope-backfill';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));

const { getEthereumRpcClient: mockGetEthereumRpcClient } = jest.requireMock(
  '@/ethereum-rpc/ethereum-rpc-client'
);

const SAFE = getAddress('0x5afe00000000000000000000000000000000a5fe');
const COLD = getAddress('0xc01d000000000000000000000000000000000c01');
const MANAGER = getAddress('0x3a3a000000000000000000000000000000003a3a');
const HOT_1 = '0x1111111111111111111111111111111111111111';
const HOT_2 = '0x2222222222222222222222222222222222222222';
const HOT_3 = '0x3333333333333333333333333333333333333333';
const GRADIENTS = getAddress('0x0c58ef43ff3032005e472cb5709f8908acb00205');
const ZERO = '0x0000000000000000000000000000000000000000';

const SAFE_IFACE = new Interface([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)'
]);

type StoredEntry = [
  delegate: string,
  expiry: bigint,
  allTokens: boolean,
  tokenId: bigint
];

interface DelegatorState {
  block: number;
  delegator: string;
  collection: string;
  useCase: number;
  // In registration order, as the contract appends them.
  entries: StoredEntry[];
}

const rpcMock = {
  getLogs: jest.fn(),
  getTransaction: jest.fn(),
  getBlockNumber: jest.fn(),
  getBlock: jest.fn(),
  call: jest.fn()
};

// Contract state at the end of each block, per delegator, collection and
// use case.
let contractState: DelegatorState[];

function setState(
  block: number,
  delegator: string,
  collection: string,
  useCase: number,
  entries: StoredEntry[]
) {
  contractState.push({ block, delegator, collection, useCase, entries });
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

// abi.encodePacked(delegator, collection, delegate, useCase), built by hand.
function globalHash(
  delegator: string,
  collection: string,
  delegate: string,
  useCase: number
) {
  return keccak256(
    concat([
      delegator,
      collection,
      delegate,
      zeroPadValue(toBeHex(useCase), 32)
    ])
  );
}

function retrieveDelegationAddresses(blockTag: number, args: any[]) {
  const [delegator, collection, useCase] = args;
  const state = contractState.find(
    (s) =>
      s.block === blockTag &&
      same(s.delegator, delegator) &&
      same(s.collection, collection) &&
      BigInt(s.useCase) === useCase
  );
  return DELEGATIONS_IFACE.encodeFunctionResult('retrieveDelegationAddresses', [
    (state?.entries ?? []).map((e) => e[0])
  ]);
}

function globalDelegationHashes(blockTag: number, args: any[]) {
  const [hash, index] = args;
  for (const state of contractState.filter((s) => s.block === blockTag)) {
    for (const [delegate] of state.entries) {
      if (
        globalHash(
          state.delegator,
          state.collection,
          delegate,
          state.useCase
        ) !== hash
      ) {
        continue;
      }
      const own = state.entries.filter((e) => same(e[0], delegate));
      const stored = own[Number(index)];
      if (!stored) {
        throw new Error('execution reverted');
      }
      return DELEGATIONS_IFACE.encodeFunctionResult('globalDelegationHashes', [
        state.delegator,
        stored[0],
        BigInt(1_700_000_000),
        stored[1],
        stored[2],
        stored[3]
      ]);
    }
  }
  throw new Error('execution reverted');
}

let nextLogIndex = 0;

function log(
  blockNumber: number,
  event: string,
  values: unknown[],
  transactionHash = '0xabc'
) {
  const { data, topics } = DELEGATIONS_IFACE.encodeEventLog(event, values);
  return {
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    transactionIndex: 0,
    transactionHash,
    address: DELEGATION_CONTRACT.contract,
    data,
    topics,
    logIndex: nextLogIndex++,
    removed: false
  };
}

function safeExecTransaction(innerData: string) {
  return SAFE_IFACE.encodeFunctionData('execTransaction', [
    DELEGATION_CONTRACT.contract,
    0,
    innerData,
    0,
    0,
    0,
    0,
    ZERO,
    ZERO,
    '0x'
  ]);
}

function stateCalls() {
  return rpcMock.call.mock.calls.map(
    ([tx, blockTag]) =>
      `${DELEGATIONS_IFACE.parseTransaction({ data: tx.data })?.name}@${blockTag}`
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  nextLogIndex = 0;
  contractState = [];
  mockGetEthereumRpcClient.mockReturnValue(rpcMock);
  rpcMock.getBlock.mockResolvedValue({ timestamp: 123 });
  rpcMock.getBlockNumber.mockResolvedValue(500);
  rpcMock.call.mockImplementation(
    async (tx: { to: string; data: string }, blockTag: number) => {
      expect(tx.to).toBe(DELEGATION_CONTRACT.contract);
      const parsed = DELEGATIONS_IFACE.parseTransaction({ data: tx.data });
      const args = parsed ? Array.from(parsed.args) : [];
      if (parsed?.name === 'retrieveDelegationAddresses') {
        return retrieveDelegationAddresses(blockTag, args);
      }
      if (parsed?.name === 'globalDelegationHashes') {
        return globalDelegationHashes(blockTag, args);
      }
      throw new Error(`Unexpected call ${parsed?.name}`);
    }
  );
});

describe('findDelegationTransactions registration scope', () => {
  it('records expiry and token scope for a Safe-signed registration', async () => {
    const inner = DELEGATIONS_IFACE.encodeFunctionData(
      'registerDelegationAddress',
      [
        MEMES_CONTRACT,
        HOT_1,
        BigInt(1_900_000_000),
        USE_CASE_MINTING,
        false,
        BigInt(42)
      ]
    );
    // The top-level call is the Safe's execTransaction, not the delegation
    // contract, so the transaction input carries none of these values.
    rpcMock.getTransaction.mockResolvedValue({
      to: SAFE,
      data: safeExecTransaction(inner)
    });
    rpcMock.getLogs.mockResolvedValue([
      log(10, 'RegisterDelegation', [
        SAFE,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        false,
        BigInt(42)
      ])
    ]);
    setState(10, SAFE, MEMES_CONTRACT, USE_CASE_MINTING, [
      [HOT_1, BigInt(1_900_000_000), false, BigInt(42)]
    ]);

    const result = await findDelegationTransactions(1, 20);

    expect(result.registrations).toEqual([
      {
        block: 10,
        type: 0,
        wallet1: SAFE,
        wallet2: HOT_1,
        use_case: USE_CASE_MINTING,
        collection: MEMES_CONTRACT,
        expiry: 1_900_000_000,
        all_tokens: false,
        token_id: 42
      }
    ]);
    expect(stateCalls()).toEqual([
      'retrieveDelegationAddresses@10',
      'globalDelegationHashes@10'
    ]);
    expect(rpcMock.getTransaction).not.toHaveBeenCalled();
  });

  it('gives each batchDelegations item its own expiry and token scope', async () => {
    const tx = '0xba7c4';
    rpcMock.getLogs.mockResolvedValue([
      log(
        11,
        'RegisterDelegation',
        [COLD, MEMES_CONTRACT, HOT_1, USE_CASE_MINTING, false, BigInt(7)],
        tx
      ),
      log(
        11,
        'RegisterDelegation',
        [COLD, MEMES_CONTRACT, HOT_1, USE_CASE_MINTING, false, BigInt(8)],
        tx
      ),
      log(
        11,
        'RegisterDelegation',
        [COLD, GRADIENTS, HOT_2, USE_CASE_MINTING, true, BigInt(99)],
        tx
      ),
      log(
        11,
        'RegisterDelegation',
        [COLD, DELEGATION_ALL_ADDRESS, HOT_3, 3, true, BigInt(0)],
        tx
      )
    ]);
    setState(11, COLD, MEMES_CONTRACT, USE_CASE_MINTING, [
      [HOT_2, BigInt(1_000), true, BigInt(0)],
      [HOT_1, BigInt(1_500), true, BigInt(0)],
      [HOT_1, BigInt(1_700_000_000), false, BigInt(7)],
      [HOT_1, BigInt(1_800_000_000), false, BigInt(8)]
    ]);
    setState(11, COLD, GRADIENTS, USE_CASE_MINTING, [
      [HOT_2, BigInt(2_000_000_000), true, BigInt(0)]
    ]);
    setState(11, COLD, DELEGATION_ALL_ADDRESS, 3, [
      [HOT_3, BigInt(64060588800), true, BigInt(0)]
    ]);

    const result = await findDelegationTransactions(1, 20);

    expect(
      result.registrations.map((r) => [
        r.wallet2,
        r.collection,
        r.use_case,
        r.expiry,
        r.all_tokens,
        r.token_id
      ])
    ).toEqual([
      [HOT_1, MEMES_CONTRACT, USE_CASE_MINTING, 1_700_000_000, false, 7],
      [HOT_1, MEMES_CONTRACT, USE_CASE_MINTING, 1_800_000_000, false, 8],
      [HOT_2, GRADIENTS, USE_CASE_MINTING, 2_000_000_000, true, 0],
      [HOT_3, DELEGATION_ALL_ADDRESS, 3, 64060588800, true, 0]
    ]);
    // One delegate-list read per delegator, collection and use case in the
    // block, then one read per registration.
    const calls = stateCalls();
    expect(
      calls.filter((c) => c === 'retrieveDelegationAddresses@11')
    ).toHaveLength(3);
    expect(calls.filter((c) => c === 'globalDelegationHashes@11')).toHaveLength(
      4
    );
    expect(rpcMock.getTransaction).not.toHaveBeenCalled();
  });

  it('records a Delegation Manager registration against the delegator', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(12, 'RegisterDelegationUsingSubDelegation', [
        COLD,
        MANAGER,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        true,
        BigInt(0)
      ])
    ]);
    setState(12, COLD, MEMES_CONTRACT, USE_CASE_MINTING, [
      [HOT_1, BigInt(1_750_000_000), true, BigInt(0)]
    ]);

    const result = await findDelegationTransactions(1, 20);

    expect(result.registrations).toEqual([
      {
        block: 12,
        type: 0,
        wallet1: COLD,
        wallet2: HOT_1,
        use_case: USE_CASE_MINTING,
        collection: MEMES_CONTRACT,
        expiry: 1_750_000_000,
        all_tokens: true,
        token_id: 0
      }
    ]);
  });

  it('leaves sub-delegation and consolidation registrations unchanged', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(13, 'RegisterDelegation', [
        COLD,
        DELEGATION_ALL_ADDRESS,
        MANAGER,
        USE_CASE_SUB_DELEGATION,
        true,
        BigInt(0)
      ]),
      log(13, 'RegisterDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_CONSOLIDATION,
        true,
        BigInt(0)
      ])
    ]);

    const result = await findDelegationTransactions(1, 20);

    expect(result.registrations).toEqual([
      {
        block: 13,
        type: 0,
        wallet1: COLD,
        wallet2: MANAGER,
        use_case: USE_CASE_SUB_DELEGATION,
        collection: DELEGATION_ALL_ADDRESS
      }
    ]);
    expect(result.consolidations).toEqual([
      { block: 13, type: 0, wallet1: COLD, wallet2: HOT_1 }
    ]);
    expect(rpcMock.call).not.toHaveBeenCalled();
  });

  it('drops a registration revoked later in the same block but keeps the revocation', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(14, 'RegisterDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        true,
        BigInt(0)
      ]),
      log(14, 'RevokeDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING
      ])
    ]);

    const result = await findDelegationTransactions(1, 20);

    expect(result.registrations).toEqual([]);
    expect(result.revocation).toEqual([
      {
        block: 14,
        type: 1,
        wallet1: COLD,
        wallet2: HOT_1,
        use_case: USE_CASE_MINTING,
        collection: MEMES_CONTRACT
      }
    ]);
    expect(rpcMock.call).not.toHaveBeenCalled();
  });

  it('skips a token-specific registration whose token id does not fit the column', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(16, 'RegisterDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        false,
        BigInt('1152921504606846977')
      ]),
      log(16, 'RegisterDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_2,
        USE_CASE_MINTING,
        false,
        BigInt(2_147_483_647)
      ])
    ]);
    setState(16, COLD, MEMES_CONTRACT, USE_CASE_MINTING, [
      [HOT_1, BigInt(1_800_000_000), false, BigInt('1152921504606846977')],
      [HOT_2, BigInt(1_900_000_000), false, BigInt(2_147_483_647)]
    ]);

    const result = await findDelegationTransactions(1, 20);

    expect(
      result.registrations.map((r) => [r.wallet2, r.expiry, r.token_id])
    ).toEqual([[HOT_2, 1_900_000_000, 2_147_483_647]]);
  });

  it.each([false, true])(
    'preserves expiry positions with an oversized token for the same delegate (oversized first: %s)',
    async (oversizedFirst) => {
      const entries: StoredEntry[] = [
        [HOT_1, BigInt(1_800_000_000), false, BigInt(42)],
        [HOT_1, BigInt(1_900_000_000), false, BigInt('1152921504606846977')]
      ];
      if (oversizedFirst) entries.reverse();
      rpcMock.getLogs.mockResolvedValue(
        entries.map(([delegate, , allTokens, tokenId]) =>
          log(16, 'RegisterDelegation', [
            COLD,
            MEMES_CONTRACT,
            delegate,
            USE_CASE_MINTING,
            allTokens,
            tokenId
          ])
        )
      );
      setState(16, COLD, MEMES_CONTRACT, USE_CASE_MINTING, entries);

      const result = await findDelegationTransactions(1, 20);
      expect(
        result.registrations.map((r) => [r.wallet2, r.expiry, r.token_id])
      ).toEqual([[HOT_1, 1_800_000_000, 42]]);
    }
  );

  it('drops a manager registration revoked later in its block without reading expiry', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(17, 'RegisterDelegation', [
        COLD,
        DELEGATION_ALL_ADDRESS,
        MANAGER,
        USE_CASE_SUB_DELEGATION,
        true,
        BigInt(0)
      ]),
      log(17, 'RevokeDelegation', [
        COLD,
        DELEGATION_ALL_ADDRESS,
        MANAGER,
        USE_CASE_SUB_DELEGATION
      ])
    ]);
    const result = await findDelegationTransactions(1, 20);
    expect(result.registrations).toEqual([]);
    expect(result.revocation).toHaveLength(1);
    expect(rpcMock.call).not.toHaveBeenCalled();
  });

  it('keeps a manager re-registered after a revocation in the same block', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(17, 'RevokeDelegation', [
        COLD,
        DELEGATION_ALL_ADDRESS,
        MANAGER,
        USE_CASE_SUB_DELEGATION
      ]),
      log(17, 'RegisterDelegation', [
        COLD,
        DELEGATION_ALL_ADDRESS,
        MANAGER,
        USE_CASE_SUB_DELEGATION,
        true,
        BigInt(0)
      ])
    ]);
    const result = await findDelegationTransactions(1, 20);
    expect(result.registrations).toEqual([
      expect.objectContaining({
        wallet1: COLD,
        wallet2: MANAGER,
        use_case: USE_CASE_SUB_DELEGATION
      })
    ]);
    expect(rpcMock.call).not.toHaveBeenCalled();
  });

  it.each([
    [HOT_1, DELEGATION_ALL_ADDRESS, USE_CASE_SUB_DELEGATION],
    [MANAGER, MEMES_CONTRACT, USE_CASE_SUB_DELEGATION],
    [MANAGER, DELEGATION_ALL_ADDRESS, USE_CASE_MINTING]
  ])(
    'keeps a manager registration when an unrelated record is revoked (%s, %s, %s)',
    async (delegate, collection, useCase) => {
      rpcMock.getLogs.mockResolvedValue([
        log(17, 'RegisterDelegation', [
          COLD,
          DELEGATION_ALL_ADDRESS,
          MANAGER,
          USE_CASE_SUB_DELEGATION,
          true,
          BigInt(0)
        ]),
        log(17, 'RevokeDelegation', [COLD, collection, delegate, useCase])
      ]);
      const result = await findDelegationTransactions(1, 20);
      expect(result.registrations).toHaveLength(1);
      expect(result.registrations[0]?.wallet2).toBe(MANAGER);
    }
  );

  it('fails instead of storing defaults when the state read fails', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(15, 'RegisterDelegation', [
        SAFE,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        false,
        BigInt(1)
      ])
    ]);
    rpcMock.call.mockRejectedValue(new Error('missing trie node'));

    await expect(findDelegationTransactions(1, 20)).rejects.toThrow(
      'missing trie node'
    );
  });
});

describe('scope backfill over the real scan', () => {
  const NOW = 1_800_000_000;

  function backfillDeps(rows: Record<string, unknown>[]) {
    return {
      latestProcessedBlock: async () => 40,
      scan: scanDelegationLogs,
      readRows: async () =>
        rows.map((r) => ({
          block: 30,
          from_address: COLD,
          to_address: HOT_1,
          collection: MEMES_CONTRACT,
          use_case: USE_CASE_MINTING,
          expiry: 64060588800,
          all_tokens: true,
          token_id: 0,
          ...r
        })),
      getTransaction: fetchDelegationTransaction,
      applyDiff: jest.fn(async () => undefined),
      nowSeconds: () => NOW
    };
  }

  beforeEach(() => {
    rpcMock.getTransaction.mockResolvedValue({
      to: DELEGATION_CONTRACT.contract,
      data: '0x'
    });
  });

  it('deletes a stale row whose registration was revoked later in its block', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(30, 'RegisterDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        true,
        BigInt(0)
      ]),
      log(30, 'RevokeDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING
      ])
    ]);
    const deps = backfillDeps([{}]);

    const report = await runDelegationScopeBackfill(
      { mode: 'apply', fromBlock: 1 },
      deps
    );

    expect(report.diff.deletes.map((r) => r.block)).toEqual([30]);
    expect(report.causes['revoked-same-block']).toBe(1);
    expect(deps.applyDiff).toHaveBeenCalledTimes(1);
    // The dropped registration needs no state read.
    expect(rpcMock.call).not.toHaveBeenCalled();
  });

  it('keeps a row registered after a revocation in its block', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(30, 'RevokeDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING
      ]),
      log(30, 'RegisterDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        true,
        BigInt(0)
      ])
    ]);
    setState(30, COLD, MEMES_CONTRACT, USE_CASE_MINTING, [
      [HOT_1, BigInt(64060588800), true, BigInt(0)]
    ]);
    const deps = backfillDeps([{}]);

    const report = await runDelegationScopeBackfill(
      { mode: 'apply', fromBlock: 1 },
      deps
    );

    expect(report.diff.unchanged).toBe(1);
    expect(report.diff.deletes).toEqual([]);
    expect(deps.applyDiff).not.toHaveBeenCalled();
  });

  it('removes a stale manager row revoked later in the same block during backfill', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(30, 'RegisterDelegation', [
        COLD,
        DELEGATION_ALL_ADDRESS,
        MANAGER,
        USE_CASE_SUB_DELEGATION,
        true,
        BigInt(0)
      ]),
      log(30, 'RevokeDelegation', [
        COLD,
        DELEGATION_ALL_ADDRESS,
        MANAGER,
        USE_CASE_SUB_DELEGATION
      ])
    ]);
    const deps = backfillDeps([
      {
        to_address: MANAGER,
        collection: DELEGATION_ALL_ADDRESS,
        use_case: USE_CASE_SUB_DELEGATION
      }
    ]);
    const report = await runDelegationScopeBackfill(
      { mode: 'apply', fromBlock: 1 },
      deps
    );
    expect(report.diff.deletes).toEqual([
      expect.objectContaining({
        to_address: MANAGER,
        use_case: USE_CASE_SUB_DELEGATION
      })
    ]);
    expect(report.diff.inserts).toEqual([]);
    expect(deps.applyDiff).toHaveBeenCalledTimes(1);
    expect(rpcMock.call).not.toHaveBeenCalled();
  });

  it('keeps only registrations after a revocation in an earlier-or-later block', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(10, 'RegisterDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        false,
        BigInt(1)
      ]),
      log(15, 'RevokeDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING
      ]),
      log(20, 'RegisterDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        false,
        BigInt(2)
      ])
    ]);
    setState(10, COLD, MEMES_CONTRACT, USE_CASE_MINTING, [
      [HOT_1, BigInt(64060588800), false, BigInt(1)]
    ]);
    setState(20, COLD, MEMES_CONTRACT, USE_CASE_MINTING, [
      [HOT_1, BigInt(64060588800), false, BigInt(2)]
    ]);
    const deps = backfillDeps([
      { block: 10, all_tokens: true, token_id: 1 },
      { block: 20, all_tokens: true, token_id: 2 }
    ]);

    const report = await runDelegationScopeBackfill(
      { mode: 'dry-run', fromBlock: 1 },
      deps
    );

    expect(report.diff.deletes.map((r) => r.block)).toEqual([10]);
    expect(report.diff.updates.map((u) => [u.current.block, u.fields])).toEqual(
      [[20, ['all_tokens']]]
    );
  });
});

describe('an on-chain expiry of 0 means no expiry', () => {
  it('stores never-expiring for a Safe-signed registration with expiry 0', async () => {
    rpcMock.getTransaction.mockResolvedValue({
      to: SAFE,
      data: safeExecTransaction(
        DELEGATIONS_IFACE.encodeFunctionData('registerDelegationAddress', [
          DELEGATION_ALL_ADDRESS,
          HOT_1,
          BigInt(0),
          1,
          true,
          BigInt(0)
        ])
      )
    });
    rpcMock.getLogs.mockResolvedValue([
      log(50, 'RegisterDelegation', [
        SAFE,
        DELEGATION_ALL_ADDRESS,
        HOT_1,
        1,
        true,
        BigInt(0)
      ])
    ]);
    setState(50, SAFE, DELEGATION_ALL_ADDRESS, 1, [
      [HOT_1, BigInt(0), true, BigInt(0)]
    ]);

    const result = await findDelegationTransactions(1, 60);

    expect(result.registrations.map((r) => r.expiry)).toEqual([NEVER_DATE]);
  });

  it('stores never-expiring for a direct registration with expiry 0', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(51, 'RegisterDelegation', [
        COLD,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        false,
        BigInt(4)
      ])
    ]);
    setState(51, COLD, MEMES_CONTRACT, USE_CASE_MINTING, [
      [HOT_1, BigInt(0), false, BigInt(4)]
    ]);

    const result = await findDelegationTransactions(1, 60);

    expect(
      result.registrations.map((r) => [r.expiry, r.all_tokens, r.token_id])
    ).toEqual([[NEVER_DATE, false, 4]]);
  });

  it('reads 0 as never for a batch item and keeps a small positive expiry on another', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(
        52,
        'RegisterDelegation',
        [COLD, MEMES_CONTRACT, HOT_1, USE_CASE_MINTING, true, BigInt(0)],
        '0xba7c4'
      ),
      log(
        52,
        'RegisterDelegation',
        [COLD, MEMES_CONTRACT, HOT_2, USE_CASE_MINTING, true, BigInt(0)],
        '0xba7c4'
      )
    ]);
    setState(52, COLD, MEMES_CONTRACT, USE_CASE_MINTING, [
      [HOT_1, BigInt(0), true, BigInt(0)],
      [HOT_2, BigInt(5), true, BigInt(0)]
    ]);

    const result = await findDelegationTransactions(1, 60);

    expect(result.registrations.map((r) => [r.wallet2, r.expiry])).toEqual([
      [HOT_1, NEVER_DATE],
      [HOT_2, 5]
    ]);
  });

  it('leaves a stored never-expiring row unchanged in the backfill when the chain says 0', async () => {
    rpcMock.getLogs.mockResolvedValue([
      log(53, 'RegisterDelegation', [
        SAFE,
        DELEGATION_ALL_ADDRESS,
        HOT_1,
        1,
        true,
        BigInt(0)
      ])
    ]);
    setState(53, SAFE, DELEGATION_ALL_ADDRESS, 1, [
      [HOT_1, BigInt(0), true, BigInt(0)]
    ]);
    const applyDiff = jest.fn(async () => undefined);

    const report = await runDelegationScopeBackfill(
      { mode: 'apply', fromBlock: 1 },
      {
        latestProcessedBlock: async () => 60,
        scan: scanDelegationLogs,
        readRows: async () => [
          {
            block: 53,
            from_address: SAFE,
            to_address: HOT_1,
            collection: DELEGATION_ALL_ADDRESS,
            use_case: 1,
            expiry: NEVER_DATE,
            all_tokens: true,
            token_id: 0
          }
        ],
        getTransaction: fetchDelegationTransaction,
        applyDiff,
        nowSeconds: () => 1_800_000_000
      }
    );

    expect(report.diff.unchanged).toBe(1);
    expect(report.deactivates).toBe(0);
    expect(applyDiff).not.toHaveBeenCalled();
  });
});
