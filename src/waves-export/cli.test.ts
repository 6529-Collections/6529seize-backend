const mockDoInDbContext = jest.fn();
jest.mock('@/secrets', () => ({
  doInDbContext: (...args: unknown[]) => mockDoInDbContext(...args)
}));
jest.mock('./waves-export.backend-source', () => ({
  BackendWavesExportSource: jest.fn()
}));
const mockExecute = jest.fn();
jest.mock('@/sql-executor', () => ({
  ...jest.requireActual('@/sql-executor'),
  sqlExecutor: { execute: (...args: unknown[]) => mockExecute(...args) }
}));
const mockWavesExport = jest.fn();
jest.mock('./waves-export.service', () => ({
  ...jest.requireActual('./waves-export.service'),
  WavesExport: jest.fn((...args: unknown[]) => mockWavesExport(...args))
}));

import { EXPORT_AFTER_FREEZE_MS, main } from './cli';
import { WavesExportUsageError } from './cli-options';
import { ALL_READERS_LAG_SQL } from './waves-export.replica-lag';

const REVISION = 'ab'.repeat(20);
const T_W = Date.UTC(2026, 10, 25, 0, 0, 0);
const EXPORT = [
  '--out',
  'OUT',
  '--revision',
  REVISION,
  '--freeze-at',
  '2026-11-25T00:00:00Z'
];

describe('waves:export and the freeze time', () => {
  let tz: string | undefined;
  beforeEach(() => {
    tz = process.env.TZ;
    mockDoInDbContext.mockReset().mockResolvedValue({ failed_waves: [] });
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('refuses to export before the freeze, without reading the database', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(T_W - 1);
    await expect(main(EXPORT)).rejects.toThrow(WavesExportUsageError);
    await expect(main(EXPORT)).rejects.toThrow(
      'The waves freeze is at 2026-11-25T00:00:00.000Z'
    );
    expect(mockDoInDbContext).not.toHaveBeenCalled();
  });

  it.each([
    ['at the freeze', T_W],
    ['a minute after it', T_W + 60_000],
    ['just under five minutes after it', T_W + EXPORT_AFTER_FREEZE_MS - 1]
  ])('refuses to export %s, naming the earliest start', async (_when, now) => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const refusal = main(EXPORT);
    await expect(refusal).rejects.toThrow(
      'The export starts from 2026-11-25T00:05:00.000Z'
    );
    await expect(refusal).rejects.toMatchObject({ showHelp: false });
    await expect(refusal).rejects.not.toThrow('--rehearsal');
    expect(mockDoInDbContext).not.toHaveBeenCalled();
  });

  it('exports from five minutes after the freeze on', async () => {
    expect(EXPORT_AFTER_FREEZE_MS).toBe(300_000);
    jest.spyOn(Date, 'now').mockReturnValue(T_W + EXPORT_AFTER_FREEZE_MS);
    await main(EXPORT);
    expect(mockDoInDbContext).toHaveBeenCalledTimes(1);
  });

  it('runs a rehearsal before the freeze', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(T_W - 1);
    await main(['--out', 'OUT', '--revision', REVISION, '--rehearsal']);
    expect(mockDoInDbContext).toHaveBeenCalledTimes(1);
  });
});

describe('waves:export and the read replica lag', () => {
  const NOW = T_W + EXPORT_AFTER_FREEZE_MS + 60_000;
  const reader = (lag: number) => ({
    server_id: 'r1',
    session_id: 'session-r1',
    lag_ms: lag,
    age_ms: 5,
    now_ms: NOW
  });
  const replicaLagGiven = () => mockWavesExport.mock.calls[0][1].replicaLag;
  let tz: string | undefined;
  let stderr: string[];
  beforeEach(() => {
    tz = process.env.TZ;
    mockDoInDbContext
      .mockReset()
      .mockImplementation((work: () => Promise<unknown>) => work());
    mockExecute.mockReset();
    mockWavesExport
      .mockReset()
      .mockReturnValue({ run: async () => ({ failed_waves: [] }) });
    stderr = [];
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("reads every reader's lag before any stage and records it", async () => {
    mockExecute.mockResolvedValue([reader(40)]);
    await main(EXPORT);
    expect(mockExecute).toHaveBeenCalledWith(ALL_READERS_LAG_SQL);
    expect(mockExecute.mock.invocationCallOrder[0]).toBeLessThan(
      mockWavesExport.mock.invocationCallOrder[0]
    );
    expect(replicaLagGiven()).toEqual({
      checked_by: 'export',
      readers: 1,
      worst_lag_ms: 40,
      worst_lag_age_ms: 5,
      read_at: new Date(NOW).toISOString()
    });
  });

  it('refuses before any stage reads when a reader is too far behind', async () => {
    mockExecute.mockResolvedValue([reader(60_000)]);
    const refusal = main(EXPORT);
    await expect(refusal).rejects.toThrow(WavesExportUsageError);
    await expect(refusal).rejects.toThrow(
      'The read replica may be up to 61.5 s behind'
    );
    expect(mockWavesExport).not.toHaveBeenCalled();
  });

  it('runs with --replica-lag-checked without reading the lag, loudly, and records it', async () => {
    await main([...EXPORT, '--replica-lag-checked']);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(replicaLagGiven()).toEqual({ checked_by: 'person' });
    expect(stderr.join('')).toContain('WARNING: --replica-lag-checked');
  });

  it('checks no lag for a rehearsal', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(T_W - 1);
    await main(['--out', 'OUT', '--revision', REVISION, '--rehearsal']);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(replicaLagGiven()).toBeNull();
  });
});
