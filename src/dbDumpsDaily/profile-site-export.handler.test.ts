import {
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { ProfileCmsExportReport } from '@/profile-cms/chain/profile-cms-export';
import { createHash } from 'node:crypto';
import {
  checkSnapshotTime,
  parseProfileSiteExportEvent,
  ProfileSiteExportDeadlineError,
  ProfileSiteExportDeps,
  ProfileSiteExportEventError,
  ProfileSiteExportResult,
  runProfileSiteExportJob
} from './profile-site-export.handler';

const ARN = 'arn:aws:lambda:eu-west-1:000000000000:function:dbDumpsDaily';
const BUCKET = '6529-chain-exports-000000000000-eu-west-1';
const T = Date.UTC(2026, 10, 24);

function report(
  over: Partial<ProfileCmsExportReport> = {}
): ProfileCmsExportReport {
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
    legacy_unverified_primaries: [],
    ...over
  };
}

function setup(
  options: {
    env?: Record<string, string | undefined>;
    failPutOf?: string;
    publicBlock?: boolean;
    unavailable?: boolean;
    snapshotAt?: number;
    closeFails?: boolean;
    remainingMs?: () => number;
  } = {}
) {
  const order: string[] = [];
  const bodies = new Map<string, string>();
  const send = jest.fn(async (command: any) => {
    if (command instanceof GetPublicAccessBlockCommand) {
      const on = options.publicBlock ?? true;
      return {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: on,
          RestrictPublicBuckets: true
        }
      };
    }
    if (command instanceof GetBucketPolicyStatusCommand) {
      return { PolicyStatus: { IsPublic: false } };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      if (options.failPutOf && key.endsWith(options.failPutOf)) {
        throw new Error('upload failed');
      }
      order.push(key);
      bodies.set(key, Buffer.from(command.input.Body as Buffer).toString());
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const body = bodies.get(command.input.Key!);
      if (body === undefined) {
        throw Object.assign(new Error('The specified key does not exist.'), {
          name: 'NoSuchKey'
        });
      }
      return { Body: { transformToString: async () => body } };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  });
  const queries: string[] = [];
  const executor = {
    execute: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (/select distinct profile_id/i.test(sql)) {
        return [{ profile_id: 'profile-a' }, { profile_id: 'profile-b' }];
      }
      if (/select handle, consolidation_key/i.test(sql)) {
        return [{ handle: 'alice', consolidation_key: '0xaaa' }];
      }
      return [];
    }),
    oneOrNull: async (sql: string, params?: Record<string, unknown>) =>
      (await executor.execute(sql))[0] ?? null
  };
  const close = jest.fn(async () => {
    if (options.closeFails) throw new Error('rollback failed');
  });
  const exportProfile = jest.fn(async (profileId: string) => ({
    profile_id: profileId,
    handle: profileId === 'profile-a' ? 'alice' : null,
    cms:
      profileId === 'profile-a'
        ? {
            primary: { publication: 'bafypub', package: 'bafypkg' },
            archive: null
          }
        : null,
    // Both profiles name the shared file: it is written once.
    files: [
      { cid: `bafy${profileId.slice(-1)}`, bytes: Buffer.from(profileId) },
      { cid: 'bafyshared', bytes: Buffer.from('shared') }
    ],
    report: report({
      publication_unavailable:
        options.unavailable && profileId === 'profile-b' ? ['package'] : []
    })
  }));
  const deps: ProfileSiteExportDeps = {
    prepareEnvironment: jest.fn(async () => undefined),
    env: () => ({
      DB_HOST: 'primary-host',
      DB_HOST_READ: 'replica-host',
      DB_PORT: '3306',
      DB_USER_READ: 'reader',
      DB_PASS_READ: 'secret',
      DB_NAME: 'app',
      AWS_REGION: 'eu-west-1',
      NODE_ENV: 'development',
      ...options.env
    }),
    s3: { send } as never,
    presign: async (bucket, key, seconds) =>
      `https://signed/${bucket}/${key}?s=${seconds}`,
    openSnapshot: jest.fn(async (target) => ({
      executor: executor as never,
      evidence: {
        host: target.host,
        transactionReadOnly: true,
        serverReadOnly: true,
        innodbReadOnly: null,
        snapshotAt: new Date(options.snapshotAt ?? T + 30_000).toISOString()
      },
      close
    })),
    exporter: async () => ({ exportProfile }) as never,
    getJson: jest.fn(),
    now: (() => {
      let tick = T + 60_000;
      return () => new Date((tick += 1_000));
    })(),
    credentialsExpiry: async () => null
  };
  return { deps, send, order, bodies, queries, close, exportProfile };
}

const event = {
  job: 'profileSiteExport',
  frozenAt: T,
  profile: null,
  publicApi: null,
  acceptSnapshotGapMinutes: null
} as const;

describe('parseProfileSiteExportEvent', () => {
  it('leaves the schedule and other events to the daily dump', () => {
    expect(parseProfileSiteExportEvent(undefined)).toBeNull();
    expect(
      parseProfileSiteExportEvent({
        source: 'aws.events',
        'detail-type': 'Scheduled Event'
      })
    ).toBeNull();
    expect(parseProfileSiteExportEvent({ job: 'identityExport' })).toBeNull();
  });

  it('reads the CLI arguments, the freeze as ISO UTC or milliseconds', () => {
    expect(
      parseProfileSiteExportEvent({
        job: 'profileSiteExport',
        frozenAt: '2026-11-24T00:00:00Z'
      })
    ).toEqual(event);
    expect(
      parseProfileSiteExportEvent({
        job: 'profileSiteExport',
        frozenAt: T,
        profile: 'profile-a',
        publicApi: 'https://api.example'
      })
    ).toEqual({
      ...event,
      profile: 'profile-a',
      publicApi: 'https://api.example'
    });
  });

  it.each([
    [{ job: 'profileSiteExport' }],
    [{ job: 'profileSiteExport', frozenAt: '2026-11-24' }],
    [{ job: 'profileSiteExport', frozenAt: '2026-11-31T00:00:00Z' }],
    [{ job: 'profileSiteExport', frozenAt: 1795996800 }],
    [{ job: 'profileSiteExport', frozenAt: T, frozen_at: T }],
    [
      { job: 'profileSiteExport', frozenAt: T, publicApi: 'http://api.example' }
    ],
    [{ job: 'profileSiteExport', frozenAt: T, profile: 'a b' }],
    [{ job: 'profileSiteExport', frozenAt: T, acceptSnapshotGapMinutes: -1 }],
    [{ job: 'profileSiteExport', frozenAt: T, acceptSnapshotGapMinutes: '90' }],
    [{ job: 'profileSiteExportLinks', prefix: 'identity-export/x/' }],
    [{ job: 'profileSiteExportLinks', prefix: 'profile-site-export/../x/' }]
  ])('refuses %j', (bad) => {
    expect(() => parseProfileSiteExportEvent(bad)).toThrow(
      ProfileSiteExportEventError
    );
  });
});

describe('checkSnapshotTime', () => {
  it('measures the gap from the freeze to the snapshot', () => {
    expect(checkSnapshotTime(T, T, null)).toEqual({ gapSeconds: 0 });
    expect(checkSnapshotTime(T, T + 90 * 60_000, null)).toEqual({
      gapSeconds: 5400
    });
    expect(() => checkSnapshotTime(T, Number.NaN, null)).toThrow(/unknown/);
  });
});

describe('runProfileSiteExportJob', () => {
  it('reads the replica read-only, writes each file once, and the manifest last', async () => {
    const { deps, order, bodies, close, exportProfile } = setup();
    const result = (await runProfileSiteExportJob(
      event,
      {
        invokedFunctionArn: ARN,
        awsRequestId: 'abcdef12-3456'
      },
      deps
    )) as ProfileSiteExportResult;

    expect(deps.openSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'replica-host' })
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(exportProfile).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      bucket: BUCKET,
      host: 'replica-host',
      readOnly: true,
      usable: true,
      profiles: 2,
      profilesWithCms: 1,
      bucketPrivacy: { publicAccessBlocked: true, policyPublic: false },
      scope: { profile: null, publicApi: null },
      snapshotAt: new Date(T + 30_000).toISOString(),
      snapshotGapSeconds: 30
    });
    expect(result.prefix).toMatch(
      /^profile-site-export\/staging\/2026-11-24T00-01-01-000Z-abcdef12\/$/
    );
    const names = order.map((key) => key.slice(result.prefix.length));
    expect(names).toEqual([
      'files/bafya',
      'files/bafyshared',
      'files/bafyb',
      'cms-fields.json',
      'report.json',
      'links.json',
      'manifest.json'
    ]);
    expect(result.manifestKey).toBe(`${result.prefix}manifest.json`);
    const manifest = JSON.parse(bodies.get(result.manifestKey)!);
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(
      names.slice(0, 5)
    );
    // Every entry carries the digest of exactly what was stored.
    for (const file of manifest.files) {
      const body = bodies.get(result.prefix + file.name)!;
      expect(file.sha256).toBe(
        createHash('sha256').update(Buffer.from(body)).digest('hex')
      );
      expect(file.bytes).toBe(Buffer.byteLength(body));
    }
    expect(manifest).toMatchObject({
      scope: { profile: null, publicApi: null },
      snapshot_at: new Date(T + 30_000).toISOString(),
      snapshot_gap_seconds: 30
    });
    expect(manifest.read).toMatchObject({
      host: 'replica-host',
      read_only: true
    });
    const links = JSON.parse(bodies.get(`${result.prefix}links.json`)!);
    expect(Object.keys(links.links)).toEqual([
      ...names.slice(0, 5),
      'manifest.json'
    ]);
    expect(JSON.parse(bodies.get(`${result.prefix}cms-fields.json`)!)).toEqual({
      'profile-a': { primary: { publication: 'bafypub', package: 'bafypkg' } }
    });
    expect(result.presignedManifestUrl).toContain('manifest.json');
  });

  it('writes no manifest when an upload fails, and still closes the snapshot', async () => {
    const { deps, order, close } = setup({ failPutOf: 'files/bafyb' });
    await expect(
      runProfileSiteExportJob(event, { invokedFunctionArn: ARN }, deps)
    ).rejects.toThrow('upload failed');
    expect(order.some((key) => key.endsWith('manifest.json'))).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ DB_HOST_READ: undefined }],
    [{ DB_HOST_READ: 'primary-host' }],
    [{ DB_HOST_READ: ' PRIMARY-HOST ' }]
  ])('refuses without the read replica (%j)', async (env) => {
    const { deps, order } = setup({ env });
    await expect(
      runProfileSiteExportJob(event, { invokedFunctionArn: ARN }, deps)
    ).rejects.toThrow(/read replica/);
    expect(deps.openSnapshot).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('refuses a bucket that does not block all public access', async () => {
    const { deps, order } = setup({ publicBlock: false });
    await expect(
      runProfileSiteExportJob(event, { invokedFunctionArn: ARN }, deps)
    ).rejects.toThrow(/public access/);
    expect(deps.openSnapshot).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('names an unusable run manifest.unusable.json, never manifest.json', async () => {
    const { deps, bodies, order } = setup({ unavailable: true });
    const result = (await runProfileSiteExportJob(
      event,
      { invokedFunctionArn: ARN },
      deps
    )) as ProfileSiteExportResult;
    expect(result.usable).toBe(false);
    expect(result.unavailableProfiles).toBe(1);
    expect(result.manifestKey).toBe(result.prefix + 'manifest.unusable.json');
    expect(order.some((key) => key.endsWith('/manifest.json'))).toBe(false);
    expect(JSON.parse(bodies.get(result.manifestKey)!).usable).toBe(false);
    const again = await runProfileSiteExportJob(
      { job: 'profileSiteExportLinks', prefix: result.prefix },
      { invokedFunctionArn: ARN },
      deps
    );
    expect(again).toMatchObject({ usable: false });
  });

  it('puts a one-profile run in its own prefix and records the scope', async () => {
    const { deps, bodies } = setup();
    const result = (await runProfileSiteExportJob(
      { ...event, profile: 'profile-a' },
      { invokedFunctionArn: ARN, awsRequestId: 'abcdef12' },
      deps
    )) as ProfileSiteExportResult;
    expect(result.prefix).toMatch(/-abcdef12-profile-profile-a\/$/);
    expect(result.scope).toEqual({ profile: 'profile-a', publicApi: null });
    expect(JSON.parse(bodies.get(result.manifestKey)!).scope).toEqual({
      profile: 'profile-a',
      publicApi: null
    });
  });

  it.each([
    ['before the freeze', T - 1_000, null, /before the freeze/],
    ['91 minutes after it', T + 91 * 60_000, null, /over the 90-minute limit/],
    ['3 hours after, acknowledged 120', T + 180 * 60_000, 120, /120-minute/]
  ])(
    'refuses a snapshot %s, and writes nothing',
    async (_name, snapshotAt, accept, message) => {
      const { deps, order, close } = setup({ snapshotAt });
      await expect(
        runProfileSiteExportJob(
          { ...event, acceptSnapshotGapMinutes: accept },
          { invokedFunctionArn: ARN },
          deps
        )
      ).rejects.toThrow(message);
      expect(order).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts a later snapshot when the gap is acknowledged', async () => {
    const { deps } = setup({ snapshotAt: T + 180 * 60_000 });
    const result = (await runProfileSiteExportJob(
      { ...event, acceptSnapshotGapMinutes: 200 },
      { invokedFunctionArn: ARN },
      deps
    )) as ProfileSiteExportResult;
    expect(result.snapshotGapSeconds).toBe(180 * 60);
  });

  it('stops with its progress when the function is about to time out', async () => {
    const { deps, order, close } = setup();
    const left = [120_000, 30_000];
    const error = await runProfileSiteExportJob(
      event,
      {
        invokedFunctionArn: ARN,
        getRemainingTimeInMillis: () => left.shift() ?? 0
      },
      deps
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProfileSiteExportDeadlineError);
    expect(error).toMatchObject({ done: 1, total: 2 });
    expect(error.message).toMatch(/1\/2 profiles/);
    expect(order.some((key) => key.includes('manifest'))).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the run error when closing the snapshot also fails', async () => {
    const { deps } = setup({ failPutOf: 'files/bafyb', closeFails: true });
    await expect(
      runProfileSiteExportJob(event, { invokedFunctionArn: ARN }, deps)
    ).rejects.toThrow('upload failed');
  });

  it('limits the links to the signing credentials when they end first', async () => {
    const { deps } = setup();
    const soon = new Date(T + 2 * 60 * 60_000);
    const result = (await runProfileSiteExportJob(
      event,
      { invokedFunctionArn: ARN },
      { ...deps, credentialsExpiry: async () => soon }
    )) as ProfileSiteExportResult;
    expect(result.linksExpireAt).toBe(soon.toISOString());
    expect(result.linksLimitedByCredentials).toBe(true);
  });

  it('says plainly when an earlier run has no manifest', async () => {
    const { deps } = setup();
    await expect(
      runProfileSiteExportJob(
        {
          job: 'profileSiteExportLinks',
          prefix: 'profile-site-export/staging/missing/'
        },
        { invokedFunctionArn: ARN },
        deps
      )
    ).rejects.toThrow(
      /No manifest under profile-site-export\/staging\/missing\//
    );
  });

  it('gives fresh links for an earlier run from its manifest', async () => {
    const { deps, bodies } = setup();
    const first = (await runProfileSiteExportJob(
      event,
      { invokedFunctionArn: ARN },
      deps
    )) as ProfileSiteExportResult;
    const again = await runProfileSiteExportJob(
      { job: 'profileSiteExportLinks', prefix: first.prefix },
      { invokedFunctionArn: ARN },
      deps
    );
    expect(again).toMatchObject({
      job: 'profileSiteExportLinks',
      bucket: BUCKET
    });
    const links = JSON.parse(
      bodies.get((again as { linksKey: string }).linksKey)!
    );
    expect(Object.keys(links.links)).toContain('files/bafyshared');
    expect(Object.keys(links.links)).toContain('manifest.json');
  });
});
