import { loggerContext } from '@/logger-context';
import { readWaveCatalogueWithDiagnostics } from './wave-catalogue-read-diagnostics';

const events = { ready: 1, reconnecting: 0 };
jest.mock('@/redis', () => ({
  getRedisConnectionEventCounts: () => ({ ...events })
}));

function loggedEvent(log: jest.SpyInstance, index = 0) {
  const line = log.mock.calls[index][0] as string;
  expect(line).toMatch(/^\[WAVE_CATALOGUE_READ\] \{/);
  return JSON.parse(line.slice('[WAVE_CATALOGUE_READ] '.length));
}

describe('wave catalogue Redis read diagnostics', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    process.env.WAVE_CATALOGUE_READ_SAMPLE_RATE = '1';
    events.ready = 1;
    events.reconnecting = 0;
    log = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    delete process.env.WAVE_CATALOGUE_READ_SAMPLE_RATE;
    log.mockRestore();
  });

  it('records a hit, UTF-8 byte count and request ID without catalogue or identity data', async () => {
    const raw = JSON.stringify([{ name: 'é', criteria: 'private-criterion' }]);
    const client = { isReady: true, isOpen: true };
    const value = await loggerContext.run(
      { requestId: 'request-123', jwtSub: 'private-wallet' },
      () =>
        readWaveCatalogueWithDiagnostics(client, async () => raw, JSON.parse)
    );

    expect(value).toEqual({
      hit: true,
      value: [{ name: 'é', criteria: 'private-criterion' }]
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).not.toMatch(
      /private-criterion|private-wallet|é/
    );
    expect(loggedEvent(log)).toMatchObject({
      request_id: 'request-123',
      cache_outcome: 'hit',
      error_stage: null,
      catalogue_bytes: Buffer.byteLength(raw, 'utf8'),
      concurrent_reads_at_start: 1,
      max_concurrent_reads_during_read: 1,
      redis_ready_start: true,
      redis_ready_end: true,
      redis_open_start: true,
      redis_open_end: true,
      redis_reconnect_events_during_read: 0
    });
    expect(loggedEvent(log).get_ms).toEqual(expect.any(Number));
    expect(loggedEvent(log).parse_ms).toEqual(expect.any(Number));
  });

  it('separates misses and read errors without changing the returned value or error', async () => {
    const client = { isReady: true, isOpen: true };
    await expect(
      readWaveCatalogueWithDiagnostics(client, async () => null, JSON.parse)
    ).resolves.toEqual({ hit: false });
    expect(loggedEvent(log)).toMatchObject({
      cache_outcome: 'miss',
      catalogue_bytes: 0,
      parse_ms: null,
      error_stage: null
    });

    const error = new Error('secret Redis endpoint');
    await expect(
      readWaveCatalogueWithDiagnostics(
        client,
        async () => {
          throw error;
        },
        JSON.parse
      )
    ).rejects.toBe(error);
    expect(loggedEvent(log, 1)).toMatchObject({
      cache_outcome: 'error',
      error_stage: 'get',
      catalogue_bytes: null,
      parse_ms: null
    });
    expect(log.mock.calls[1][0]).not.toContain('secret Redis endpoint');

    await expect(
      readWaveCatalogueWithDiagnostics(client, async () => '{', JSON.parse)
    ).rejects.toThrow(SyntaxError);
    expect(loggedEvent(log, 2)).toMatchObject({
      cache_outcome: 'error',
      error_stage: 'parse',
      catalogue_bytes: 1
    });
  });

  it('preserves a present cache entry even when its parsed value is null', async () => {
    await expect(
      readWaveCatalogueWithDiagnostics(
        { isReady: true, isOpen: true },
        async () => 'null',
        JSON.parse
      )
    ).resolves.toEqual({ hit: true, value: null });
    expect(loggedEvent(log).cache_outcome).toBe('hit');
  });

  it('observes overlapping process-local reads and reconnection events during a read', async () => {
    let finishFirst: (value: string) => void = () => undefined;
    const firstGet = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    const client = { isReady: true, isOpen: true };
    const first = readWaveCatalogueWithDiagnostics(
      client,
      () => firstGet,
      JSON.parse
    );
    const second = readWaveCatalogueWithDiagnostics(
      client,
      async () => '[]',
      JSON.parse
    );
    events.reconnecting++;
    client.isReady = false;
    finishFirst('[]');
    await expect(Promise.all([first, second])).resolves.toEqual([
      { hit: true, value: [] },
      { hit: true, value: [] }
    ]);
    expect(log).toHaveBeenCalledTimes(2);
    const observations = [loggedEvent(log), loggedEvent(log, 1)];
    expect(
      observations
        .map((event) => event.concurrent_reads_at_start)
        .sort((a, b) => a - b)
    ).toEqual([1, 2]);
    expect(
      observations.every(
        (event) => event.max_concurrent_reads_during_read === 2
      )
    ).toBe(true);
    expect(
      observations.every(
        (event) => event.redis_reconnect_events_during_read === 1
      )
    ).toBe(true);
    expect(observations.every((event) => event.redis_ready_end === false)).toBe(
      true
    );
  });

  it('does no logging when disabled or misconfigured', async () => {
    const client = { isReady: true, isOpen: true };
    process.env.WAVE_CATALOGUE_READ_SAMPLE_RATE = '0';
    await readWaveCatalogueWithDiagnostics(
      client,
      async () => '[]',
      JSON.parse
    );
    process.env.WAVE_CATALOGUE_READ_SAMPLE_RATE = '2';
    await readWaveCatalogueWithDiagnostics(
      client,
      async () => '[]',
      JSON.parse
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('reports delay samples only from the GET interval', async () => {
    await readWaveCatalogueWithDiagnostics(
      { isReady: true, isOpen: true },
      () =>
        new Promise<string>((resolve) => setTimeout(() => resolve('[]'), 75)),
      JSON.parse
    );
    const event = loggedEvent(log);
    expect(event.get_ms).toBeGreaterThanOrEqual(50);
    expect(event.event_loop_monitor_active).toBe(true);
    expect(event.event_loop_delay_samples).toBeGreaterThan(0);
    expect(event.event_loop_delay_max_ms).toEqual(expect.any(Number));
  });

  it('caps per-process output and resets the cap after an idle minute', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000_000);
    try {
      for (let index = 0; index < 61; index++) {
        await readWaveCatalogueWithDiagnostics(
          { isReady: true, isOpen: true },
          async () => null,
          JSON.parse
        );
      }
      expect(log).toHaveBeenCalledTimes(60);
      now.mockReturnValue(10_000_000_061_000);
      await readWaveCatalogueWithDiagnostics(
        { isReady: true, isOpen: true },
        async () => null,
        JSON.parse
      );
      expect(log).toHaveBeenCalledTimes(61);
    } finally {
      now.mockRestore();
    }
  });
});
