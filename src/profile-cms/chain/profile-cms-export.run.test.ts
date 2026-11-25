import { ProfileCmsExportReport } from '@/profile-cms/chain/profile-cms-export';
import {
  reportJson,
  runProfileCmsExport,
  storedPublicationFetcher
} from './profile-cms-export.run';

function report(): ProfileCmsExportReport {
  return {
    packages: 1,
    rebuilt_publications: [],
    rebuilt_refused: [],
    publication_unavailable: [],
    without_publication: [],
    bad_core: [],
    primary: null,
    primary_package_hash: null,
    primary_handle: null,
    primary_carried: false,
    primary_refused: null,
    primary_refused_at_publish: null,
    legacy_packages: 0,
    legacy_unverified: [],
    legacy_unverified_primaries: []
  };
}

const IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

function setup(delays: Record<string, number> = {}) {
  const writes: string[] = [];
  let running = 0;
  let peak = 0;
  const exportProfile = jest.fn(async (profileId: string) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, delays[profileId] ?? 1));
    running--;
    return {
      profile_id: profileId,
      handle: null,
      cms: { primary: null, archive: `bafy-archive-${profileId}` },
      files: [
        { cid: `bafy${profileId}`, bytes: Buffer.from(profileId) },
        { cid: 'bafyshared', bytes: Buffer.from('shared') }
      ],
      report: report()
    };
  });
  return {
    writes,
    exportProfile,
    peak: () => peak,
    deps: (concurrency: number) => ({
      db: {
        listProfileIds: async () => IDS,
        loadSource: async () => ({}) as never
      },
      exporter: { exportProfile } as never,
      sink: {
        writeFile: async (cid: string) => {
          writes.push(cid);
        }
      },
      concurrency
    })
  };
}

describe('runProfileCmsExport', () => {
  it('exports up to four profiles at once with the same result as one at a time', async () => {
    const delays = { p1: 30, p2: 5, p3: 20, p4: 1, p5: 10, p6: 2 };
    const serial = setup(delays);
    const parallel = setup(delays);
    const one = await runProfileCmsExport(
      { frozenAt: 1, profile: null, publicApi: null },
      serial.deps(1)
    );
    const four = await runProfileCmsExport(
      { frozenAt: 1, profile: null, publicApi: null },
      parallel.deps(4)
    );
    expect(serial.peak()).toBe(1);
    expect(parallel.peak()).toBe(4);
    expect(Object.keys(four.reports)).toEqual(IDS);
    expect(Object.keys(four.fields)).toEqual(IDS);
    expect(reportJson(1, four)).toBe(reportJson(1, one));
    expect(four.files).toBe(one.files);
    // The shared file is written once however the profiles interleave.
    expect(parallel.writes.filter((cid) => cid === 'bafyshared')).toHaveLength(
      1
    );
    expect([...parallel.writes].sort()).toEqual([...serial.writes].sort());
  });

  it.each([0, 5, 1.5])('refuses a concurrency of %p', async (concurrency) => {
    const { deps } = setup();
    await expect(
      runProfileCmsExport(
        { frozenAt: 1, profile: null, publicApi: null },
        deps(concurrency)
      )
    ).rejects.toThrow(/concurrency/);
  });

  it('stops starting profiles once one fails', async () => {
    const { deps, exportProfile } = setup({ p1: 1, p2: 1 });
    exportProfile.mockImplementationOnce(async () => {
      throw new Error('fetch failed');
    });
    await expect(
      runProfileCmsExport(
        { frozenAt: 1, profile: null, publicApi: null },
        deps(2)
      )
    ).rejects.toThrow('fetch failed');
    expect(exportProfile.mock.calls.length).toBeLessThan(IDS.length);
  });
});

describe('storedPublicationFetcher', () => {
  const receipt = { uri: 'ipfs://bafyrecord', content_hash: 'hash' };
  const FROZEN = Date.UTC(2026, 10, 24);

  it('asks the store for the record as it stood at the freeze, retrying a failure', async () => {
    const verify = jest
      .fn()
      .mockRejectedValueOnce(new Error('gateway timeout'))
      .mockResolvedValueOnce(Buffer.from('record'));
    const sleep = jest.fn(async () => undefined);
    const before = jest.fn();
    const fetch = storedPublicationFetcher(FROZEN, verify, sleep, before);
    await expect(fetch(receipt)).resolves.toEqual(Buffer.from('record'));
    expect(verify).toHaveBeenCalledWith({
      provider: 'ipfs',
      uri: 'ipfs://bafyrecord',
      content_hash: 'hash',
      recorded_at: '2026-11-24T00:00:00.000Z'
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(before).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives null after three failed attempts', async () => {
    const verify = jest.fn(async () => {
      throw new Error('gone');
    });
    const sleep = jest.fn(async () => undefined);
    await expect(
      storedPublicationFetcher(FROZEN, verify, sleep)(receipt)
    ).resolves.toBeNull();
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('lets a throw before an attempt stop the fetch, never retried', async () => {
    const deadline = new Error('out of time');
    const verify = jest.fn(async () => Buffer.from('record'));
    const sleep = jest.fn(async () => undefined);
    const fetch = storedPublicationFetcher(FROZEN, verify, sleep, () => {
      throw deadline;
    });
    await expect(fetch(receipt)).rejects.toBe(deadline);
    expect(verify).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops before a retry when the throw comes after a failed attempt', async () => {
    const deadline = new Error('out of time');
    const verify = jest.fn(async () => {
      throw new Error('gateway timeout');
    });
    const sleep = jest.fn(async () => undefined);
    let attempts = 0;
    const fetch = storedPublicationFetcher(FROZEN, verify, sleep, () => {
      if (++attempts === 2) throw deadline;
    });
    await expect(fetch(receipt)).rejects.toBe(deadline);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
