const mockDoInDbContext = jest.fn(async () => undefined);
const mockRun = jest.fn(async () => ({ job: 'identityExport' }));

jest.mock('../secrets', () => ({ doInDbContext: mockDoInDbContext }));
jest.mock('./identity-export.handler', () => ({
  ...jest.requireActual('./identity-export.handler'),
  runIdentityExportJob: mockRun
}));

import { handler } from './index';

const context = { awsRequestId: 'request' } as never;
const invoke = (event: unknown) =>
  (handler as (event: unknown, context: unknown) => Promise<unknown>)(
    event,
    context
  );

describe('dbDumpsDaily handler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs the daily dump on its schedule, and no export', async () => {
    await invoke({ source: 'aws.events', 'detail-type': 'Scheduled Event' });
    expect(mockDoInDbContext).toHaveBeenCalledTimes(1);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs the identity export for its job, and no dump', async () => {
    await expect(
      invoke({
        job: 'identityExport',
        noFreeze: true,
        revision: 'a'.repeat(40),
        noExtraIds: true,
        noCmsFields: true
      })
    ).resolves.toEqual({ job: 'identityExport' });
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'identityExport', freezeMs: null }),
      context
    );
    await invoke({
      job: 'identityExportLinks',
      prefix: 'identity-export/staging/run/'
    });
    expect(mockRun).toHaveBeenLastCalledWith(
      { job: 'identityExportLinks', prefix: 'identity-export/staging/run/' },
      context
    );
    expect(mockDoInDbContext).not.toHaveBeenCalled();
  });

  it('runs the dump for an empty event', async () => {
    await invoke({});
    expect(mockDoInDbContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ Job: 'identityExport', noFreeze: true }],
    [{ source: 'manual' }],
    [{ source: 'aws.events', job: 'nothing' }],
    [null],
    [[]]
  ])('refuses %j without running the dump', async (event) => {
    await expect(invoke(event)).rejects.toThrow();
    expect(mockDoInDbContext).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('fails an unknown or unreadable job without running the dump', async () => {
    await expect(invoke({ job: 'identityExprt' })).rejects.toThrow(
      /unknown job identityExprt/
    );
    await expect(invoke({ job: 'identityExport' })).rejects.toThrow(
      /freezeAt or noFreeze/
    );
    expect(mockDoInDbContext).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });
});
