const mockActiveJob = jest.fn();
const mockGetIntOrThrow = jest.fn();
const mockGetIntOrNull = jest.fn();

jest.mock('../membership/membership-producer-writes', () => ({
  getActiveMembershipGlobalJobId: mockActiveJob,
  runMembershipGlobalSourceJob: jest.fn()
}));

jest.mock('../env', () => ({
  env: {
    getIntOrThrow: mockGetIntOrThrow,
    getIntOrNull: mockGetIntOrNull
  }
}));

import { IndexedContractStatus } from '../entities/IExternalIndexedContract';
import { ExternalCollectionLiveTailService } from './external-collection-live-tailing.service';

describe('live ownership source recovery', () => {
  const findCollectionInfo = jest.fn();
  const findLiveTailingCollections = jest.fn();
  const provider = { getBlockNumber: jest.fn() };
  const service = new ExternalCollectionLiveTailService(
    {
      findCollectionInfo,
      findLiveTailingCollections
    } as any,
    { provider } as any,
    {} as any
  );
  const process = jest.spyOn(service, 'processLiveRange');

  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveJob.mockResolvedValue('external-live:test-partition:91:95');
    mockGetIntOrThrow.mockReturnValue(10);
    mockGetIntOrNull.mockReturnValue(2000);
    provider.getBlockNumber.mockResolvedValue(100);
    findCollectionInfo.mockResolvedValue({
      partition: 'test-partition',
      chain: 1,
      contract: '0xcontract',
      status: IndexedContractStatus.LIVE_TAILING,
      safe_head_block: 90,
      last_indexed_block: 90
    });
  });

  it('holds the active barrier until its exact range is beyond the safe head', async () => {
    await service.liveTailCycle();
    expect(findLiveTailingCollections).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it('refuses recovery if the collection moved out of live tailing', async () => {
    findCollectionInfo.mockResolvedValueOnce({
      partition: 'test-partition',
      status: IndexedContractStatus.SNAPSHOTTING
    });
    await expect(service.liveTailCycle()).rejects.toThrow(
      'no longer live tailing'
    );
    expect(process).not.toHaveBeenCalled();
  });
});
