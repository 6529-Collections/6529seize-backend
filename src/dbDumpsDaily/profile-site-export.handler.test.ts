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
  checkReplicaLag,
  checkSnapshotTime,
  checkWritesAfterFreeze,
  jobRecordFetcher,
  latestSiteWrites,
  parseProfileSiteExportEvent,
  ProfileSiteExportDeadlineError,
  ProfileSiteExportDeps,
  ProfileSiteExportEventError,
  ProfileSiteExportLinksResult,
  ProfileSiteExportResult,
  readFreezeSetting,
  runProfileSiteExportJob,
  WriteAfterFreeze,
  writesAfterFreeze
} from './profile-site-export.handler';

const OWNER = '000000000000';
const ARN = `arn:aws:lambda:eu-west-1:${OWNER}:function:dbDumpsDaily`;
const BUCKET = `6529-chain-exports-${OWNER}-eu-west-1`;
const T = Date.UTC(2026, 10, 24);
const FREEZE = '2026-11-24T00:00:00Z';
const POINTER =
  'profile-site-export/staging/by-freeze/2026-11-24T00-00-00-000Z.json';

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

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex');
}

function setup(
  options: {
    env?: Record<string, string | undefined>;
    failPutOf?: string;
    publicBlock?: boolean;
    unavailable?: boolean;
    snapshotAt?: number;
    replicaLagMs?: number | null;
    /** The age of the lag's row; 0 when not given. */
    replicaLagAgeMs?: number;
    closeFails?: boolean;
    latestWrites?: {
      packages?: number;
      archived?: number;
      legacy?: number;
      events?: number;
    };
    late?: { source: string; package_id: string; at: number }[];
    getDenied?: boolean;
    /** Every read of an object fails outright. */
    getFails?: boolean;
    verifyFails?: number;
    /** The pointer write lands, but its answer is lost and the retry refused. */
    pointerAnswerLost?: boolean;
    /** IDENTITY_FREEZE_AT in the secret; FREEZE when not given. */
    freezeSecret?: string;
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
      if (
        options.pointerAnswerLost &&
        key.includes('/by-freeze/') &&
        !bodies.has(key)
      ) {
        // The first attempt lands; the SDK's retry finds it there.
        order.push(key);
        bodies.set(key, Buffer.from(command.input.Body as Buffer).toString());
      }
      if (command.input.IfNoneMatch === '*' && bodies.has(key)) {
        throw Object.assign(new Error('At least one of the pre-conditions'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 }
        });
      }
      order.push(key);
      bodies.set(key, Buffer.from(command.input.Body as Buffer).toString());
      return {};
    }
    if (command instanceof GetObjectCommand) {
      if (options.getFails) throw new Error('socket hang up');
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
    execute: jest.fn(async (sql: string, _params?: Record<string, any>) => {
      if (/max\(published_at\)/i.test(sql)) {
        return [
          {
            packages: options.latestWrites?.packages ?? T - 60_000,
            archived: options.latestWrites?.archived ?? null,
            legacy: options.latestWrites?.legacy ?? null,
            events: options.latestWrites?.events ?? T - 120_000
          }
        ];
      }
      if (/select distinct profile_id/i.test(sql)) {
        return [{ profile_id: 'profile-a' }, { profile_id: 'profile-b' }];
      }
      if (/union all/i.test(sql)) {
        return options.late ?? [];
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
  // The job's own fetcher, retry and all; only the store behind it is fake.
  let fails = options.verifyFails ?? 0;
  const verify = jest.fn(async () => {
    if (fails-- > 0) throw new Error('gateway timeout');
    return Buffer.from('record');
  });
  const sleep = jest.fn(async () => undefined);
  let fetchRecord: ReturnType<typeof jobRecordFetcher> = async () => null;
  const exportProfile = jest.fn(async (profileId: string) => {
    // As the exporter does for a package with a stored record.
    await fetchRecord({
      uri: `ipfs://bafyrecord${profileId}`,
      content_hash: 'h'
    });
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
  // The lambdas secret as it is now; a test may change it between runs.
  const secret: { IDENTITY_FREEZE_AT: string | undefined } = {
    IDENTITY_FREEZE_AT:
      'freezeSecret' in options ? options.freezeSecret : FREEZE
  };
  const deps: ProfileSiteExportDeps = {
    prepareEnvironment: jest.fn(async () => undefined),
    identityFreezeAt: jest.fn(async () => ({
      secretId: 'prod/lambdas',
      key: 'IDENTITY_FREEZE_AT',
      value: secret.IDENTITY_FREEZE_AT
    })),
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
        snapshotAt: new Date(options.snapshotAt ?? T + 150_000).toISOString(),
        replicaLagMs:
          options.replicaLagMs === undefined ? 40 : options.replicaLagMs,
        replicaLagAgeMs:
          options.replicaLagMs === null ? null : (options.replicaLagAgeMs ?? 0),
        replicaLagError:
          options.replicaLagMs === null
            ? "ER_UNKNOWN_TABLE 1109: Unknown table 'REPLICA_HOST_STATUS' in information_schema"
            : null
      },
      close
    })),
    exporter: async (frozenAt, guard) => {
      fetchRecord = jobRecordFetcher(frozenAt, guard, verify, sleep);
      return { exportProfile } as never;
    },
    getJson: jest.fn(),
    now: (() => {
      let tick = T + 180_000;
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
    executor,
    verify,
    sleep,
    secret,
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
  concurrency: 1,
  acceptWritesAfterFreeze: [],
  acceptUnknownReplicaLag: false,
  replacePointer: false
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
        concurrency: 4,
        acceptWritesAfterFreeze: [
          'packages:pkg-1@2026-11-24T00:00:00.005Z',
          'legacy_packages:sha256:abc@2026-11-24T00:00:01.000Z'
        ],
        acceptUnknownReplicaLag: true
      })
    ).toEqual({
      ...event,
      profile: 'profile-a',
      publicApi: 'https://api.example',
      rehearsal: true,
      concurrency: 4,
      acceptWritesAfterFreeze: [
        'packages:pkg-1@2026-11-24T00:00:00.005Z',
        'legacy_packages:sha256:abc@2026-11-24T00:00:01.000Z'
      ],
      acceptUnknownReplicaLag: true
    });
  });

  it('reads replacePointer for a real run of every profile only', () => {
    expect(
      parseProfileSiteExportEvent({
        job: 'profileSiteExport',
        frozenAt: T,
        replacePointer: true
      })
    ).toEqual({ ...event, replacePointer: true });
    for (const bad of [
      { replacePointer: 'yes' },
      { replacePointer: true, rehearsal: true },
      { replacePointer: true, profile: 'profile-a' }
    ]) {
      expect(() =>
        parseProfileSiteExportEvent({
          job: 'profileSiteExport',
          frozenAt: T,
          ...bad
        })
      ).toThrow(ProfileSiteExportEventError);
    }
  });

  it('finds a run for fresh links by its prefix or by its freeze', () => {
    expect(
      parseProfileSiteExportEvent({
        job: 'profileSiteExportLinks',
        prefix: 'profile-site-export/prod/run/'
      })
    ).toEqual({
      job: 'profileSiteExportLinks',
      prefix: 'profile-site-export/prod/run/',
      frozenAt: null
    });
    expect(
      parseProfileSiteExportEvent({
        job: 'profileSiteExportLinks',
        frozenAt: FREEZE
      })
    ).toEqual({ job: 'profileSiteExportLinks', prefix: null, frozenAt: T });
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
    [{ job: 'profileSiteExport', frozenAt: T, acceptWritesAfterFreeze: 'p' }],
    [
      {
        job: 'profileSiteExport',
        frozenAt: T,
        acceptWritesAfterFreeze: ['a b']
      }
    ],
    // A package id alone, or a time not as the refusal writes it.
    [
      {
        job: 'profileSiteExport',
        frozenAt: T,
        acceptWritesAfterFreeze: ['pkg-1']
      }
    ],
    [
      {
        job: 'profileSiteExport',
        frozenAt: T,
        acceptWritesAfterFreeze: ['packages:pkg-1@2026-11-24T00:00:00Z']
      }
    ],
    [
      {
        job: 'profileSiteExport',
        frozenAt: T,
        acceptWritesAfterFreeze: ['drops:pkg-1@2026-11-24T00:00:00.005Z']
      }
    ],
    [{ job: 'profileSiteExport', frozenAt: T, acceptUnknownReplicaLag: 'yes' }],
    [
      {
        job: 'profileSiteExport',
        frozenAt: T,
        acceptWritesAfterFreeze: Array.from({ length: 101 }, (_, i) => `p${i}`)
      }
    ],
    [{ job: 'profileSiteExportLinks' }],
    [
      {
        job: 'profileSiteExportLinks',
        prefix: 'profile-site-export/prod/run/',
        frozenAt: T
      }
    ],
    [{ job: 'profileSiteExportLinks', frozenAt: 'Tuesday' }],
    [{ job: 'profileSiteExportLinks', prefix: 'identity-export/x/' }],
    [{ job: 'profileSiteExportLinks', prefix: 'profile-site-export/../x/' }],
    [
      {
        job: 'profileSiteExportLinks',
        prefix: 'profile-site-export/prod/by-freeze/'
      }
    ],
    [
      {
        job: 'profileSiteExportLinks',
        prefix: 'profile-site-export/prod/renewed-links/'
      }
    ],
    [
      { job: 'profileSiteExportLinks', prefix: 'profile-site-export/prod/a/b/' }
    ],
    [{ job: 'profileSiteExportLinks', prefix: 'profile-site-export/prod/' }]
  ])('refuses %j', (bad) => {
    expect(() => parseProfileSiteExportEvent(bad)).toThrow(
      ProfileSiteExportEventError
    );
  });
});

describe('the freeze checks', () => {
  it('measures the gap from the freeze to the snapshot', () => {
    expect(checkSnapshotTime(T, T, null)).toEqual({ gapMs: 0, gapSeconds: 0 });
    expect(checkSnapshotTime(T, T + 90 * 60_000, null)).toEqual({
      gapMs: 5_400_000,
      gapSeconds: 5400
    });
    expect(() => checkSnapshotTime(T, Number.NaN, null)).toThrow(/unknown/);
    // In milliseconds: a snapshot 400 ms before the freeze is before it.
    expect(() => checkSnapshotTime(T, T - 400, null)).toThrow(
      /^The snapshot \(2026-11-23T23:59:59.600Z\) is before the freeze/
    );
    expect(() => checkSnapshotTime(T, T + 90 * 60_000 + 400, null)).toThrow(
      /over the 90-minute limit/
    );
  });

  it('holds a snapshot to a minimum gap after the freeze', () => {
    expect(checkSnapshotTime(T, T + 120_000, null, 120)).toEqual({
      gapMs: 120_000,
      gapSeconds: 120
    });
    expect(() => checkSnapshotTime(T, T + 119_000, null, 120)).toThrow(
      /119 s after the freeze: wait until at least 120 s/
    );
    // 119.6 s would round to 120.
    expect(() => checkSnapshotTime(T, T + 119_600, null, 120)).toThrow(
      /119.6 s after the freeze/
    );
  });

  const lag = (
    replicaLagMs: number | null,
    replicaLagAgeMs: number | null = replicaLagMs === null ? null : 0,
    replicaLagError: string | null = null
  ) => ({ replicaLagMs, replicaLagAgeMs, replicaLagError });

  it('refuses a replica as far behind its writer as the gap, or further', () => {
    expect(() => checkReplicaLag(150_000, lag(149_999))).not.toThrow();
    expect(() => checkReplicaLag(150_000, lag(150_000))).toThrow(
      /150000 ms behind its writer \(a 150000 ms lag in a row 0 ms old\), not less than the 150000 ms/
    );
    expect(() => checkReplicaLag(150_000, lag(3_600_000))).toThrow(
      /behind its writer/
    );
    // The gap isn't rounded: 150.4 s is more than a 150.2 s lag.
    expect(() => checkReplicaLag(150_400, lag(150_200))).not.toThrow();
    expect(() => checkReplicaLag(150_400, lag(150_400))).toThrow(/behind/);
  });

  it('counts a stale row: its lag plus its age', () => {
    // At 00:05 the reader is 6 minutes behind, but its row, last written
    // at 23:59, still says 20 ms.
    expect(() => checkReplicaLag(300_000, lag(20, 360_000))).toThrow(
      /360020 ms behind its writer \(a 20 ms lag in a row 360000 ms old\)/
    );
    expect(() => checkReplicaLag(150_000, lag(20, 149_979))).not.toThrow();
    expect(() => checkReplicaLag(150_000, lag(20, 149_980))).toThrow(/behind/);
  });

  it('refuses an unknown lag, saying to run again, when to accept it, and why it is unknown', () => {
    expect(() => checkReplicaLag(150_000, lag(null))).toThrow(
      /\(no reason given\)\. Run again first: a passing error, such as a timeout, clears\. Accept an unknown lag \(acceptUnknownReplicaLag: true\) only for an error Monday's rehearsal also showed, ER_UNKNOWN_TABLE 1109 or ER_UNKNOWN_SYSTEM_VARIABLE 1193 \(the reader isn't Aurora\), and only with the switch owner's agreement\. Any other error is a fault in the export: report it\./
    );
    expect(() =>
      checkReplicaLag(150_000, lag(null, null, 'ER_PARSE_ERROR 1064: syntax'))
    ).toThrow(/\(ER_PARSE_ERROR 1064: syntax\)/);
    expect(() => checkReplicaLag(150_000, lag(null), true)).not.toThrow();
    // A lag without its row's age is an unknown lag too.
    expect(() => checkReplicaLag(150_000, lag(20, null))).toThrow(
      /can't be read/
    );
  });

  it('reads IDENTITY_FREEZE_AT as the site does', () => {
    expect(readFreezeSetting(undefined)).toEqual({
      reading: 'unset',
      at: null
    });
    expect(readFreezeSetting(' ')).toEqual({ reading: 'unset', at: null });
    expect(readFreezeSetting('Tuesday')).toEqual({
      reading: 'not_a_time',
      at: null
    });
    for (const raw of [
      FREEZE,
      '2026-11-24T00:00:00+00:00',
      '2026-11-24T00:00:00.000Z',
      '2026-11-24T00:00:00.000+00:00',
      String(T)
    ]) {
      expect(readFreezeSetting(raw)).toEqual({ reading: 'time', at: T });
    }
  });

  it('holds a real run to IDENTITY_FREEZE_AT, which must be set', () => {
    expect(() =>
      checkFreezeSetting(T, readFreezeSetting(FREEZE))
    ).not.toThrow();
    expect(() => checkFreezeSetting(T, readFreezeSetting(undefined))).toThrow(
      /IDENTITY_FREEZE_AT is not set/
    );
    expect(() => checkFreezeSetting(T, readFreezeSetting(''))).toThrow(
      /not set/
    );
    expect(() => checkFreezeSetting(T + 1, readFreezeSetting(FREEZE))).toThrow(
      /not IDENTITY_FREEZE_AT/
    );
    expect(() => checkFreezeSetting(T, readFreezeSetting('Tuesday'))).toThrow(
      /not a time/
    );
  });

  const late = (packageId: string, offset = 5): WriteAfterFreeze => {
    const at = new Date(T + offset).toISOString();
    return {
      source: 'packages',
      packageId,
      at,
      token: `packages:${packageId}@${at}`
    };
  };

  it('refuses site writes after the freeze unless each one was accepted', () => {
    expect(() => checkWritesAfterFreeze([], [])).not.toThrow();
    expect(() =>
      checkWritesAfterFreeze(
        [late('pkg-1'), late('pkg-1')],
        ['packages:pkg-1@2026-11-24T00:00:00.005Z']
      )
    ).not.toThrow();
    expect(() => checkWritesAfterFreeze([late('pkg-1')], [])).toThrow(
      /accepted: packages:pkg-1@2026-11-24T00:00:00.005Z\. Send this to the on-call engineer and the switch owner.*exactly as written here/
    );
    expect(() =>
      checkWritesAfterFreeze(
        [late('pkg-1'), late('pkg-2')],
        ['packages:pkg-1@2026-11-24T00:00:00.005Z']
      )
    ).toThrow(/no one has accepted: packages:pkg-2@/);
    // The same package written again later is a new write.
    expect(() =>
      checkWritesAfterFreeze(
        [late('pkg-1'), late('pkg-1', 9)],
        ['packages:pkg-1@2026-11-24T00:00:00.005Z']
      )
    ).toThrow(/accepted: packages:pkg-1@2026-11-24T00:00:00.009Z\./);
    // A bare package id accepts nothing.
    expect(() => checkWritesAfterFreeze([late('pkg-1')], ['pkg-1'])).toThrow(
      /no one has accepted/
    );
    const many = Array.from({ length: 101 }, (_, i) => late(`p${i}`));
    expect(() =>
      checkWritesAfterFreeze(
        many,
        many.map((it) => it.token)
      )
    ).toThrow(/more than 100/);
  });

  it('reads the latest publication, archive and pointer change', async () => {
    const { executor } = setup({ latestWrites: { archived: T + 7 } });
    await expect(latestSiteWrites(executor as never)).resolves.toEqual({
      packages: T - 60_000,
      archivedPackages: T + 7,
      legacyPackages: null,
      pointerEvents: T - 120_000
    });
    expect(executor.execute.mock.calls[0][0]).toMatch(/max\(archived_at\)/);
  });

  it('reads site writes after the freeze by package, from all three tables', async () => {
    const { executor } = setup({
      late: [
        { source: 'packages', package_id: 'pkg-1', at: T + 5 },
        { source: 'pointer_events', package_id: 'pkg-2', at: T + 6 }
      ]
    });
    await expect(writesAfterFreeze(executor as never, T)).resolves.toEqual([
      {
        source: 'packages',
        packageId: 'pkg-1',
        at: '2026-11-24T00:00:00.005Z',
        token: 'packages:pkg-1@2026-11-24T00:00:00.005Z'
      },
      {
        source: 'pointer_events',
        packageId: 'pkg-2',
        at: '2026-11-24T00:00:00.006Z',
        token: 'pointer_events:pkg-2@2026-11-24T00:00:00.006Z'
      }
    ]);
    const [sql, params] = executor.execute.mock.calls[0];
    expect(params).toEqual({ frozenAt: T });
    expect(sql).toMatch(/archived_at > :frozenAt/);
    expect(sql).toMatch(/profile_cms_pointer_events/);
    expect(sql).toMatch(/cms_published_packages/);
    expect(sql).toMatch(/limit 101/);
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
      stage: 'staging',
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
      identityFreezeAtSecret: 'prod/lambdas',
      identityFreezeAtReading: 'time',
      identityFreezeAt: '2026-11-24T00:00:00.000Z',
      snapshotAt: new Date(T + 150_000).toISOString(),
      snapshotGapSeconds: 150,
      snapshotGapMs: 150_000,
      evidence: { replicaLagMs: 40, replicaLagAgeMs: 0, replicaLagError: null },
      latestSiteWrites: {
        packages: new Date(T - 60_000).toISOString(),
        archived_packages: null,
        legacy_packages: null,
        pointer_events: new Date(T - 120_000).toISOString()
      },
      writesAfterFreeze: [],
      acceptedWritesAfterFreeze: [],
      pointerError: null
    });
    expect(result.prefix).toMatch(
      /^profile-site-export\/staging\/2026-11-24T00-03-01-000Z-abcdef12\/$/
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
      POINTER
    ]);
    expect(result.manifestKey).toBe(`${result.prefix}manifest.json`);
    expect(result.manifestSha256).toBe(sha256(bodies.get(result.manifestKey)!));
    expect(result.pointerKey).toBe(POINTER);
    expect(result.presignedPointerUrl).toBe(
      `https://signed/${BUCKET}/${POINTER}?s=21600`
    );
    // The pointer is written only where none is.
    const pointerPut = commands.find(
      (c) => c instanceof PutObjectCommand && c.input.Key === POINTER
    );
    expect(pointerPut.input.IfNoneMatch).toBe('*');
    expect(JSON.parse(bodies.get(POINTER)!)).toMatchObject({
      prefix: result.prefix,
      manifest: result.manifestKey,
      manifest_sha256: result.manifestSha256
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
      expect(file.sha256).toBe(sha256(body));
      expect(file.bytes).toBe(Buffer.byteLength(body));
    }
    expect(manifest).toMatchObject({
      usable: true,
      rehearsal: false,
      stage: 'staging',
      scope: { profile: null, publicApi: null },
      identity_freeze_at: {
        secret: 'prod/lambdas',
        reading: 'time',
        at: '2026-11-24T00:00:00.000Z'
      },
      replace_pointer: false,
      snapshot_at: new Date(T + 150_000).toISOString(),
      snapshot_gap_seconds: 150,
      snapshot_gap_ms: 150_000,
      read: { replicaLagMs: 40, replicaLagAgeMs: 0, read_only: true },
      latest_site_writes: { archived_packages: null },
      writes_after_freeze: [],
      accepted_writes_after_freeze: []
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
    const linksBody = bodies.get(`${result.prefix}links.json`)!;
    const links = JSON.parse(linksBody);
    expect(Object.keys(links.links)).toContain('manifest.json');
    expect(result.linksBytes).toBe(Buffer.byteLength(linksBody));
    expect(
      manifest.files.find((f: { name: string }) => f.name === 'links.json')
        .bytes
    ).toBe(result.linksBytes);
  });

  it('names the stage from NODE_ENV: production is prod', async () => {
    const { deps, order } = setup({ env: { NODE_ENV: 'production' } });
    const result = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.stage).toBe('prod');
    expect(result.prefix).toMatch(/^profile-site-export\/prod\//);
    expect(result.pointerKey).toBe(
      'profile-site-export/prod/by-freeze/2026-11-24T00-00-00-000Z.json'
    );
    expect(order).toContain(result.pointerKey);
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
    const lateWrite = {
      source: 'packages',
      package_id: 'pkg-9',
      at: T + 50_000
    };
    const { deps, order, bodies } = setup({
      // Sites are still published before the freeze: recorded, not refused.
      latestWrites: { packages: T + 50_000 },
      late: [lateWrite],
      // Neither the minimum gap nor the lag holds a rehearsal.
      snapshotAt: T + 30_000,
      replicaLagMs: 60_000
    });
    const result = (await runProfileSiteExportJob(
      { ...event, rehearsal: true, frozenAt: T + 20_000 },
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.prefix).toMatch(/-abcdef12-rehearsal\/$/);
    expect(result.manifestKey).toBe(`${result.prefix}manifest.unusable.json`);
    // Every record was there, but a rehearsal is never the export.
    expect(result.unavailableProfiles).toBe(0);
    expect(result.usable).toBe(false);
    expect(result.pointerKey).toBeNull();
    expect(result.presignedPointerUrl).toBeNull();
    expect(result.snapshotGapSeconds).toBe(10);
    expect(result.writesAfterFreeze).toEqual([
      {
        source: 'packages',
        packageId: 'pkg-9',
        at: '2026-11-24T00:00:50.000Z',
        token: 'packages:pkg-9@2026-11-24T00:00:50.000Z'
      }
    ]);
    expect(order.some((key) => key.includes('by-freeze'))).toBe(false);
    expect(JSON.parse(bodies.get(result.manifestKey)!)).toMatchObject({
      usable: false,
      rehearsal: true,
      writes_after_freeze: result.writesAfterFreeze
    });
    expect(typeof result.seconds).toBe('number');
  });

  it.each([
    [undefined, 'unset', null],
    ['Tuesday', 'not_a_time', null],
    ['2026-11-24T00:00:00.000+00:00', 'time', '2026-11-24T00:00:00.000Z']
  ])(
    'has a rehearsal report IDENTITY_FREEZE_AT %j as the site reads it',
    async (raw, reading, at) => {
      const { deps, bodies } = setup({ freezeSecret: raw });
      const result = (await runProfileSiteExportJob(
        { ...event, rehearsal: true },
        context,
        deps
      )) as ProfileSiteExportResult;
      expect(result).toMatchObject({
        identityFreezeAtReading: reading,
        identityFreezeAt: at
      });
      expect(
        JSON.parse(bodies.get(result.manifestKey)!).identity_freeze_at
      ).toEqual({ secret: 'prod/lambdas', reading, at });
    }
  );

  it.each([
    [undefined, /IDENTITY_FREEZE_AT is not set in the prod\/lambdas secret/],
    ['', /IDENTITY_FREEZE_AT is not set/],
    ['Tuesday', /prod\/lambdas secret is not a time/],
    ['2026-11-24T00:01:00Z', /not IDENTITY_FREEZE_AT/]
  ])(
    'refuses a real run with IDENTITY_FREEZE_AT %j, before reading anything',
    async (raw, message) => {
      const { deps, order } = setup({ freezeSecret: raw });
      await expect(
        runProfileSiteExportJob(event, context, deps)
      ).rejects.toThrow(message);
      expect(deps.openSnapshot).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    }
  );

  it.each([['2026-11-24T00:00:00+00:00'], ['2026-11-24T00:00:00.000Z']])(
    'takes IDENTITY_FREEZE_AT %j for a real run, as the site does',
    async (raw) => {
      const { deps } = setup({ freezeSecret: raw });
      const result = (await runProfileSiteExportJob(
        event,
        context,
        deps
      )) as ProfileSiteExportResult;
      expect(result.identityFreezeAt).toBe('2026-11-24T00:00:00.000Z');
    }
  );

  it('reads IDENTITY_FREEZE_AT from the secret at each run, not the warm environment', async () => {
    // The container loaded the secret before the fix: its copy is stale.
    const { deps, secret, order } = setup({
      freezeSecret: undefined,
      env: { IDENTITY_FREEZE_AT: FREEZE }
    });
    await expect(runProfileSiteExportJob(event, context, deps)).rejects.toThrow(
      /not set in the prod\/lambdas secret/
    );
    expect(order).toEqual([]);
    // 6529.io fixes the secret; the rerun, in the same container, sees it.
    secret.IDENTITY_FREEZE_AT = '2026-11-24T00:00:00.000+00:00';
    const result = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.identityFreezeAt).toBe('2026-11-24T00:00:00.000Z');
    expect(deps.identityFreezeAt).toHaveBeenCalledTimes(2);
  });

  it('refuses a real run whose snapshot holds an unaccepted site write after the freeze', async () => {
    const { deps, order, close } = setup({
      late: [{ source: 'pointer_events', package_id: 'pkg-1', at: T + 5 }]
    });
    await expect(runProfileSiteExportJob(event, context, deps)).rejects.toThrow(
      /no one has accepted: pointer_events:pkg-1@2026-11-24T00:00:00.005Z\. Send this to the on-call engineer and the switch owner/
    );
    expect(order).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exports past site writes the switch owner accepted, and records them', async () => {
    const late = [
      { source: 'packages', package_id: 'pkg-1', at: T + 5 },
      { source: 'pointer_events', package_id: 'pkg-1', at: T + 6 }
    ];
    const { deps, bodies } = setup({ late });
    const accepted = [
      'packages:pkg-1@2026-11-24T00:00:00.005Z',
      'pointer_events:pkg-1@2026-11-24T00:00:00.006Z'
    ];
    const result = (await runProfileSiteExportJob(
      { ...event, acceptWritesAfterFreeze: accepted },
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.usable).toBe(true);
    expect(result.acceptedWritesAfterFreeze).toEqual(accepted);
    expect(result.writesAfterFreeze.map((it) => it.token)).toEqual(accepted);
    expect(JSON.parse(bodies.get(result.manifestKey)!)).toMatchObject({
      writes_after_freeze: result.writesAfterFreeze,
      accepted_writes_after_freeze: accepted
    });
  });

  it('refuses when only some late packages were accepted', async () => {
    const { deps, order } = setup({
      late: [
        { source: 'packages', package_id: 'pkg-1', at: T + 5 },
        { source: 'legacy_packages', package_id: 'sha256:abc', at: T + 6 }
      ]
    });
    await expect(
      runProfileSiteExportJob(
        {
          ...event,
          acceptWritesAfterFreeze: ['packages:pkg-1@2026-11-24T00:00:00.005Z']
        },
        context,
        deps
      )
    ).rejects.toThrow(
      /accepted: legacy_packages:sha256:abc@2026-11-24T00:00:00.006Z\./
    );
    expect(order).toEqual([]);
  });

  it.each([
    ['60 s after the freeze', T + 60_000, 40, /wait until at least 120 s/],
    ['with the replica 200 s behind', T + 150_000, 200_000, /200000 ms behind/],
    [
      'with the replica as far behind as the gap',
      T + 150_000,
      150_000,
      /behind/
    ]
  ])(
    'refuses a real run %s, and writes nothing',
    async (_name, snapshotAt, replicaLagMs, message) => {
      const { deps, order, close } = setup({ snapshotAt, replicaLagMs });
      await expect(
        runProfileSiteExportJob(event, context, deps)
      ).rejects.toThrow(message);
      expect(order).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    }
  );

  it('refuses an unknown replica lag unless told to rely on the gap alone', async () => {
    const { deps, bodies, order } = setup({ replicaLagMs: null });
    // The refusal carries the server's own reason.
    await expect(runProfileSiteExportJob(event, context, deps)).rejects.toThrow(
      /lag can't be read from information_schema.replica_host_status \(ER_UNKNOWN_TABLE 1109: Unknown table 'REPLICA_HOST_STATUS' in information_schema\).*acceptUnknownReplicaLag: true/
    );
    expect(order).toEqual([]);
    const result = (await runProfileSiteExportJob(
      { ...event, acceptUnknownReplicaLag: true },
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.evidence.replicaLagMs).toBeNull();
    expect(result.acceptUnknownReplicaLag).toBe(true);
    expect(JSON.parse(bodies.get(result.manifestKey)!)).toMatchObject({
      read: {
        replicaLagMs: null,
        replicaLagAgeMs: null,
        replicaLagError:
          "ER_UNKNOWN_TABLE 1109: Unknown table 'REPLICA_HOST_STATUS' in information_schema"
      },
      accept_unknown_replica_lag: true
    });
  });

  it('measures the lag against the gap in milliseconds', async () => {
    const ok = setup({ snapshotAt: T + 150_400, replicaLagMs: 150_200 });
    const stale = setup({
      snapshotAt: T + 300_000,
      replicaLagMs: 20,
      replicaLagAgeMs: 360_000
    });
    await expect(
      runProfileSiteExportJob(event, context, stale.deps)
    ).rejects.toThrow(/a 20 ms lag in a row 360000 ms old/);
    expect(stale.order).toEqual([]);
    const result = (await runProfileSiteExportJob(
      event,
      context,
      ok.deps
    )) as ProfileSiteExportResult;
    expect(result.snapshotGapSeconds).toBe(150);
    expect(result.snapshotGapMs).toBe(150_400);
    expect(result.acceptUnknownReplicaLag).toBe(false);
    expect(result.replacePointer).toBe(false);
    const behind = setup({ snapshotAt: T + 150_400, replicaLagMs: 150_400 });
    await expect(
      runProfileSiteExportJob(event, context, behind.deps)
    ).rejects.toThrow(/150400 ms behind/);
  });

  it('lets a rehearsal run with an unknown replica lag, and reports it', async () => {
    const { deps } = setup({ replicaLagMs: null });
    const result = (await runProfileSiteExportJob(
      { ...event, rehearsal: true },
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.evidence.replicaLagMs).toBeNull();
  });

  it('writes no manifest when an upload fails, and still closes the snapshot', async () => {
    const { deps, order, close } = setup({ failPutOf: 'files/bafyb' });
    await expect(runProfileSiteExportJob(event, context, deps)).rejects.toThrow(
      'upload failed'
    );
    expect(order.some((key) => key.includes('manifest'))).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps an earlier run’s pointer unless told to replace it', async () => {
    const { deps, bodies } = setup();
    const first = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    const second = (await runProfileSiteExportJob(
      event,
      { ...context, awsRequestId: 'bcdef123-4567' },
      deps
    )) as ProfileSiteExportResult;
    expect(second.usable).toBe(true);
    expect(second.pointerKey).toBeNull();
    expect(second.presignedPointerUrl).toBeNull();
    expect(second.pointerError).toMatch(
      /already names an earlier run for this freeze, and was kept.*replacePointer: true/
    );
    expect(JSON.parse(bodies.get(POINTER)!).prefix).toBe(first.prefix);
    const third = (await runProfileSiteExportJob(
      { ...event, replacePointer: true },
      { ...context, awsRequestId: 'cdef1234-5678' },
      deps
    )) as ProfileSiteExportResult;
    expect(third.pointerKey).toBe(POINTER);
    expect(third.pointerError).toBeNull();
    expect(JSON.parse(bodies.get(POINTER)!)).toMatchObject({
      prefix: third.prefix,
      manifest_sha256: third.manifestSha256
    });
    expect(JSON.parse(bodies.get(third.manifestKey)!).replace_pointer).toBe(
      true
    );
  });

  it('reports the pointer as written when only its answer was lost', async () => {
    const { deps, bodies } = setup({ pointerAnswerLost: true });
    const result = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.pointerKey).toBe(POINTER);
    expect(result.pointerError).toBeNull();
    expect(result.presignedPointerUrl).not.toBeNull();
    expect(JSON.parse(bodies.get(POINTER)!)).toMatchObject({
      prefix: result.prefix,
      manifest_sha256: result.manifestSha256
    });
  });

  it('reports a conflict when the pointer names this prefix with another manifest', async () => {
    const { deps, bodies } = setup();
    bodies.set(
      POINTER,
      JSON.stringify({
        prefix:
          'profile-site-export/staging/2026-11-24T00-03-01-000Z-abcdef12/',
        manifest_sha256: '0'.repeat(64)
      })
    );
    const result = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.prefix).toBe(
      'profile-site-export/staging/2026-11-24T00-03-01-000Z-abcdef12/'
    );
    expect(result.pointerKey).toBeNull();
    expect(result.pointerError).toMatch(/already names an earlier run/);
  });

  it('says so when a refused pointer write cannot be read back', async () => {
    const { deps, bodies } = setup({ getFails: true });
    bodies.set(POINTER, '{"prefix":"profile-site-export/staging/other/"}');
    const result = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.usable).toBe(true);
    expect(result.pointerKey).toBeNull();
    expect(result.pointerError).toMatch(
      /reading it back failed \(socket hang up\): whether it names this run is unknown\. Ask for links by frozenAt: if their prefix is this run's/
    );
    expect(result.pointerError).not.toMatch(/already names an earlier run/);
  });

  it('says so when a refused pointer is then not there to read', async () => {
    const { deps, bodies, send } = setup();
    bodies.set(POINTER, '{}');
    const get = send.getMockImplementation()!;
    send.mockImplementation(async (command: any) => {
      // Gone again by the time it is read back.
      if (command instanceof GetObjectCommand) bodies.delete(POINTER);
      return get(command);
    });
    const result = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.pointerError).toMatch(
      /reading it back failed \(it is missing\)/
    );
  });

  it('keeps a whole run when only the pointer fails, and says so', async () => {
    const { deps, order } = setup({ failPutOf: POINTER });
    const result = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    expect(result.manifestKey).toBe(`${result.prefix}manifest.json`);
    expect(order).toContain(result.manifestKey);
    expect(result.pointerKey).toBeNull();
    expect(result.pointerError).toBe('upload failed');
    expect(order.some((key) => key.includes('by-freeze'))).toBe(false);
    // Without the pointer, the run is found by its prefix.
    const again = (await runProfileSiteExportJob(
      { job: 'profileSiteExportLinks', prefix: result.prefix, frozenAt: null },
      context,
      deps
    )) as ProfileSiteExportLinksResult;
    expect(again.manifestSha256).toBe(result.manifestSha256);
    await expect(
      runProfileSiteExportJob(
        { job: 'profileSiteExportLinks', prefix: null, frozenAt: T },
        context,
        deps
      )
    ).rejects.toThrow(/No run for that freeze/);
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
      { job: 'profileSiteExportLinks', prefix: result.prefix, frozenAt: null },
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
    expect(result.usable).toBe(false);
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
    const { deps, exportProfile, verify, sleep } = setup();
    const left = [120_000, 10_000];
    const error = await runProfileSiteExportJob(
      event,
      { ...context, getRemainingTimeInMillis: () => left.shift() ?? 0 },
      deps
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProfileSiteExportDeadlineError);
    expect(error.message).toMatch(/before fetching a stored record/);
    expect(exportProfile).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops at a fetch retry when time runs short: the deadline is never retried', async () => {
    const { deps, verify, order } = setup({ verifyFails: 1 });
    // The first attempt fails; time runs short before the second.
    const left = [120_000, 120_000, 10_000];
    const error = await runProfileSiteExportJob(
      event,
      { ...context, getRemainingTimeInMillis: () => left.shift() ?? 0 },
      deps
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProfileSiteExportDeadlineError);
    expect(error.message).toMatch(/before fetching a stored record/);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(order.some((key) => key.includes('manifest'))).toBe(false);
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
      { job: 'profileSiteExportLinks', prefix: first.prefix, frozenAt: null },
      context,
      deps
    )) as ProfileSiteExportLinksResult;
    expect(again).toMatchObject({
      job: 'profileSiteExportLinks',
      bucket: BUCKET,
      manifestKey: first.manifestKey,
      manifestSha256: first.manifestSha256,
      pointerKey: null,
      presignedPointerUrl: null
    });
    const links = JSON.parse(bodies.get(again.linksKey)!);
    expect(Object.keys(links.links)).toContain('files/bafyshared');
    expect(Object.keys(links.links)).toContain('manifest.json');
    // Beside the run's folder: the folder keeps only what its manifest lists.
    expect(again.linksKey).toMatch(
      /^profile-site-export\/staging\/renewed-links\/2026-11-24T00-03-01-000Z-abcdef12\/links-.+\.json$/
    );
    expect(again.linksBytes).toBe(
      Buffer.byteLength(bodies.get(again.linksKey)!)
    );
    const listed = JSON.parse(bodies.get(first.manifestKey)!).files.map(
      (f: { name: string }) => first.prefix + f.name
    );
    const inRun = Array.from(bodies.keys()).filter((key) =>
      key.startsWith(first.prefix)
    );
    expect(inRun.sort()).toEqual([...listed, first.manifestKey].sort());
  });

  it('finds the run for fresh links through its freeze', async () => {
    const { deps } = setup();
    const first = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    const again = (await runProfileSiteExportJob(
      { job: 'profileSiteExportLinks', prefix: null, frozenAt: T },
      context,
      deps
    )) as ProfileSiteExportLinksResult;
    expect(again).toMatchObject({
      prefix: first.prefix,
      manifestKey: first.manifestKey,
      manifestSha256: first.manifestSha256,
      pointerKey: POINTER,
      presignedPointerUrl: `https://signed/${BUCKET}/${POINTER}?s=21600`
    });
    expect(again.linksKey.startsWith(first.prefix)).toBe(false);
    expect(again.linksKey).toMatch(/\/renewed-links\//);
  });

  it('refuses fresh links when the manifest no longer matches its pointer', async () => {
    const { deps, bodies } = setup();
    const first = (await runProfileSiteExportJob(
      event,
      context,
      deps
    )) as ProfileSiteExportResult;
    bodies.set(first.manifestKey, `${bodies.get(first.manifestKey)!}\n`);
    await expect(
      runProfileSiteExportJob(
        { job: 'profileSiteExportLinks', prefix: null, frozenAt: T },
        context,
        deps
      )
    ).rejects.toThrow(/pointer for that freeze names/);
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
            prefix: 'profile-site-export/staging/missing/',
            frozenAt: null
          },
          context,
          deps
        )
      ).rejects.toThrow(message);
    }
  );
});
