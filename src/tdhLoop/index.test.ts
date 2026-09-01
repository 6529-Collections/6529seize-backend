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
  });

  it('publishes one authoritative completion event after a full nightly run', async () => {
    await tdhLoop(true);

    expect(mockConsolidateAndPersistTdh).toHaveBeenCalledWith(
      123,
      blockTimestamp,
      { mode: 'FULL' }
    );
    expect(mockNotifyTdhCalculationsDone).toHaveBeenCalledTimes(1);
    expect(mockFindNftTdh.mock.invocationCallOrder[0]).toBeLessThan(
      mockNotifyTdhCalculationsDone.mock.invocationCallOrder[0]
    );
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
