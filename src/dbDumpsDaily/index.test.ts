const mockDoInDbContext = jest.fn(async () => undefined);
const mockIdentityRun = jest.fn(async () => ({ job: 'identityExport' }));
const mockSiteRun = jest.fn(async () => ({ job: 'profileSiteExport' }));

jest.mock('../secrets', () => ({ doInDbContext: mockDoInDbContext }));
jest.mock('./identity-export.handler', () => ({
  ...jest.requireActual('./identity-export.handler'),
  runIdentityExportJob: mockIdentityRun
}));
jest.mock('./profile-site-export.handler', () => ({
  ...jest.requireActual('./profile-site-export.handler'),
  runProfileSiteExportJob: mockSiteRun
}));
const mockWavesRun = jest.fn(async () => ({ job: 'wavesExport' }));
const mockUploadLink = jest.fn(async () => ({ key: 'made-up' }));
jest.mock('./waves-export.handler', () => ({
  ...jest.requireActual('./waves-export.handler'),
  runWavesExportJob: mockWavesRun,
  runWavesExportUploadLink: mockUploadLink
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
    expect(mockIdentityRun).not.toHaveBeenCalled();
    expect(mockSiteRun).not.toHaveBeenCalled();
  });

  it('runs the identity export for its job, and no dump or other job', async () => {
    await expect(
      invoke({
        job: 'identityExport',
        noFreeze: true,
        revision: 'a'.repeat(40),
        noExtraIds: true,
        noCmsFields: true
      })
    ).resolves.toEqual({ job: 'identityExport' });
    expect(mockIdentityRun).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'identityExport', freezeMs: null }),
      context
    );
    await invoke({
      job: 'identityExportLinks',
      prefix: 'identity-export/staging/run/'
    });
    expect(mockIdentityRun).toHaveBeenLastCalledWith(
      {
        job: 'identityExportLinks',
        prefix: 'identity-export/staging/run/',
        freezeMs: null
      },
      context
    );
    expect(mockSiteRun).not.toHaveBeenCalled();
    expect(mockDoInDbContext).not.toHaveBeenCalled();
  });

  it('runs the profile site export for its job, and no dump or other job', async () => {
    await expect(
      invoke({ job: 'profileSiteExport', frozenAt: '2026-11-24T00:00:00Z' })
    ).resolves.toEqual({ job: 'profileSiteExport' });
    expect(mockSiteRun).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'profileSiteExport' }),
      context
    );
    await invoke({
      job: 'profileSiteExportLinks',
      prefix: 'profile-site-export/staging/run/'
    });
    expect(mockSiteRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        job: 'profileSiteExportLinks',
        prefix: 'profile-site-export/staging/run/'
      }),
      context
    );
    expect(mockIdentityRun).not.toHaveBeenCalled();
    expect(mockDoInDbContext).not.toHaveBeenCalled();
  });

  it('runs the waves export for its job, and no dump or other job', async () => {
    await expect(
      invoke({
        job: 'wavesExport',
        freezeAt: '2026-11-26T00:00:00Z',
        revision: 'a'.repeat(40)
      })
    ).resolves.toEqual({ job: 'wavesExport' });
    expect(mockWavesRun).toHaveBeenCalledWith(
      expect.objectContaining({
        job: 'wavesExport',
        freezeMs: Date.UTC(2026, 10, 26),
        replicaLagCheckedBy: null
      }),
      context
    );
    expect(mockIdentityRun).not.toHaveBeenCalled();
    expect(mockSiteRun).not.toHaveBeenCalled();
    expect(mockDoInDbContext).not.toHaveBeenCalled();
  });

  it('signs the waves export upload link for its action, and runs no export', async () => {
    await expect(
      invoke({ job: 'wavesExport', action: 'upload-link', name: 'a.tar.gz' })
    ).resolves.toEqual({ key: 'made-up' });
    expect(mockUploadLink).toHaveBeenCalledWith(
      {
        job: 'wavesExport',
        action: 'upload-link',
        name: 'a.tar.gz',
        seconds: 7_200
      },
      context
    );
    expect(mockWavesRun).not.toHaveBeenCalled();
    expect(mockDoInDbContext).not.toHaveBeenCalled();
    await expect(
      invoke({ job: 'wavesExport', action: 'upload-link', name: '../a' })
    ).rejects.toThrow(/plain file name/);
    await expect(
      invoke({ job: 'wavesExport', action: 'export', name: 'a' })
    ).rejects.toThrow(/action must be "upload-link"/);
    expect(mockUploadLink).toHaveBeenCalledTimes(1);
    expect(mockWavesRun).not.toHaveBeenCalled();
  });

  it('runs the dump for an empty event', async () => {
    await invoke({});
    expect(mockDoInDbContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ Job: 'identityExport', noFreeze: true }],
    [{ Job: 'profileSiteExport', frozenAt: '2026-11-24T00:00:00Z' }],
    [{ source: 'manual' }],
    [{ source: 'aws.events', job: 'nothing' }],
    [null],
    [[]]
  ])('refuses %j without running the dump', async (event) => {
    await expect(invoke(event)).rejects.toThrow();
    expect(mockDoInDbContext).not.toHaveBeenCalled();
    expect(mockIdentityRun).not.toHaveBeenCalled();
    expect(mockSiteRun).not.toHaveBeenCalled();
  });

  it('fails an unknown or unreadable job without running the dump', async () => {
    await expect(invoke({ job: 'identityExprt' })).rejects.toThrow(
      /unknown job identityExprt/
    );
    await expect(invoke({ job: 'identityExport' })).rejects.toThrow(
      /freezeAt or noFreeze/
    );
    await expect(invoke({ job: 'profileSiteExprt' })).rejects.toThrow(
      /unknown job profileSiteExprt/
    );
    await expect(invoke({ job: 'profileSiteExport' })).rejects.toThrow(
      /frozenAt/
    );
    await expect(invoke({ job: 'wavesExprt' })).rejects.toThrow(
      /unknown job wavesExprt/
    );
    await expect(invoke({ job: 'wavesExport' })).rejects.toThrow(
      /freezeAt, or rehearsal/
    );
    expect(mockDoInDbContext).not.toHaveBeenCalled();
    expect(mockIdentityRun).not.toHaveBeenCalled();
    expect(mockSiteRun).not.toHaveBeenCalled();
    expect(mockWavesRun).not.toHaveBeenCalled();
  });
});
