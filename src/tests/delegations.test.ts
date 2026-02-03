import { findDelegationTransactions } from '../delegations';
import {
  MEMES_CONTRACT,
  USE_CASE_CONSOLIDATION,
  USE_CASE_SUB_DELEGATION
} from '@/constants';

type AlchemyMock = {
  core: {
    getLogs: jest.Mock;
    getTransaction: jest.Mock;
    getBlockNumber: jest.Mock;
    getBlock: jest.Mock;
  };
};

const alchemyMock: AlchemyMock = {
  core: {
    getLogs: jest.fn(),
    getTransaction: jest.fn(),
    getBlockNumber: jest.fn(),
    getBlock: jest.fn()
  }
};

jest.mock('../alchemy', () => ({
  getAlchemyInstance: jest.fn()
}));

const { getAlchemyInstance: mockGetAlchemyInstance } =
  jest.requireMock('../alchemy');

jest.mock('../abis/delegations', () => {
  const parseLog = jest.fn();
  const parseTransaction = jest.fn();
  return {
    DELEGATIONS_IFACE: { parseLog, parseTransaction }
  };
});

const {
  DELEGATIONS_IFACE: { parseLog: mockParseLog, parseTransaction: mockParseTx }
} = jest.requireMock('../abis/delegations');

jest.mock('../strings', () => {
  const equalIgnoreCase = jest.fn();
  return {
    equalIgnoreCase
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAlchemyInstance.mockReturnValue(alchemyMock);
});

const mockEqual = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  mockGetAlchemyInstance.mockReturnValue(alchemyMock);
  alchemyMock.core.getBlock.mockResolvedValue({ timestamp: 123 });
  alchemyMock.core.getBlockNumber.mockResolvedValue(5);
});

describe('findDelegationTransactions', () => {
  it('registers consolidation events', async () => {
    const log = { blockNumber: 1, transactionHash: '0x1' } as any;
    alchemyMock.core.getLogs.mockResolvedValue([log]);
    mockParseLog.mockReturnValueOnce({
      name: 'RegisterDelegation',
      args: {
        collectionAddress: MEMES_CONTRACT,
        delegator: '0xA',
        delegationAddress: '0xB',
        useCase: BigInt(USE_CASE_CONSOLIDATION)
      }
    });
    mockEqual.mockReturnValue(false);
    const result = await findDelegationTransactions(1, 2);
    expect(result.consolidations).toEqual([
      { block: 1, type: 0, wallet1: '0xA', wallet2: '0xB' }
    ]);
    expect(result.registrations).toEqual([]);
    expect(result.revocation).toEqual([]);
  });

  it('registers sub delegation', async () => {
    const log = { blockNumber: 1, transactionHash: '0x2' } as any;
    alchemyMock.core.getLogs.mockResolvedValue([log]);
    mockParseLog.mockReturnValueOnce({
      name: 'RegisterDelegationUsingSubDelegation',
      args: {
        collectionAddress: '0xC',
        delegator: '0xA',
        delegationAddress: '0xB',
        useCase: BigInt(USE_CASE_SUB_DELEGATION)
      }
    });
    mockEqual.mockReturnValue(false);
    const result = await findDelegationTransactions(1, 2);
    expect(result.registrations).toEqual([
      {
        block: 1,
        type: 0,
        wallet1: '0xA',
        wallet2: '0xB',
        use_case: USE_CASE_SUB_DELEGATION,
        collection: '0xC'
      }
    ]);
    expect(result.consolidations).toEqual([]);
    expect(result.revocation).toEqual([]);
  });

  it('registers generic delegation with details', async () => {
    const log = { blockNumber: 1, transactionHash: '0x3' } as any;
    alchemyMock.core.getLogs.mockResolvedValue([log]);
    mockParseLog.mockReturnValueOnce({
      name: 'RegisterDelegation',
      args: {
        collectionAddress: '0xC',
        from: '0xA',
        delegationAddress: '0xB',
        useCase: BigInt(5)
      }
    });
    mockParseTx.mockReturnValueOnce({
      args: {
        _expiryDate: BigInt(9),
        _allTokens: true,
        _tokenId: BigInt(7)
      }
    });
    alchemyMock.core.getTransaction.mockResolvedValue({ data: '0x' });
    mockEqual.mockReturnValue(false);
    const result = await findDelegationTransactions(1, 2);
    expect(result.registrations).toEqual([
      {
        block: 1,
        type: 0,
        wallet1: '0xA',
        wallet2: '0xB',
        use_case: 5,
        collection: '0xC',
        expiry: 9,
        all_tokens: true,
        token_id: 7
      }
    ]);
  });

  it('revokes delegation', async () => {
    const log = { blockNumber: 2, transactionHash: '0x4' } as any;
    alchemyMock.core.getLogs.mockResolvedValue([log]);
    mockParseLog.mockReturnValueOnce({
      name: 'RevokeDelegation',
      args: {
        collectionAddress: '0xC',
        from: '0xA',
        delegationAddress: '0xB',
        useCase: BigInt(5)
      }
    });
    mockEqual.mockReturnValue(false);
    const result = await findDelegationTransactions(1, 2);
    expect(result.revocation).toEqual([
      {
        block: 2,
        type: 1,
        wallet1: '0xA',
        wallet2: '0xB',
        use_case: 5,
        collection: '0xC'
      }
    ]);
    expect(result.registrations).toEqual([]);
  });
});
