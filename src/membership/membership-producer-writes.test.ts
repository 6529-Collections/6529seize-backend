const mockGetDataSource = jest.fn();
const mockWithPrimaryTransaction = jest.fn();

jest.mock('@/db', () => ({ getDataSource: mockGetDataSource }));
jest.mock('./membership-producer-policy', () => ({
  isMembershipSourceTrackingActive: () => true
}));
jest.mock('./membership-primary', () => ({
  withMembershipPrimaryMutationContext: jest.fn(),
  withMembershipPrimaryTransaction: mockWithPrimaryTransaction
}));

import { runMembershipGlobalSourceJob } from './membership-producer-writes';

describe('membership producer advisory lock lifetime', () => {
  const connect = jest.fn();
  const query = jest.fn();
  const release = jest.fn();
  const write = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDataSource.mockReturnValue({
      createQueryRunner: () => ({ connect, query, release })
    });
    connect.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    query.mockResolvedValue([{ acquired: 1 }]);
    mockWithPrimaryTransaction.mockResolvedValue({ status: 'COMPLETED' });
  });

  it('releases the query runner when connecting fails', async () => {
    connect.mockRejectedValueOnce(new Error('pool unavailable'));

    await expect(
      runMembershipGlobalSourceJob(
        'owner-cycle',
        ['OWNERSHIP'],
        'owner-reconcile',
        write
      )
    ).rejects.toThrow('pool unavailable');

    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the pinned connection even if releasing its advisory lock fails', async () => {
    query
      .mockResolvedValueOnce([{ acquired: 1 }])
      .mockRejectedValueOnce(new Error('release lock failed'));

    await expect(
      runMembershipGlobalSourceJob(
        'owner-cycle',
        ['OWNERSHIP'],
        'owner-reconcile',
        write
      )
    ).rejects.toThrow('release lock failed');

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT GET_LOCK(?, 0) acquired',
      'SELECT RELEASE_LOCK(?) released'
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });
});
