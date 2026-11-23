const mockCloseSegments = jest.fn(async () => []);
const mockArchive = jest.fn(async () => 0);
const mockCreateSegmenter = jest.fn(() => ({
  closeSegments: mockCloseSegments,
  archive: mockArchive
}));

jest.mock('@/signed-records/record-log/record-log', () => ({
  createRecordLogSegmenter: () => mockCreateSegmenter()
}));
jest.mock('../secrets', () => ({
  doInDbContext: async (fn: () => Promise<unknown>) => fn()
}));
jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));

import { handler } from './index';

const run = () => (handler as unknown as () => Promise<void>)();

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
