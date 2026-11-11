jest.mock('@/competitions/competition-main-stage.repository', () => ({
  competitionMainStageRepository: {
    totalActiveVotes: jest.fn().mockResolvedValue(0)
  }
}));
jest.mock('../metrics/MetricsRecorder', () => ({
  metricsRecorder: { recordTdhOnMainStageSubmissions: jest.fn() }
}));
const mockFetchLatestTdhDate = jest.fn();
const mockUpdateTdh = jest.fn();
const mockConsolidateAndPersistTdh = jest.fn();
const mockFindNftTdh = jest.fn();
const mockUploadTdh = jest.fn();
const mockNotifyTdhCalculationsDone = jest.fn();
const mockGetStringOrNull = jest.fn();

jest.mock('../db', () => ({
  fetchLatestTDHBDate: mockFetchLatestTdhDate
}));

jest.mock('./tdh', () => ({
  updateTDH: mockUpdateTdh
}));

jest.mock('./tdh_consolidation', () => ({
  consolidateAndPersistTDH: mockConsolidateAndPersistTdh
}));

jest.mock('./nft_tdh', () => ({
  findNftTDH: mockFindNftTdh
}));

jest.mock('./tdh_upload', () => ({
  uploadTDH: mockUploadTdh
}));

jest.mock('../notifier', () => ({
  notifyTdhCalculationsDone: mockNotifyTdhCalculationsDone
}));

jest.mock('../env', () => ({
  env: {
    getStringOrNull: mockGetStringOrNull
  }
}));

const mockHasPendingFullAnnouncement = jest.fn();
jest.mock('../identity-tdh-sync-state.db', () => ({
  identityTdhSyncStateDb: {
    hasPendingFullAnnouncement: mockHasPendingFullAnnouncement
  }
}));

import { tdhLoop } from './index';

describe('tdhLoop xTDH completion trigger', () => {
  const blockTimestamp = new Date('2026-08-31T00:00:00.000Z');
  const tdh = [{ wallet: '0xabc' }];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStringOrNull.mockReturnValue(null);
    mockFetchLatestTdhDate.mockResolvedValue({
      block: 122,
      timestamp: {
        diffFromNow: () => ({
          gt: () => false,
          formatAsDuration: () => '1 hour'
        })
      }
    });
    mockUpdateTdh.mockResolvedValue({
      block: 123,
      blockTimestamp,
      tdh
    });
    mockConsolidateAndPersistTdh.mockResolvedValue([]);
    mockFindNftTdh.mockResolvedValue(undefined);
    mockUploadTdh.mockResolvedValue(undefined);
    mockNotifyTdhCalculationsDone.mockResolvedValue(undefined);
    mockHasPendingFullAnnouncement.mockResolvedValue(false);
  });

  it('leaves the completion event of a full nightly run to the identities sync', async () => {
    await tdhLoop(true);

    expect(mockConsolidateAndPersistTdh).toHaveBeenCalledWith(
      123,
      blockTimestamp,
      { mode: 'FULL' }
    );
    expect(mockFindNftTdh).toHaveBeenCalledTimes(1);
    // Published by delegationsLoop once identities reflect this TDH.
    expect(mockNotifyTdhCalculationsDone).not.toHaveBeenCalled();
  });

  it('does not repeat the event on a rerun while a full write still waits for its sync', async () => {
    mockHasPendingFullAnnouncement.mockResolvedValue(true);

    await tdhLoop();

    expect(mockConsolidateAndPersistTdh).not.toHaveBeenCalled();
    expect(mockNotifyTdhCalculationsDone).not.toHaveBeenCalled();
  });

  it('does not publish completion when full persistence fails', async () => {
    mockConsolidateAndPersistTdh.mockRejectedValueOnce(
      new Error('persistence failed')
    );

    await expect(tdhLoop(true)).rejects.toThrow('persistence failed');

    expect(mockFindNftTdh).not.toHaveBeenCalled();
    expect(mockNotifyTdhCalculationsDone).not.toHaveBeenCalled();
  });

  it('preserves completion notification on skipped retry attempts', async () => {
    mockNotifyTdhCalculationsDone
      .mockRejectedValueOnce(new Error('notification failed'))
      .mockResolvedValueOnce(undefined);

    await expect(tdhLoop()).rejects.toThrow('notification failed');
    await expect(tdhLoop()).resolves.toBeUndefined();

    expect(mockUpdateTdh).not.toHaveBeenCalled();
    expect(mockConsolidateAndPersistTdh).not.toHaveBeenCalled();
    expect(mockFindNftTdh).toHaveBeenCalledTimes(2);
    expect(mockNotifyTdhCalculationsDone).toHaveBeenCalledTimes(2);
  });
});
