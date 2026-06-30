import { DbPoolName } from '@/db-query.options';
import { sqs } from '@/sqs';
import { Time } from '@/time';
import {
  WAVE_DROP_METRICS_DIRTY_REFRESH_MESSAGE_GROUP_ID,
  WAVE_DROP_METRICS_DIRTY_REFRESH_QUEUE_NAME,
  WaveDropMetricsDirtyRefreshReason,
  WaveDropMetricsRefreshService
} from './wave-drop-metrics-refresh.service';

describe('WaveDropMetricsRefreshService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('marks distinct waves dirty with a monotonic dirty timestamp inside the caller connection', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(12_345);
    const execute = jest.fn().mockResolvedValue([]);
    const service = new WaveDropMetricsRefreshService(
      () => ({ execute }) as any,
      {} as any
    );
    const connection = {} as any;

    await service.markWaveDropMetricsDirty(
      ['wave-1', 'wave-1', ''],
      WaveDropMetricsDirtyRefreshReason.DROP_DELETED,
      { connection }
    );

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('insert into wave_drop_metrics_refresh_requests'),
      expect.objectContaining({
        waveId0: 'wave-1',
        reason0: WaveDropMetricsDirtyRefreshReason.DROP_DELETED,
        dirtyAt0: 12_345,
        createdAt0: 12_345,
        updatedAt0: 12_345
      }),
      { wrappedConnection: connection }
    );
    expect(execute.mock.calls[0]?.[0]).toContain('greatest(');
  });

  it('drains dirty drop metrics rows from the write pool and deletes only the captured dirty timestamp', async () => {
    const execute = jest.fn(async (sql: string) => {
      if (sql.includes('select wave_id, dirty_at')) {
        return [{ wave_id: 'wave-1', dirty_at: '1000' }];
      }
      return [];
    });
    const dropsDb = {
      resyncDropCountsForWaves: jest.fn().mockResolvedValue(undefined)
    };
    const service = new WaveDropMetricsRefreshService(
      () => ({ execute }) as any,
      dropsDb as any
    );

    await expect(
      service.refreshDirtyWaveDropMetrics({ batchSize: 10, maxBatches: 1 })
    ).resolves.toEqual({
      batches: 1,
      waves: 1,
      hasMore: false
    });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('select wave_id, dirty_at'),
      expect.objectContaining({
        batchSize: 10,
        maxAttempts: 5
      }),
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
    expect(dropsDb.resyncDropCountsForWaves).toHaveBeenCalledWith(
      ['wave-1'],
      {},
      { forcePool: DbPoolName.WRITE }
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining(
        'where (wave_id, dirty_at) in ((:dirtyWaveId0, :dirtyAt0))'
      ),
      {
        dirtyWaveId0: 'wave-1',
        dirtyAt0: 1000
      },
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
  });

  it('records a dirty drop metrics refresh failure and continues through the batch', async () => {
    const execute = jest.fn(async (sql: string) => {
      if (sql.includes('select wave_id, dirty_at')) {
        return [
          { wave_id: 'wave-1', dirty_at: '1000' },
          { wave_id: 'wave-2', dirty_at: '1001' }
        ];
      }
      return [];
    });
    const dropsDb = {
      resyncDropCountsForWaves: jest
        .fn()
        .mockRejectedValueOnce(new Error('drop metrics refresh failed'))
        .mockResolvedValueOnce(undefined)
    };
    const service = new WaveDropMetricsRefreshService(
      () => ({ execute }) as any,
      dropsDb as any
    );

    await expect(
      service.refreshDirtyWaveDropMetrics({ batchSize: 10, maxBatches: 1 })
    ).resolves.toEqual({
      batches: 1,
      waves: 2,
      hasMore: false
    });

    expect(dropsDb.resyncDropCountsForWaves).toHaveBeenNthCalledWith(
      1,
      ['wave-1'],
      {},
      { forcePool: DbPoolName.WRITE }
    );
    expect(dropsDb.resyncDropCountsForWaves).toHaveBeenNthCalledWith(
      2,
      ['wave-2'],
      {},
      { forcePool: DbPoolName.WRITE }
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('attempts = attempts + 1'),
      expect.objectContaining({
        dirtyWaveId0: 'wave-1',
        dirtyAt0: 1000,
        lastError: 'drop metrics refresh failed'
      }),
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining(
        'where (wave_id, dirty_at) in ((:dirtyWaveId0, :dirtyAt0))'
      ),
      {
        dirtyWaveId0: 'wave-2',
        dirtyAt0: 1001
      },
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
  });

  it('does not continue when the max batch only leaves failed rows behind', async () => {
    const execute = jest.fn(async (sql: string) => {
      if (sql.includes('select wave_id, dirty_at')) {
        return [{ wave_id: 'wave-1', dirty_at: '1000' }];
      }
      if (sql.includes('select wave_id')) {
        return [];
      }
      return [];
    });
    const dropsDb = {
      resyncDropCountsForWaves: jest
        .fn()
        .mockRejectedValue(new Error('drop metrics refresh failed'))
    };
    const service = new WaveDropMetricsRefreshService(
      () => ({ execute }) as any,
      dropsDb as any
    );

    await expect(
      service.refreshDirtyWaveDropMetrics({ batchSize: 1, maxBatches: 1 })
    ).resolves.toEqual({
      batches: 1,
      waves: 1,
      hasMore: false
    });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('wave_id not in (:excludedWaveId0)'),
      expect.objectContaining({
        excludedWaveId0: 'wave-1',
        maxAttempts: 5
      }),
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
  });

  it('checks for remaining dirty rows before continuing after the max batch', async () => {
    const execute = jest.fn(async (sql: string) => {
      if (sql.includes('select wave_id, dirty_at')) {
        return [{ wave_id: 'wave-1', dirty_at: '1000' }];
      }
      if (sql.includes('select wave_id')) {
        return [];
      }
      return [];
    });
    const dropsDb = {
      resyncDropCountsForWaves: jest.fn().mockResolvedValue(undefined)
    };
    const service = new WaveDropMetricsRefreshService(
      () => ({ execute }) as any,
      dropsDb as any
    );

    await expect(
      service.refreshDirtyWaveDropMetrics({ batchSize: 1, maxBatches: 1 })
    ).resolves.toEqual({
      batches: 1,
      waves: 1,
      hasMore: false
    });
  });

  it('does not run synchronous fallback inside a dirty mark transaction', async () => {
    const service = new WaveDropMetricsRefreshService(
      () =>
        ({
          execute: jest.fn().mockRejectedValue(new Error('missing table'))
        }) as any,
      {} as any
    );
    const refreshDropMetricsForWaveIdsBestEffort = jest
      .spyOn(service, 'refreshDropMetricsForWaveIdsBestEffort')
      .mockResolvedValue(undefined);

    await service.markWaveDropMetricsDirtyBestEffort(
      ['wave-1'],
      WaveDropMetricsDirtyRefreshReason.DROP_DELETED,
      { connection: {} as any }
    );

    expect(refreshDropMetricsForWaveIdsBestEffort).not.toHaveBeenCalled();
  });

  it('persists and enqueues async dirty refresh requests', async () => {
    const service = new WaveDropMetricsRefreshService(
      () => ({}) as any,
      {} as any
    );
    const markWaveDropMetricsDirty = jest
      .spyOn(service, 'markWaveDropMetricsDirty')
      .mockResolvedValue(undefined);
    const enqueueDirtyWaveDropMetricsRefresh = jest
      .spyOn(service, 'enqueueDirtyWaveDropMetricsRefreshBestEffort')
      .mockResolvedValue(undefined);

    await service.requestWaveDropMetricsRefreshBestEffort(
      ['wave-1'],
      WaveDropMetricsDirtyRefreshReason.DROP_DELETED
    );

    expect(markWaveDropMetricsDirty).toHaveBeenCalledWith(
      ['wave-1'],
      WaveDropMetricsDirtyRefreshReason.DROP_DELETED,
      {}
    );
    expect(enqueueDirtyWaveDropMetricsRefresh).toHaveBeenCalledWith({});
  });

  it('sends unique dirty refresh wakeups to the dirty FIFO queue', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(12_345);
    const sendToQueueName = jest
      .spyOn(sqs, 'sendToQueueName')
      .mockResolvedValue(undefined);
    const service = new WaveDropMetricsRefreshService(
      () => ({}) as any,
      {} as any
    );

    await service.enqueueDirtyWaveDropMetricsRefresh();

    expect(sendToQueueName).toHaveBeenCalledWith({
      queueName: WAVE_DROP_METRICS_DIRTY_REFRESH_QUEUE_NAME,
      messageGroupId: WAVE_DROP_METRICS_DIRTY_REFRESH_MESSAGE_GROUP_ID,
      message: {
        mode: 'DIRTY',
        requestedAt: 12_345,
        nonce: expect.any(String)
      }
    });
  });
});
