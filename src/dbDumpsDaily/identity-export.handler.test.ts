import {
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { IdentityExportNotReadyError } from '@/identity-export/identity-export.errors';
import {
  IdentityExportDeps,
  IdentityExportEventError,
  IdentityExportResult,
  parseIdentityExportEvent,
  runIdentityExportJob
} from './identity-export.handler';

const mockBuild = jest.fn();
jest.mock('@/identity-export/identity-export.service', () => ({
  ...jest.requireActual('@/identity-export/identity-export.service'),
  buildIdentityExport: (...args: unknown[]) => mockBuild(...args)
}));

const ARN = 'arn:aws:lambda:eu-west-1:000000000000:function:dbDumpsDaily';
const BUCKET = '6529-chain-exports-000000000000-eu-west-1';
const T = Date.UTC(2026, 10, 24);
const REV = 'a'.repeat(40);
const ALICE = '00000000-0000-4000-8000-0000000a11ce';

function document(over: Record<string, unknown> = {}) {
  return {
    format: '6529.identity-export.v1',
    source: 'database',
    exporter_revision: REV,
    started_at_ms: T,
    finished_at_ms: T + 1,
    freeze_ms: T,
    tdh_block: 24_000_000,
    tdh_block_timestamp_ms: T - 12_000,
    extra_ids: { count: 1, sha256: 'e'.repeat(64) },
    cms_fields: null,
    acknowledged: {
      over_credit: 0,
      edits_after_freeze: 0,
      ratings_changed_after_freeze: 0,
      missing_extra_ids: 0
    },
    identities: [{ profile_id: ALICE }],
    reserved_handles: ['admin'],
    ratings: [],
    delegations: [],
    notes: ['a note'],
    rules: { rep: 'sum_of_file_ratings' },
    identity_sync: { pendingGeneration: 3 },
    ratings_changed_after_freeze: [],
    bulk_rep: [],
    stats: { identities: 1 },
    ...over
  };
}

function setup(
  options: {
    env?: Record<string, string | undefined>;
    objects?: Record<string, string>;
    failPutOf?: string;
    publicBlock?: boolean;
    snapshotAt?: string;
    closeFails?: boolean;
    credentialsEnd?: Date | null;
  } = {}
) {
  const order: string[] = [];
  const bodies = new Map<string, string>(Object.entries(options.objects ?? {}));
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
        throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      }
      return {
        Body: {
          transformToString: async () => body,
          transformToByteArray: async () => Buffer.from(body)
        }
      };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  });
  const executor = { execute: jest.fn(async () => []) };
  const close = jest.fn(async () => {
    if (options.closeFails) throw new Error('rollback failed');
  });
  const deps: IdentityExportDeps = {
    prepareEnvironment: jest.fn(async () => undefined),
    env: () => ({
      DB_HOST: 'primary-host',
      DB_HOST_READ: 'replica-host',
      DB_PORT: '3306',
      DB_USER_READ: 'reader',
      DB_PASS_READ: 'secret',
      DB_NAME: 'app',
      AWS_REGION: 'eu-west-1',
      NODE_ENV: 'staging',
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
        snapshotAt: options.snapshotAt ?? '2026-11-24T00:30:00.000Z'
      },
      close
    })),
    credentialsExpiry: async () => options.credentialsEnd ?? null,
    now: (() => {
      let tick = T + 60_000;
      return () => new Date((tick += 1_000));
    })()
  };
  return { deps, send, order, bodies, close, executor };
}

const atFreeze = {
  job: 'identityExport',
  freezeAt: '2026-11-24T00:00:00Z',
  expectTdhBlock: 24_000_000,
  revision: REV,
  extraIds: { inline: [ALICE] },
  noCmsFields: true
};

describe('parseIdentityExportEvent', () => {
  it('leaves the schedule and other jobs alone', () => {
    expect(parseIdentityExportEvent(undefined)).toBeNull();
    expect(
      parseIdentityExportEvent({
        source: 'aws.events',
        'detail-type': 'Scheduled Event'
      })
    ).toBeNull();
    expect(parseIdentityExportEvent({ job: 'profileSiteExport' })).toBeNull();
  });

  it("reads the CLI's options, with its defaults", () => {
    expect(parseIdentityExportEvent(atFreeze)).toEqual({
      job: 'identityExport',
      freezeMs: T,
      expectTdhBlock: 24_000_000,
      revision: REV,
      bulk: 2000,
      includeDelegations: true,
      extraIds: { inline: [ALICE] },
      cmsFields: null,
      acceptOverCredit: 0,
      acceptEditsAfterFreeze: 0,
      acceptRatingsChangedAfterFreeze: 0,
      acceptMissingExtraIds: 0,
      acceptSnapshotGapMinutes: null
    });
    expect(
      parseIdentityExportEvent({
        job: 'identityExport',
        noFreeze: true,
        revision: REV.toUpperCase(),
        noExtraIds: true,
        cmsFields: {
          key: 'profile-site-export/prod/2026-11-24T00-10-00-000Z-abcd1234/cms-fields.json'
        },
        bulk: 0,
        noDelegations: true,
        acceptOverCredit: 3
      })
    ).toEqual(
      expect.objectContaining({
        freezeMs: null,
        expectTdhBlock: null,
        revision: REV,
        bulk: 0,
        includeDelegations: false,
        extraIds: null,
        cmsFields: {
          key: 'profile-site-export/prod/2026-11-24T00-10-00-000Z-abcd1234/cms-fields.json'
        },
        acceptOverCredit: 3
      })
    );
  });

  it.each([
    [{ ...atFreeze, expectTdhBlock: undefined }],
    [{ ...atFreeze, freezeAt: undefined }],
    [{ ...atFreeze, noFreeze: true }],
    [{ ...atFreeze, freezeAt: '2026-11-24' }],
    [{ ...atFreeze, revision: 'abc' }],
    [{ ...atFreeze, extraIds: undefined }],
    [{ ...atFreeze, noExtraIds: true }],
    [{ ...atFreeze, noCmsFields: undefined }],
    [{ ...atFreeze, extraIds: { key: 'db-dumps/x.json' } }],
    [{ ...atFreeze, extraIds: { key: 'identity-export/inputs/' } }],
    [{ ...atFreeze, extraIds: { key: 'identity-export/../x.json' } }],
    [{ ...atFreeze, extraIds: [ALICE] }],
    [{ ...atFreeze, acceptOverCredit: -1 }],
    [{ ...atFreeze, acceptOverCredit: '2' }],
    [{ ...atFreeze, freeze_at: T }],
    [{ ...atFreeze, acceptSnapshotGapMinutes: 1.5 }],
    [
      {
        job: 'identityExport',
        noFreeze: true,
        revision: REV,
        noExtraIds: true,
        noCmsFields: true,
        acceptSnapshotGapMinutes: 120
      }
    ],
    [{ job: 'identityExportLinks', prefix: 'profile-site-export/x/' }]
  ])('refuses %j', (bad) => {
    expect(() => parseIdentityExportEvent(bad)).toThrow(
      IdentityExportEventError
    );
  });
});

describe('runIdentityExportJob', () => {
  beforeEach(() => mockBuild.mockReset());

  it('reads the replica read-only, writes the export, then the manifest last', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps, order, bodies, close } = setup();
    const event = parseIdentityExportEvent(atFreeze)!;
    const result = (await runIdentityExportJob(
      event,
      { invokedFunctionArn: ARN, awsRequestId: 'abcdef12-3456' },
      deps
    )) as IdentityExportResult;

    expect(deps.openSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'replica-host' })
    );
    expect(close).toHaveBeenCalledTimes(1);
    const options = mockBuild.mock.calls[0][1];
    expect(options).toEqual(
      expect.objectContaining({
        freezeMs: T,
        expectTdhBlock: 24_000_000,
        extraProfileIds: [ALICE],
        extraIdsFile: {
          count: 1,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
        },
        cmsFieldsFile: null,
        exporterRevision: REV
      })
    );
    expect(result).toMatchObject({
      job: 'identityExport',
      bucket: BUCKET,
      host: 'replica-host',
      readOnly: true,
      usable: true,
      identities: 1,
      ratings: 0,
      tdhBlock: 24_000_000,
      frozenAt: '2026-11-24T00:00:00.000Z',
      snapshotAt: '2026-11-24T00:30:00.000Z',
      snapshotGapSeconds: 1800,
      linksLimitedByCredentials: false,
      scope: {
        freezeAt: '2026-11-24T00:00:00.000Z',
        expectTdhBlock: 24_000_000,
        bulk: 2000,
        includeDelegations: true,
        extraIds: 'inline',
        cmsFields: null
      },
      bucketPrivacy: { publicAccessBlocked: true, policyPublic: false }
    });
    expect(result.prefix).toMatch(
      /^identity-export\/staging\/2026-11-24T00-01-01-000Z-abcdef12\/$/
    );
    const names = order.map((key) => key.slice(result.prefix.length));
    expect(names).toEqual([
      'identity-export.json',
      'summary.json',
      'links.json',
      'manifest.json'
    ]);
    const written = JSON.parse(bodies.get(result.exportKey)!);
    expect(written.identity_sync).toBeUndefined();
    expect(written.identities).toEqual([{ profile_id: ALICE }]);
    const manifest = JSON.parse(bodies.get(result.manifestKey)!);
    expect(manifest).toMatchObject({
      schema: '6529.identity-export.manifest.v1',
      usable: true,
      tdh_block: 24_000_000,
      identities: 1,
      snapshot_at: '2026-11-24T00:30:00.000Z',
      snapshot_gap_seconds: 1800,
      scope: { extraIds: 'inline', cmsFields: null },
      read: { host: 'replica-host', read_only: true }
    });
    expect(manifest.export_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files).toEqual([
      {
        name: 'identity-export.json',
        bytes: Buffer.byteLength(bodies.get(result.exportKey)!),
        sha256: manifest.export_sha256
      },
      {
        name: 'summary.json',
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      }
    ]);
    expect(result.presignedManifestUrl).toContain('manifest.json');
  });

  it('reads its inputs from the bucket, and refuses a bad waves list before reading the database', async () => {
    mockBuild.mockResolvedValue(document());
    const good = setup({
      objects: {
        'identity-export/inputs/waves.json': JSON.stringify([ALICE]),
        'identity-export/inputs/cms.json': JSON.stringify({
          [ALICE]: { primary: {} }
        })
      }
    });
    await runIdentityExportJob(
      parseIdentityExportEvent({
        ...atFreeze,
        extraIds: { key: 'identity-export/inputs/waves.json' },
        noCmsFields: undefined,
        cmsFields: { key: 'identity-export/inputs/cms.json' }
      })!,
      { invokedFunctionArn: ARN },
      good.deps
    );
    const options = mockBuild.mock.calls[0][1];
    expect(options.extraProfileIds).toEqual([ALICE]);
    expect(options.cmsFields).toEqual({ [ALICE]: { primary: {} } });
    expect(options.cmsFieldsFile.count).toBe(1);

    const bad = setup({
      objects: { 'identity-export/inputs/waves.json': '[1' }
    });
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent({
          ...atFreeze,
          extraIds: { key: 'identity-export/inputs/waves.json' }
        })!,
        { invokedFunctionArn: ARN },
        bad.deps
      )
    ).rejects.toThrow('not valid JSON');
    expect(bad.deps.openSnapshot).not.toHaveBeenCalled();
    expect(bad.order).toEqual([]);
  });

  it('writes nothing when the export is refused, and still closes the snapshot', async () => {
    mockBuild.mockRejectedValue(
      new IdentityExportNotReadyError([
        { cause: 'over_credit', message: '2 raters over' }
      ])
    );
    const { deps, order, close } = setup();
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent(atFreeze)!,
        { invokedFunctionArn: ARN },
        deps
      )
    ).rejects.toThrow('2 raters over');
    expect(order).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('writes no manifest when an upload fails', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps, order } = setup({ failPutOf: 'summary.json' });
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent(atFreeze)!,
        { invokedFunctionArn: ARN },
        deps
      )
    ).rejects.toThrow('upload failed');
    expect(order.some((key) => key.endsWith('manifest.json'))).toBe(false);
  });

  it.each([[{ DB_HOST_READ: undefined }], [{ DB_HOST_READ: 'primary-host' }]])(
    'refuses without the read replica (%j)',
    async (env) => {
      const { deps, order } = setup({ env });
      await expect(
        runIdentityExportJob(
          parseIdentityExportEvent(atFreeze)!,
          { invokedFunctionArn: ARN },
          deps
        )
      ).rejects.toThrow(/read replica/);
      expect(deps.openSnapshot).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    }
  );

  it('refuses a bucket that does not block all public access', async () => {
    const { deps, order } = setup({ publicBlock: false });
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent(atFreeze)!,
        { invokedFunctionArn: ARN },
        deps
      )
    ).rejects.toThrow(/public access/);
    expect(deps.openSnapshot).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('gives fresh links for an earlier run from its manifest', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps, bodies } = setup();
    const first = (await runIdentityExportJob(
      parseIdentityExportEvent(atFreeze)!,
      { invokedFunctionArn: ARN },
      deps
    )) as IdentityExportResult;
    const again = await runIdentityExportJob(
      parseIdentityExportEvent({
        job: 'identityExportLinks',
        prefix: first.prefix
      })!,
      { invokedFunctionArn: ARN },
      deps
    );
    expect(again).toMatchObject({ job: 'identityExportLinks', bucket: BUCKET });
    const links = JSON.parse(
      bodies.get((again as { linksKey: string }).linksKey)!
    );
    expect(Object.keys(links.links)).toEqual([
      'identity-export.json',
      'summary.json',
      'manifest.json'
    ]);
  });

  it('writes a rehearsal under its own prefix with only manifest.unusable.json', async () => {
    mockBuild.mockResolvedValue(document({ freeze_ms: null }));
    const { deps, order, bodies } = setup({
      env: { NODE_ENV: 'production' }
    });
    const result = (await runIdentityExportJob(
      parseIdentityExportEvent({
        job: 'identityExport',
        noFreeze: true,
        revision: REV,
        noExtraIds: true,
        noCmsFields: true
      })!,
      { invokedFunctionArn: ARN, awsRequestId: 'abcdef12' },
      deps
    )) as IdentityExportResult;
    expect(result.prefix).toMatch(
      /^identity-export\/prod\/[0-9TZ-]+-abcdef12-rehearsal\/$/
    );
    expect(result.usable).toBe(false);
    expect(result.snapshotGapSeconds).toBeNull();
    expect(result.manifestKey).toBe(`${result.prefix}manifest.unusable.json`);
    expect(order.some((key) => key.endsWith('/manifest.json'))).toBe(false);
    const manifest = JSON.parse(bodies.get(result.manifestKey)!);
    expect(manifest.usable).toBe(false);
    const again = await runIdentityExportJob(
      parseIdentityExportEvent({
        job: 'identityExportLinks',
        prefix: result.prefix
      })!,
      { invokedFunctionArn: ARN },
      deps
    );
    expect(again).toMatchObject({ usable: false });
  });

  it.each([
    [
      'before the freeze',
      '2026-11-23T23:59:00.000Z',
      null,
      /before the freeze/
    ],
    [
      'too long after it',
      '2026-11-24T02:00:00.000Z',
      null,
      /over the 90-minute limit/
    ]
  ])(
    'refuses a snapshot %s, writing nothing',
    async (_name, snapshotAt, _gap, message) => {
      mockBuild.mockResolvedValue(document());
      const { deps, order, close } = setup({ snapshotAt });
      await expect(
        runIdentityExportJob(
          parseIdentityExportEvent(atFreeze)!,
          { invokedFunctionArn: ARN },
          deps
        )
      ).rejects.toThrow(message);
      expect(mockBuild).not.toHaveBeenCalled();
      expect(order).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    }
  );

  it('takes a later snapshot when the gap is acknowledged', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps } = setup({ snapshotAt: '2026-11-24T02:00:00.000Z' });
    const result = (await runIdentityExportJob(
      parseIdentityExportEvent({ ...atFreeze, acceptSnapshotGapMinutes: 150 })!,
      { invokedFunctionArn: ARN },
      deps
    )) as IdentityExportResult;
    expect(result.snapshotGapSeconds).toBe(7200);
  });

  it('stops with its step before the deadline, writing nothing', async () => {
    mockBuild.mockImplementation(async (_source, options) => {
      options.log('core: 3 profiles');
      return document();
    });
    const { deps, order } = setup();
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent(atFreeze)!,
        { invokedFunctionArn: ARN, getRemainingTimeInMillis: () => 30_000 },
        deps
      )
    ).rejects.toThrow(/Stopped after "IDENTITY EXPORT core: 3 profiles"/);
    expect(order).toEqual([]);
  });

  it("keeps the run's own error when closing the snapshot also fails", async () => {
    mockBuild.mockRejectedValue(new Error('read failed'));
    const { deps } = setup({ closeFails: true });
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent(atFreeze)!,
        { invokedFunctionArn: ARN },
        deps
      )
    ).rejects.toThrow('read failed');
  });

  it('ends the links when the signing credentials end, if that is sooner', async () => {
    mockBuild.mockResolvedValue(document());
    const end = new Date(T + 2 * 3600_000);
    const { deps } = setup({ credentialsEnd: end });
    const result = (await runIdentityExportJob(
      parseIdentityExportEvent(atFreeze)!,
      { invokedFunctionArn: ARN },
      deps
    )) as IdentityExportResult;
    expect(result.linksExpireAt).toBe(end.toISOString());
    expect(result.linksLimitedByCredentials).toBe(true);
  });

  it('says so when a links request names a run with no manifest', async () => {
    const { deps } = setup();
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent({
          job: 'identityExportLinks',
          prefix: 'identity-export/staging/missing/'
        })!,
        { invokedFunctionArn: ARN },
        deps
      )
    ).rejects.toThrow(/No manifest under identity-export\/staging\/missing\//);
  });
});
