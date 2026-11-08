import {
  DropPostHops,
  EMF_MAX_VALUES,
  FanoutMeasurement,
  sampleValues,
  serverReceivedAtFromTimer,
  WAVE_DELIVERY_NAMESPACE
} from './wave-delivery-metrics';

function captureEmf(): { lines: () => any[]; restore: () => void } {
  const spy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  return {
    lines: () =>
      spy.mock.calls.map(([line]) => JSON.parse(String(line).trim())),
    restore: () => spy.mockRestore()
  };
}

function clock(start = 1_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    }
  };
}

describe('wave delivery metrics', () => {
  const originalLambda = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const originalSentry = process.env.SENTRY_ENVIRONMENT;

  beforeEach(() => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'api';
    process.env.SENTRY_ENVIRONMENT = 'api_staging';
  });

  afterEach(() => {
    if (originalLambda === undefined)
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = originalLambda;
    if (originalSentry === undefined) delete process.env.SENTRY_ENVIRONMENT;
    else process.env.SENTRY_ENVIRONMENT = originalSentry;
  });

  it('records every fan-out hop in one EMF record', () => {
    const emf = captureEmf();
    try {
      const time = clock();
      const cpu = jest
        .fn()
        .mockReturnValueOnce({ user: 1_000, system: 0 })
        .mockReturnValueOnce({ user: 41_000, system: 2_400 });
      const measurement = new FanoutMeasurement(
        'DROP_UPDATE',
        900,
        time.now,
        cpu
      );
      time.advance(4);
      measurement.queryDone(3);
      time.advance(6);
      measurement.prepareDone();
      for (const outcome of ['sent', 'gone', 'resync_pending'] as const) {
        measurement.serialized();
        measurement.claimTimed(2);
        const sendStartedAt = time.now();
        time.advance(10);
        measurement.sendSettled(sendStartedAt, outcome);
      }
      measurement.emit({ drop_id: 'drop-1', wave_id: 'wave-1' });

      const [record] = emf.lines();
      expect(record._aws.CloudWatchMetrics[0].Namespace).toBe(
        WAVE_DELIVERY_NAMESPACE
      );
      expect(record._aws.CloudWatchMetrics[0].Dimensions).toEqual([
        ['Environment', 'FrameType']
      ]);
      expect(record).toMatchObject({
        Environment: 'staging',
        FrameType: 'DROP_UPDATE',
        event: 'WAVE_FANOUT',
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        fanout_recipients: 3,
        fanout_query_ms: 4,
        fanout_prepare_ms: 6,
        fanout_first_send_ms: 20,
        fanout_last_send_ms: 40,
        fanout_total_ms: 40,
        fanout_server_last_send_ms: 140,
        fanout_per_send_ms: [10, 10, 10],
        fanout_cpu_ms: 43.4,
        fanout_claim_ms: [2, 2, 2],
        fanout_serializations: 3,
        fanout_connection_reads: 0,
        fanout_sent: 1,
        fanout_gone: 1,
        fanout_resync_pending: 1,
        fanout_failed: 0
      });
    } finally {
      emf.restore();
    }
  });

  it('reports how many fan-outs ran at once during each one', () => {
    const emf = captureEmf();
    try {
      const solo = new FanoutMeasurement('DROP_UPDATE', null);
      solo.emit();
      const first = new FanoutMeasurement('DROP_UPDATE', null);
      const second = new FanoutMeasurement('DROP_REACTION_UPDATE', null);
      second.emit();
      // A later fan-out does not raise a finished one's overlap.
      const third = new FanoutMeasurement('DROP_UPDATE', null);
      third.emit();
      first.emit();

      expect(emf.lines().map((line) => line.fanout_overlap_max)).toEqual([
        1, 2, 2, 2
      ]);
    } finally {
      emf.restore();
    }
  });

  it('omits send timings for an empty audience instead of reporting zero', () => {
    const emf = captureEmf();
    try {
      const measurement = new FanoutMeasurement('DROP_UPDATE', null);
      measurement.queryDone(0);
      measurement.emit();
      const [record] = emf.lines();
      const names = record._aws.CloudWatchMetrics[0].Metrics.map(
        (metric: { Name: string }) => metric.Name
      );
      expect(record.fanout_recipients).toBe(0);
      expect(names).not.toContain('fanout_first_send_ms');
      expect(names).not.toContain('fanout_server_last_send_ms');
      expect(names).not.toContain('fanout_per_send_ms');
      expect(names).not.toContain('fanout_claim_ms');
      expect(names).toContain('fanout_cpu_ms');
    } finally {
      emf.restore();
    }
  });

  it('writes nothing outside Lambda', () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    const emf = captureEmf();
    try {
      new FanoutMeasurement('DROP_UPDATE', null).emit();
      new DropPostHops().emit();
      expect(emf.lines()).toEqual([]);
    } finally {
      emf.restore();
    }
  });

  it('caps per-send samples at the EMF value limit', () => {
    const values = Array.from({ length: 1_000 }, (_, index) => index);
    const sample = sampleValues(values, EMF_MAX_VALUES);
    expect(sample).toHaveLength(EMF_MAX_VALUES);
    expect(sample[0]).toBe(0);
    expect(sample[sample.length - 1]).toBe(990);
    expect(sampleValues([1, 2], EMF_MAX_VALUES)).toEqual([1, 2]);
  });

  it('times drop POST hops, including failed ones', async () => {
    const emf = captureEmf();
    try {
      const time = clock();
      const hops = new DropPostHops(time.now);
      time.advance(5);
      hops.set('drop_pre_commit_ms', hops.elapsed());
      await hops.time('drop_commit_ms', async () => time.advance(30));
      await expect(
        hops.time('post_commit_push_ms', async () => {
          time.advance(7);
          throw new Error('push failed');
        })
      ).rejects.toThrow('push failed');
      hops.set('ignored_ms', Number.NaN);
      hops.emit({ drop_id: 'drop-1' });
      const [record] = emf.lines();
      expect(record).toMatchObject({
        FrameType: 'DROP_POST',
        event: 'WAVE_DROP_POST',
        drop_id: 'drop-1',
        drop_pre_commit_ms: 5,
        drop_commit_ms: 30,
        post_commit_push_ms: 7
      });
      expect(record).not.toHaveProperty('ignored_ms');
    } finally {
      emf.restore();
    }
  });

  it('derives the server receipt time from the request timer', () => {
    expect(
      serverReceivedAtFromTimer(
        { getTotalTimePassed: () => ({ toMillis: () => 25 }) },
        1_000
      )
    ).toBe(975);
    expect(serverReceivedAtFromTimer(undefined)).toBeNull();
    expect(
      serverReceivedAtFromTimer({
        getTotalTimePassed: () => {
          throw new Error('broken timer');
        }
      })
    ).toBeNull();
  });
});
