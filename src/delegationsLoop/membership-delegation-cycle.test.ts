const mockDoInDbContext = jest.fn();
const mockFindActiveCycle = jest.fn();
const mockGetLatestBlock = jest.fn();
const mockFindDelegationTransactions = jest.fn();
const mockEnqueueUniverse = jest.fn();
const mockPersistBlock = jest.fn();

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
  membershipTdhCycleId: jest.fn(() => 'delegation:new-block'),
  startMembershipTdhCycle: jest.fn(),
  checkpointMembershipTdhInputs: jest.fn(),
  failMembershipTdhCycle: jest.fn()
}));
jest.mock('../db', () => ({
  fetchLatestNftDelegationBlock: mockGetLatestBlock,
  persistNftDelegationBlock: mockPersistBlock
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
  });

  it('re-emits the prior cycle after its block marker advanced and SQS failed', async () => {
    await handler({} as never, {} as never, jest.fn());
    expect(mockEnqueueUniverse).toHaveBeenCalledWith('delegation:prior-block');
    expect(mockFindDelegationTransactions).not.toHaveBeenCalled();
    expect(mockPersistBlock).not.toHaveBeenCalled();
  });
});
