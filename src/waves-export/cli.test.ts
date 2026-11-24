const mockDoInDbContext = jest.fn();
jest.mock('@/secrets', () => ({
  doInDbContext: (...args: unknown[]) => mockDoInDbContext(...args)
}));
jest.mock('./waves-export.backend-source', () => ({
  BackendWavesExportSource: jest.fn()
}));

import { EXPORT_AFTER_FREEZE_MS, main } from './cli';
import { WavesExportUsageError } from './cli-options';

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
