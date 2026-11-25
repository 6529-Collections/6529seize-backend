const mockCloseSegments = jest.fn(async () => []);
const mockArchive = jest.fn(async () => 0);
const mockCreateSegmenter = jest.fn(() => ({
  closeSegments: mockCloseSegments,
  archive: mockArchive
}));

jest.mock('@/signed-records/record-log/record-log', () => ({
  createRecordLogSegmenter: () => mockCreateSegmenter()
}));
const mockSetFrozen = jest.fn(async (_frozen: boolean) => undefined);
const mockRunImport = jest.fn(async () => undefined);

jest.mock('@/personal-records/personal-records-state.db', () => ({
  personalRecordsStateDb: {
    setFrozen: (frozen: boolean) => mockSetFrozen(frozen)
  }
}));
jest.mock('@/personal-records/personal-import-task', () => ({
  runPersonalImport: () => mockRunImport()
}));
jest.mock('../secrets', () => ({
  doInDbContext: async (fn: () => Promise<unknown>) => fn()
}));
jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));

import { Logger } from '../logging';
import { handler } from './index';

const run = () => (handler as unknown as () => Promise<void>)();
const runTask = (task: string) =>
  (handler as unknown as (event: { task: string }) => Promise<void>)({
    task
  });

describe('signedRecordLogLoop', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('does nothing while the flag is off', async () => {
    delete process.env.FEATURE_SIGNED_RECORD_LOG;
    await run();
    expect(mockCreateSegmenter).not.toHaveBeenCalled();
  });

  it('posts and closes nothing when the records wave is none, and says so once', async () => {
    const info = jest.spyOn(Logger.get('SIGNED_RECORD_LOG_LOOP'), 'info');
    process.env.FEATURE_SIGNED_RECORD_LOG = 'true';
    process.env.SIGNED_RECORDS_WAVE_ID = 'none';
    for (const task of ['close', 'archive']) {
      process.env.SIGNED_RECORD_LOG_TASK = task;
      await run();
    }
    expect(mockCreateSegmenter).not.toHaveBeenCalled();
    expect(
      info.mock.calls.filter(([message]) =>
        String(message).includes('[RECORDS WAVE: none]')
      )
    ).toHaveLength(1);
    info.mockRestore();
  });

  it('refuses to freeze personal settings while no records wave is set', async () => {
    process.env.FEATURE_SIGNED_RECORD_LOG = 'true';
    process.env.SIGNED_RECORDS_WAVE_ID = 'none';
    await expect(runTask('personal-freeze')).rejects.toThrow(
      'no records wave set'
    );
    delete process.env.SIGNED_RECORDS_WAVE_ID;
    await expect(runTask('personal-freeze')).rejects.toThrow(
      'no records wave set'
    );
    expect(mockSetFrozen).not.toHaveBeenCalled();
    expect(mockCreateSegmenter).not.toHaveBeenCalled();
  });

  it('refuses the personal settings import while no records wave is set', async () => {
    process.env.FEATURE_SIGNED_RECORD_LOG = 'true';
    process.env.SIGNED_RECORDS_WAVE_ID = 'none';
    await expect(runTask('personal-import')).rejects.toThrow(
      'no records wave set'
    );
    delete process.env.SIGNED_RECORDS_WAVE_ID;
    await expect(runTask('personal-import')).rejects.toThrow(
      'no records wave set'
    );
    expect(mockRunImport).not.toHaveBeenCalled();
    expect(mockCreateSegmenter).not.toHaveBeenCalled();
  });

  it('unfreezes personal settings with the records wave none, posting nothing', async () => {
    process.env.FEATURE_SIGNED_RECORD_LOG = 'true';
    process.env.SIGNED_RECORDS_WAVE_ID = 'none';
    await runTask('personal-unfreeze');
    expect(mockSetFrozen).toHaveBeenCalledWith(false);
    expect(mockCreateSegmenter).not.toHaveBeenCalled();
  });

  it('freezes and imports once a records wave is set, posting nothing', async () => {
    process.env.FEATURE_SIGNED_RECORD_LOG = 'true';
    process.env.SIGNED_RECORDS_WAVE_ID = '00000000-0000-4000-8000-0000000000e1';
    await runTask('personal-freeze');
    await runTask('personal-import');
    expect(mockSetFrozen).toHaveBeenCalledWith(true);
    expect(mockRunImport).toHaveBeenCalledTimes(1);
    expect(mockCreateSegmenter).not.toHaveBeenCalled();
  });

  it('closes segments, or archives when told to', async () => {
    process.env.FEATURE_SIGNED_RECORD_LOG = 'true';
    process.env.SIGNED_RECORD_LOG_TASK = 'close';
    await run();
    expect(mockCloseSegments).toHaveBeenCalledTimes(1);
    expect(mockArchive).not.toHaveBeenCalled();
    process.env.SIGNED_RECORD_LOG_TASK = 'archive';
    await run();
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(mockCloseSegments).toHaveBeenCalledTimes(1);
  });
});
