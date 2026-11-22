const mockDoInDbContext = jest.fn(async () => undefined);
const mockRun = jest.fn(async () => ({ job: 'profileSiteExport' }));

jest.mock('../secrets', () => ({ doInDbContext: mockDoInDbContext }));
jest.mock('./profile-site-export.handler', () => ({
  ...jest.requireActual('./profile-site-export.handler'),
  runProfileSiteExportJob: mockRun
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

  it('runs the profile site export for its job, and no dump', async () => {
    await expect(
      invoke({ job: 'profileSiteExport', frozenAt: '2026-11-24T00:00:00Z' })
    ).resolves.toEqual({ job: 'profileSiteExport' });
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'profileSiteExport' }),
      context
    );
    expect(mockDoInDbContext).not.toHaveBeenCalled();
  });

  it('runs the dump for an empty event', async () => {
    await invoke({});
    expect(mockDoInDbContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ Job: 'profileSiteExport', frozenAt: '2026-11-24T00:00:00Z' }],
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
    await expect(invoke({ job: 'profileSiteExprt' })).rejects.toThrow(
      /unknown job profileSiteExprt/
    );
    await expect(invoke({ job: 'profileSiteExport' })).rejects.toThrow(
      /frozenAt/
    );
    expect(mockDoInDbContext).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });
});
