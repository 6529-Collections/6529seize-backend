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
  USE_CASE_CONSOLIDATION,
  USE_CASE_MINTING,
  USE_CASE_SUB_DELEGATION
} from '@/constants';
import { findDelegationTransactions } from '@/delegations';

jest.mock('@/alchemy', () => ({
  getAlchemyInstance: jest.fn()
}));

const { getAlchemyInstance: mockGetAlchemyInstance } =
  jest.requireMock('@/alchemy');

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

const alchemyMock = {
  core: {
    getLogs: jest.fn(),
    getTransaction: jest.fn(),
    getBlockNumber: jest.fn(),
    getBlock: jest.fn(),
    call: jest.fn()
  }
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
  return alchemyMock.core.call.mock.calls.map(
    ([tx, blockTag]) =>
      `${DELEGATIONS_IFACE.parseTransaction({ data: tx.data })?.name}@${blockTag}`
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  nextLogIndex = 0;
  contractState = [];
  mockGetAlchemyInstance.mockReturnValue(alchemyMock);
  alchemyMock.core.getBlock.mockResolvedValue({ timestamp: 123 });
  alchemyMock.core.getBlockNumber.mockResolvedValue(500);
  alchemyMock.core.call.mockImplementation(
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
    alchemyMock.core.getTransaction.mockResolvedValue({
      to: SAFE,
      data: safeExecTransaction(inner)
    });
    alchemyMock.core.getLogs.mockResolvedValue([
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
    expect(alchemyMock.core.getTransaction).not.toHaveBeenCalled();
  });

  it('gives each batchDelegations item its own expiry and token scope', async () => {
    const tx = '0xba7c4';
    alchemyMock.core.getLogs.mockResolvedValue([
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
    expect(alchemyMock.core.getTransaction).not.toHaveBeenCalled();
  });

  it('records a Delegation Manager registration against the delegator', async () => {
    alchemyMock.core.getLogs.mockResolvedValue([
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
    alchemyMock.core.getLogs.mockResolvedValue([
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
    expect(alchemyMock.core.call).not.toHaveBeenCalled();
  });

  it('drops a registration revoked later in the same block but keeps the revocation', async () => {
    alchemyMock.core.getLogs.mockResolvedValue([
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
    expect(alchemyMock.core.call).not.toHaveBeenCalled();
  });

  it('skips a token-specific registration whose token id does not fit the column', async () => {
    alchemyMock.core.getLogs.mockResolvedValue([
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

  it('fails instead of storing defaults when the state read fails', async () => {
    alchemyMock.core.getLogs.mockResolvedValue([
      log(15, 'RegisterDelegation', [
        SAFE,
        MEMES_CONTRACT,
        HOT_1,
        USE_CASE_MINTING,
        false,
        BigInt(1)
      ])
    ]);
    alchemyMock.core.call.mockRejectedValue(new Error('missing trie node'));

    await expect(findDelegationTransactions(1, 20)).rejects.toThrow(
      'missing trie node'
    );
  });
});
