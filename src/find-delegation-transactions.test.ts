import { getAddress, Interface } from 'ethers';
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

const STATE_VIEW = 'retrieveDelegationAddressesTokensIDsandExpiredDates';
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

const alchemyMock = {
  core: {
    getLogs: jest.fn(),
    getTransaction: jest.fn(),
    getBlockNumber: jest.fn(),
    getBlock: jest.fn(),
    call: jest.fn()
  }
};

// Contract state per (block, delegator, collection, use case), as the
// retrieveDelegationAddressesTokensIDsandExpiredDates view returns it.
let contractState: Map<string, StoredEntry[]>;

function stateKey(
  block: number,
  delegator: string,
  collection: string,
  useCase: number | bigint
) {
  return [block, delegator, collection, useCase]
    .map((v) => v.toString().toLowerCase())
    .join('|');
}

function setState(
  block: number,
  delegator: string,
  collection: string,
  useCase: number,
  entries: StoredEntry[]
) {
  contractState.set(stateKey(block, delegator, collection, useCase), entries);
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

beforeEach(() => {
  jest.clearAllMocks();
  nextLogIndex = 0;
  contractState = new Map();
  mockGetAlchemyInstance.mockReturnValue(alchemyMock);
  alchemyMock.core.getBlock.mockResolvedValue({ timestamp: 123 });
  alchemyMock.core.getBlockNumber.mockResolvedValue(500);
  alchemyMock.core.call.mockImplementation(
    async (tx: { to: string; data: string }, blockTag: number) => {
      expect(tx.to).toBe(DELEGATION_CONTRACT.contract);
      const [delegator, collection, useCase] =
        DELEGATIONS_IFACE.decodeFunctionData(STATE_VIEW, tx.data);
      const entries =
        contractState.get(stateKey(blockTag, delegator, collection, useCase)) ??
        [];
      return DELEGATIONS_IFACE.encodeFunctionResult(STATE_VIEW, [
        entries.map((e) => e[0]),
        entries.map((e) => e[1]),
        entries.map((e) => e[2]),
        entries.map((e) => e[3])
      ]);
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
    expect(alchemyMock.core.call).toHaveBeenCalledTimes(1);
    expect(alchemyMock.core.call.mock.calls[0][1]).toBe(10);
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
    // One read per delegator, collection and use case in the block.
    expect(alchemyMock.core.call).toHaveBeenCalledTimes(3);
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
