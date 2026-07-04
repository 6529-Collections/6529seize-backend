import {
  readWaveUnreadSummaryCache,
  writeWaveUnreadSummaryCache
} from './wave-unread-cache';
import { WavesApiDb } from './waves.api.db';

jest.mock('./wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForReaderWave: jest.fn(),
  readWaveUnreadSummaryCache: jest.fn(),
  withInFlightWaveUnreadSummaryCacheMiss: jest.fn(
    async ({ getValue }: { getValue: () => Promise<unknown> }) =>
      await getValue()
  ),
  writeWaveUnreadSummaryCache: jest.fn()
}));

const readWaveUnreadSummaryCacheMock = jest.mocked(readWaveUnreadSummaryCache);
const writeWaveUnreadSummaryCacheMock = jest.mocked(
  writeWaveUnreadSummaryCache
);

function createRepo() {
  const db = {
    execute: jest.fn()
  };
  return {
    db,
    repo: new WavesApiDb(() => db as any)
  };
}

describe('WavesApiDb unread summary cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns cached summaries without querying the database when every wave is cached', async () => {
    const { db, repo } = createRepo();
    readWaveUnreadSummaryCacheMock.mockResolvedValue({
      cachedByWaveId: {
        'wave-1': {
          unread_drops_count: 3,
          first_unread_drop_serial_no: 11
        }
      },
      uncachedWaveIds: [],
      cacheKeysByWaveId: {
        'wave-1': 'cache-key-1'
      }
    });

    await expect(
      repo.findIdentityUnreadDropsSummaryByWaveId(
        {
          identityId: 'reader-1',
          waveIds: ['wave-1']
        },
        {}
      )
    ).resolves.toEqual({
      'wave-1': {
        unread_drops_count: 3,
        first_unread_drop_serial_no: 11
      }
    });

    expect(db.execute).not.toHaveBeenCalled();
    expect(writeWaveUnreadSummaryCacheMock).not.toHaveBeenCalled();
  });

  it('queries and writes only uncached summaries while merging cached results', async () => {
    const { db, repo } = createRepo();
    readWaveUnreadSummaryCacheMock.mockResolvedValue({
      cachedByWaveId: {
        'wave-1': {
          unread_drops_count: 3,
          first_unread_drop_serial_no: 11
        }
      },
      uncachedWaveIds: ['wave-2', 'wave-3'],
      cacheKeysByWaveId: {
        'wave-1': 'cache-key-1',
        'wave-2': 'cache-key-2',
        'wave-3': 'cache-key-3'
      }
    });
    db.execute.mockResolvedValue([
      {
        wave_id: 'wave-2',
        unread_drops_count: '4',
        first_unread_drop_serial_no: '20'
      }
    ]);

    await expect(
      repo.findIdentityUnreadDropsSummaryByWaveId(
        {
          identityId: 'reader-1',
          waveIds: ['wave-1', 'wave-2', 'wave-3']
        },
        {}
      )
    ).resolves.toEqual({
      'wave-1': {
        unread_drops_count: 3,
        first_unread_drop_serial_no: 11
      },
      'wave-2': {
        unread_drops_count: 4,
        first_unread_drop_serial_no: 20
      },
      'wave-3': {
        unread_drops_count: 0,
        first_unread_drop_serial_no: null
      }
    });

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('COUNT(d.id) AS unread_drops_count'),
      { identityId: 'reader-1', waveIds: ['wave-2', 'wave-3'] },
      { wrappedConnection: undefined }
    );
    expect(writeWaveUnreadSummaryCacheMock).toHaveBeenCalledWith({
      summariesByWaveId: {
        'wave-2': {
          unread_drops_count: 4,
          first_unread_drop_serial_no: 20
        },
        'wave-3': {
          unread_drops_count: 0,
          first_unread_drop_serial_no: null
        }
      },
      cacheKeysByWaveId: {
        'wave-1': 'cache-key-1',
        'wave-2': 'cache-key-2',
        'wave-3': 'cache-key-3'
      }
    });
  });
});
