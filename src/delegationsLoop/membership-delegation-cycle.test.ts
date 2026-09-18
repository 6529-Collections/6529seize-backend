const mockDoInDbContext = jest.fn();
const mockFindActiveCycle = jest.fn();
const mockGetLatestBlock = jest.fn();
const mockFindDelegationTransactions = jest.fn();
const mockEnqueueUniverse = jest.fn();
const mockPersistBlock = jest.fn();
const mockPersistConsolidations = jest.fn();
const mockPersistDelegations = jest.fn();
const mockHasConsolidationsFromBlock = jest.fn();
const mockStartCycle = jest.fn();
const mockCheckpointInputs = jest.fn();
const mockCycleId = jest.fn((kind: string) => `${kind}:new-block`);

jest.mock('../secrets', () => ({ doInDbContext: mockDoInDbContext }));
jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: jest.fn((handler) => handler)
}));
jest.mock('@/membership/membership-producer-policy', () => ({
  isMembershipSourceTrackingActive: () => true
}));
jest.mock('@/membership/membership-tdh-cycle', () => ({
  findActiveMembershipTdhCycle: mockFindActiveCycle,
  getMembershipTdhCycleState: jest.fn(),
  membershipTdhCycleId: mockCycleId,
  startMembershipTdhCycle: mockStartCycle,
  checkpointMembershipTdhInputs: mockCheckpointInputs,
  failMembershipTdhCycle: jest.fn()
}));
jest.mock('../db', () => ({
  fetchLatestNftDelegationBlock: mockGetLatestBlock,
  persistNftDelegationBlock: mockPersistBlock,
  persistConsolidations: mockPersistConsolidations,
  persistDelegations: mockPersistDelegations,
  hasConsolidationsFromBlock: mockHasConsolidationsFromBlock
}));
jest.mock('../ens', () => ({
  discoverEnsDelegations: jest.fn(),
  discoverEnsConsolidations: jest.fn()
}));
jest.mock('../api-serverless/src/identities/identities.service', () => ({
  identitiesService: { updatePrimaryAddresses: jest.fn() }
}));
jest.mock('../delegations', () => ({
  findDelegationTransactions: mockFindDelegationTransactions
}));
jest.mock('../tdhLoop/tdh_consolidation', () => ({
  consolidateAndPersistTDH: jest.fn(),
  enqueuePartialTdhUniverseRecalculation: mockEnqueueUniverse
}));

import { handler } from './index';

describe('Delegation source cycle recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindActiveCycle.mockReset();
    mockFindDelegationTransactions.mockReset();
    mockHasConsolidationsFromBlock.mockReset();
    mockDoInDbContext.mockImplementation(async (callback) => callback());
    mockFindActiveCycle.mockResolvedValue({
      cycleId: 'delegation:prior-block',
      state: {
        status: 'RUNNING',
        progress: {
          stage: 'TDH_INPUTS_COMMITTED',
          after_id: null,
          revision: '1'
        }
      }
    });
    mockGetLatestBlock.mockResolvedValue(999);
    mockEnqueueUniverse.mockResolvedValue(undefined);
    mockStartCycle.mockResolvedValue(undefined);
    mockHasConsolidationsFromBlock.mockResolvedValue(false);
  });

  it('re-emits the prior cycle after its block marker advanced and SQS failed', async () => {
    await handler({} as never, {} as never, jest.fn());
    expect(mockEnqueueUniverse).toHaveBeenCalledWith('delegation:prior-block');
    expect(mockFindDelegationTransactions).not.toHaveBeenCalled();
    expect(mockPersistBlock).not.toHaveBeenCalled();
  });

  it('keeps the barrier when an earlier procedural delegation write may be partial', async () => {
    mockFindActiveCycle.mockResolvedValueOnce({
      cycleId: 'delegation:prior-block',
      state: {
        status: 'FAILED',
        progress: { stage: 'STARTED', after_id: null, revision: '1' }
      }
    });
    await expect(handler({} as never, {} as never, jest.fn())).rejects.toThrow(
      'operator repair'
    );
    expect(mockFindDelegationTransactions).not.toHaveBeenCalled();
    expect(mockEnqueueUniverse).not.toHaveBeenCalled();
  });

  it('prefetches a no-consolidation range once and leaves ownership out of its cycle kind', async () => {
    mockFindActiveCycle.mockResolvedValueOnce(null);
    const response = {
      latestBlock: 1000,
      latestBlockTimestamp: 12345,
      consolidations: [],
      registrations: [],
      revocation: []
    };
    mockFindDelegationTransactions.mockResolvedValueOnce(response);
    mockStartCycle.mockResolvedValueOnce({
      status: 'RUNNING',
      progress: { stage: 'STARTED', after_id: null, revision: '0' }
    });

    await handler({} as never, {} as never, jest.fn());

    expect(mockFindDelegationTransactions).toHaveBeenCalledTimes(1);
    expect(mockCycleId).toHaveBeenCalledWith('delegation-no-ownership', [999]);
    expect(mockPersistConsolidations).toHaveBeenCalledWith(999, []);
    expect(mockPersistDelegations).toHaveBeenCalledWith(999, [], []);
    expect(mockCheckpointInputs).toHaveBeenCalledWith(
      'delegation-no-ownership:new-block',
      {},
      expect.any(Function)
    );
    expect(mockEnqueueUniverse).toHaveBeenCalledWith(
      'delegation-no-ownership:new-block'
    );
  });

  it('keeps the six-key cycle kind when the range has a consolidation', async () => {
    mockFindActiveCycle.mockResolvedValueOnce(null);
    mockFindDelegationTransactions.mockResolvedValueOnce({
      latestBlock: 1000,
      latestBlockTimestamp: 12345,
      consolidations: [{ block: 1000 }],
      registrations: [],
      revocation: []
    });
    mockStartCycle.mockResolvedValueOnce({
      status: 'RUNNING',
      progress: { stage: 'TDH_INPUTS_COMMITTED', after_id: null, revision: '1' }
    });

    await handler({} as never, {} as never, jest.fn());

    expect(mockCycleId).toHaveBeenCalledWith('delegation', [999]);
    expect(mockEnqueueUniverse).toHaveBeenCalledWith('delegation:new-block');
  });

  it('keeps ownership when an inclusive replay removes an old consolidation', async () => {
    mockFindActiveCycle.mockResolvedValueOnce(null);
    mockFindDelegationTransactions.mockResolvedValueOnce({
      latestBlock: 1000,
      latestBlockTimestamp: 12345,
      consolidations: [],
      registrations: [],
      revocation: []
    });
    mockHasConsolidationsFromBlock.mockResolvedValueOnce(true);
    mockStartCycle.mockResolvedValueOnce({
      status: 'RUNNING',
      progress: { stage: 'TDH_INPUTS_COMMITTED', after_id: null, revision: '1' }
    });

    await handler({} as never, {} as never, jest.fn());

    expect(mockCycleId).toHaveBeenCalledWith('delegation', [999]);
  });
});
