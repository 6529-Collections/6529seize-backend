import {
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { ProfileCmsExportReport } from '@/profile-cms/chain/profile-cms-export';
import { createHash } from 'node:crypto';
import {
  checkFreezeSetting,
  checkNoWritesAfterFreeze,
  checkSnapshotTime,
  parseProfileSiteExportEvent,
  ProfileSiteExportDeadlineError,
  ProfileSiteExportDeps,
  ProfileSiteExportEventError,
  ProfileSiteExportLinksResult,
  ProfileSiteExportResult,
  runProfileSiteExportJob
} from './profile-site-export.handler';

const OWNER = '000000000000';
const ARN = `arn:aws:lambda:eu-west-1:${OWNER}:function:dbDumpsDaily`;
const BUCKET = `6529-chain-exports-${OWNER}-eu-west-1`;
const T = Date.UTC(2026, 10, 24);
const FREEZE = '2026-11-24T00:00:00Z';

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
    latestWrites?: { packages?: number; legacy?: number; events?: number };
    getDenied?: boolean;
  } = {}
) {
  const order: string[] = [];
  const bodies = new Map<string, string>();
  const commands: any[] = [];
  const send = jest.fn(async (command: any) => {
    commands.push(command);
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
        throw Object.assign(new Error('denied or missing'), {
          name: options.getDenied ? 'AccessDenied' : 'NoSuchKey'
        });
      }
      return { Body: { transformToString: async () => body } };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  });
  const executor = {
    execute: jest.fn(async (sql: string) => {
      if (/max\(published_at\)/i.test(sql)) {
        return [
          {
            packages: options.latestWrites?.packages ?? T - 60_000,
            legacy: options.latestWrites?.legacy ?? null,
            events: options.latestWrites?.events ?? T - 120_000
          }
        ];
      }
      if (/select distinct profile_id/i.test(sql)) {
        return [{ profile_id: 'profile-a' }, { profile_id: 'profile-b' }];
      }
      if (/select handle, consolidation_key/i.test(sql)) {
        return [{ handle: 'alice', consolidation_key: '0xaaa' }];
      }
      return [];
    }),
    oneOrNull: async (sql: string) => (await executor.execute(sql))[0] ?? null
  };
  const close = jest.fn(async () => {
    if (options.closeFails) throw new Error('rollback failed');
  });
  let beforeFetch: () => void = () => undefined;
  const exportProfile = jest.fn(async (profileId: string) => {
    beforeFetch();
    return {
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
    };
  });
  const presigned: { owner: string; key: string }[] = [];
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
      IDENTITY_FREEZE_AT: FREEZE,
      ...options.env
    }),
    s3: { send } as never,
    presign: async (bucket, key, seconds) => {
      presigned.push({ owner: bucket.owner, key });
      return `https://signed/${bucket.name}/${key}?s=${seconds}`;
    },
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
    exporter: async (_frozenAt, guard) => {
      beforeFetch = guard;
      return { exportProfile } as never;
    },
    getJson: jest.fn(),
    now: (() => {
      let tick = T + 60_000;
      return () => new Date((tick += 1_000));
    })()
  };
  return {
    deps,
    send,
    commands,
    order,
    bodies,
    close,
    exportProfile,
    presigned
  };
}

const event = {
  job: 'profileSiteExport',
  frozenAt: T,
  profile: null,
  publicApi: null,
  acceptSnapshotGapMinutes: null,
  rehearsal: false,
  concurrency: 1
} as const;
const context = { invokedFunctionArn: ARN, awsRequestId: 'abcdef12-3456' };

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
        frozenAt: FREEZE
      })
    ).toEqual(event);
    expect(
      parseProfileSiteExportEvent({
        job: 'profileSiteExport',
        frozenAt: T,
        profile: 'profile-a',
        publicApi: 'https://api.example',
        rehearsal: true,
        concurrency: 4
      })
    ).toEqual({
      ...event,
      profile: 'profile-a',
      publicApi: 'https://api.example',
      rehearsal: true,
      concurrency: 4
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
    [{ job: 'profileSiteExport', frozenAt: T, rehearsal: 'yes' }],
    [{ job: 'profileSiteExport', frozenAt: T, concurrency: 5 }],
    [{ job: 'profileSiteExport', frozenAt: T, concurrency: 0 }],
    [{ job: 'profileSiteExportLinks', prefix: 'identity-export/x/' }],
    [{ job: 'profileSiteExportLinks', prefix: 'profile-site-export/../x/' }],
    [
      {
        job: 'profileSiteExportLinks',
        prefix: 'profile-site-export/prod/by-freeze/'
      }
    ]
  ])('refuses %j', (bad) => {
    expect(() => parseProfileSiteExportEvent(bad)).toThrow(
      ProfileSiteExportEventError
    );
  });
});

describe('the freeze checks', () => {
  it('measures the gap from the freeze to the snapshot', () => {
    expect(checkSnapshotTime(T, T, null)).toEqual({ gapSeconds: 0 });
    expect(checkSnapshotTime(T, T + 90 * 60_000, null)).toEqual({
      gapSeconds: 5400
    });
    expect(() => checkSnapshotTime(T, Number.NaN, null)).toThrow(/unknown/);
  });

  it('holds frozenAt to IDENTITY_FREEZE_AT when it is set', () => {
    expect(() => checkFreezeSetting(T, undefined)).not.toThrow();
    expect(() => checkFreezeSetting(T, FREEZE)).not.toThrow();
    expect(() => checkFreezeSetting(T, String(T))).not.toThrow();
    expect(() => checkFreezeSetting(T + 1, FREEZE)).toThrow(
      /not IDENTITY_FREEZE_AT/
    );
    expect(() => checkFreezeSetting(T, 'Tuesday')).toThrow(/not a time/);
  });

  it('refuses a snapshot holding site writes after the freeze', () => {
    expect(() =>
      checkNoWritesAfterFreeze(T, {
        packages: T,
        legacyPackages: null,
        pointerEvents: T - 1
      })
    ).not.toThrow();
    for (const late of [
      { packages: T + 1, legacyPackages: null, pointerEvents: null },
      { packages: null, legacyPackages: T + 1, pointerEvents: null },
      { packages: null, legacyPackages: null, pointerEvents: T + 1 }
    ]) {
      expect(() => checkNoWritesAfterFreeze(T, late)).toThrow(
        /writes after the freeze/
      );
    }
  });
});

describe('runProfileSiteExportJob', () => {
  it('reads the replica read-only, writes each file once, the manifest and then the pointer', async () => {
    const { deps, order, bodies, close, exportProfile, commands, presigned } =
      setup();
    const result = (await runProfileSiteExportJob(
      event,
      context,
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
      rehearsal: false,
      profiles: 2,
      profilesWithCms: 1,
      bucketPrivacy: {
        owner: OWNER,
        publicAccessBlocked: true,
        policyPublic: false
      },
      scope: { profile: null, publicApi: null },
      identityFreezeAt: FREEZE,
      snapshotAt: new Date(T + 30_000).toISOString(),
      snapshotGapSeconds: 30,
      latestSiteWrites: {
        packages: new Date(T - 60_000).toISOString(),
        legacy_packages: null,
        pointer_events: new Date(T - 120_000).toISOString()
      }
    });
    expect(result.prefix).toMatch(
      /^profile-site-export\/staging\/2026-11-24T00-01-01-000Z-abcdef12\/$/
    );
    const names = order.map((key) =>
      key.startsWith(result.prefix) ? key.slice(result.prefix.length) : key
    );
    expect(names).toEqual([
      'files/bafya',
      'files/bafyshared',
      'files/bafyb',
      'cms-fields.json',
      'report.json',
      'links.json',
      'manifest.json',
      'profile-site-export/staging/by-freeze/2026-11-24T00-00-00-000Z.json'
    ]);
    expect(result.manifestKey).toBe(`${result.prefix}manifest.json`);
    expect(result.pointerKey).toBe(names[7]);
    expect(JSON.parse(bodies.get(result.pointerKey!)!)).toMatchObject({
      prefix: result.prefix,
      manifest: result.manifestKey
    });
    const manifest = JSON.parse(bodies.get(result.manifestKey)!);
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual([
      'files/bafya',
      'files/bafyb',
      'files/bafyshared',
      'cms-fields.json',
      'report.json',
      'links.json'
    ]);
    // Every entry carries the digest of exactly what was stored.
    for (const file of manifest.files) {
      const body = bodies.get(result.prefix + file.name)!;
      expect(file.sha256).toBe(
        createHash('sha256').update(Buffer.from(body)).digest('hex')
      );
      expect(file.bytes).toBe(Buffer.byteLength(body));
    }
    expect(manifest).toMatchObject({
      usable: true,
      rehearsal: false,
      scope: { profile: null, publicApi: null },
      snapshot_at: new Date(T + 30_000).toISOString(),
      snapshot_gap_seconds: 30
    });
    // Every S3 call and every link names the function's own account.
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.input.ExpectedBucketOwner).toBe(OWNER);
    }
    for (const put of commands.filter((c) => c instanceof PutObjectCommand)) {
      expect(put.input.ChecksumSHA256).toBe(
        createHash('sha256')
          .update(Buffer.from(put.input.Body as Buffer))
          .digest('base64')
      );
    }
    expect(presigned.every((it) => it.owner === OWNER)).toBe(true);
    const links = JSON.parse(bodies.get(`${result.prefix}links.json`)!);
    expect(Object.keys(links.links)).toContain('manifest.json');
  });

  it('gives the same files and manifest order when exporting four at once', async () => {
    const one = setup();
    const four = setup();
    const a = (await runProfileSiteExportJob(
      event,
      context,
      one.deps
    )) as ProfileSiteExportResult;
    const b = (await runProfileSiteExportJob(
      { ...event, concurrency: 4 },
      context,
      four.deps
    )) as ProfileSiteExportResult;
    const files = (s: ReturnType<typeof setup>, r: ProfileSiteExportResult) =>
      JSON.parse(s.bodies.get(r.manifestKey)!).files.map(
        (f: { name: string; sha256: string }) => [f.name, f.sha256]
      );
    expect(files(four, b)).toEqual(files(one, a));
    expect(b.concurrency).toBe(4);
  });

  it('runs a rehearsal under a -rehearsal prefix, unusable and without a pointer', async () => {
    const { deps, order, bodies } = setup({
      env: { IDENTITY_FREEZE_AT: FREEZE },
      // Sites are still published before the freeze: recorded, not refused.
      latestWrites: { packages: T + 50_000 }
    });
    const result = (await runProfileSiteExportJob(
      { ...event, rehearsal: true, frozenAt: T + 20_000 },
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.prefix).toMatch(/-abcdef12-rehearsal\/$/);
    expect(result.manifestKey).toBe(`${result.prefix}manifest.unusable.json`);
    expect(result.pointerKey).toBeNull();
    expect(order.some((key) => key.includes('by-freeze'))).toBe(false);
    expect(JSON.parse(bodies.get(result.manifestKey)!)).toMatchObject({
      usable: false,
      rehearsal: true
    });
    expect(typeof result.seconds).toBe('number');
  });

  it('refuses a real run whose frozenAt is not IDENTITY_FREEZE_AT', async () => {
    const { deps, order } = setup();
    await expect(
      runProfileSiteExportJob({ ...event, frozenAt: T + 60_000 }, context, deps)
    ).rejects.toThrow(/not IDENTITY_FREEZE_AT/);
    expect(deps.openSnapshot).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('refuses a real run whose snapshot holds a publication after the freeze', async () => {
    const { deps, order, close } = setup({ latestWrites: { events: T + 5 } });
    await expect(runProfileSiteExportJob(event, context, deps)).rejects.toThrow(
      /writes after the freeze/
    );
    expect(order).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('writes no manifest when an upload fails, and still closes the snapshot', async () => {
    const { deps, order, close } = setup({ failPutOf: 'files/bafyb' });
    await expect(runProfileSiteExportJob(event, context, deps)).rejects.toThrow(
      'upload failed'
    );
    expect(order.some((key) => key.includes('manifest'))).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ DB_HOST_READ: undefined }],
    [{ DB_HOST_READ: 'primary-host' }],
    [{ DB_HOST_READ: ' PRIMARY-HOST ' }]
  ])('refuses without the read replica (%j)', async (env) => {
    const { deps, order } = setup({ env });
    await expect(runProfileSiteExportJob(event, context, deps)).rejects.toThrow(
      /read replica/
    );
    expect(deps.openSnapshot).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('refuses a bucket that does not block all public access', async () => {
    const { deps, order } = setup({ publicBlock: false });
    await expect(runProfileSiteExportJob(event, context, deps)).rejects.toThrow(
      /public access/
    );
    expect(deps.openSnapshot).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('names an unusable run manifest.unusable.json, never manifest.json', async () => {
    const { deps, bodies, order } = setup({ unavailable: true });
    const result = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.usable).toBe(false);
    expect(result.unavailableProfiles).toBe(1);
    expect(result.manifestKey).toBe(`${result.prefix}manifest.unusable.json`);
    expect(order.some((key) => key.endsWith('/manifest.json'))).toBe(false);
    expect(result.pointerKey).toBeNull();
    expect(JSON.parse(bodies.get(result.manifestKey)!).usable).toBe(false);
    const again = (await runProfileSiteExportJob(
      { job: 'profileSiteExportLinks', prefix: result.prefix },
      context,
      deps
    )) as ProfileSiteExportLinksResult;
    expect(again.manifestKey).toBe(result.manifestKey);
  });

  it('puts a one-profile run in its own prefix with manifest.partial.json', async () => {
    const { deps, bodies } = setup();
    const result = (await runProfileSiteExportJob(
      { ...event, profile: 'profile-a' },
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.prefix).toMatch(/-abcdef12-profile-profile-a\/$/);
    expect(result.manifestKey).toBe(`${result.prefix}manifest.partial.json`);
    expect(result.pointerKey).toBeNull();
    expect(result.scope).toEqual({ profile: 'profile-a', publicApi: null });
    expect(JSON.parse(bodies.get(result.manifestKey)!).scope).toEqual({
      profile: 'profile-a',
      publicApi: null
    });
  });

  it.each([
    ['before the freeze', T - 1_000, null, /before the freeze/],
    ['91 minutes after it', T + 91 * 60_000, null, /over the 90-minute limit/],
    ['3 hours after, allowed 120', T + 180 * 60_000, 120, /120-minute/]
  ])(
    'refuses a snapshot %s, and writes nothing',
    async (_name, snapshotAt, accept, message) => {
      const { deps, order, close } = setup({ snapshotAt });
      await expect(
        runProfileSiteExportJob(
          { ...event, acceptSnapshotGapMinutes: accept },
          context,
          deps
        )
      ).rejects.toThrow(message);
      expect(order).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts a later snapshot when the gap is allowed', async () => {
    const { deps } = setup({ snapshotAt: T + 180 * 60_000 });
    const result = (await runProfileSiteExportJob(
      { ...event, acceptSnapshotGapMinutes: 200 },
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.snapshotGapSeconds).toBe(180 * 60);
  });

  it('stops with its progress between profiles when time runs short', async () => {
    const { deps, order, close } = setup();
    // Plenty before the fetches; short after the first profile.
    const left = [120_000, 120_000, 30_000];
    const error = await runProfileSiteExportJob(
      event,
      { ...context, getRemainingTimeInMillis: () => left.shift() ?? 0 },
      deps
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProfileSiteExportDeadlineError);
    expect(error).toMatchObject({ done: 1, total: 2 });
    expect(error.message).toMatch(/1\/2 profiles/);
    expect(order.some((key) => key.includes('manifest'))).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops before fetching a stored record when time runs short', async () => {
    const { deps, exportProfile } = setup();
    const left = [120_000, 10_000];
    const error = await runProfileSiteExportJob(
      event,
      { ...context, getRemainingTimeInMillis: () => left.shift() ?? 0 },
      deps
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProfileSiteExportDeadlineError);
    expect(error.message).toMatch(/before fetching a stored record/);
    expect(exportProfile).toHaveBeenCalledTimes(1);
  });

  it('stops before the public API check when time runs short', async () => {
    const { deps } = setup();
    const left = [120_000, 120_000, 120_000, 120_000, 10_000];
    const error = await runProfileSiteExportJob(
      { ...event, publicApi: 'https://api.example' },
      { ...context, getRemainingTimeInMillis: () => left.shift() ?? 0 },
      deps
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProfileSiteExportDeadlineError);
    expect(error.message).toMatch(/before the public API check/);
    expect(deps.getJson).not.toHaveBeenCalled();
  });

  it('keeps the run error when closing the snapshot also fails', async () => {
    const { deps } = setup({ failPutOf: 'files/bafyb', closeFails: true });
    await expect(runProfileSiteExportJob(event, context, deps)).rejects.toThrow(
      'upload failed'
    );
  });

  it('finishes when only the closing rollback fails after a full read', async () => {
    const { deps } = setup({ closeFails: true });
    const result = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.usable).toBe(true);
  });

  it('gives fresh links for an earlier run from its manifest', async () => {
    const { deps, bodies } = setup();
    const first = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    const again = (await runProfileSiteExportJob(
      { job: 'profileSiteExportLinks', prefix: first.prefix },
      context,
      deps
    )) as ProfileSiteExportLinksResult;
    expect(again).toMatchObject({
      job: 'profileSiteExportLinks',
      bucket: BUCKET,
      manifestKey: first.manifestKey
    });
    const links = JSON.parse(bodies.get(again.linksKey)!);
    expect(Object.keys(links.links)).toContain('files/bafyshared');
    expect(Object.keys(links.links)).toContain('manifest.json');
  });

  it.each([
    [false, /that run didn't finish/],
    [true, /S3 refused the read/]
  ])(
    'says plainly when an earlier run has no manifest (read denied: %s)',
    async (getDenied, message) => {
      const { deps } = setup({ getDenied });
      await expect(
        runProfileSiteExportJob(
          {
            job: 'profileSiteExportLinks',
            prefix: 'profile-site-export/staging/missing/'
          },
          context,
          deps
        )
      ).rejects.toThrow(message);
    }
  );
});
