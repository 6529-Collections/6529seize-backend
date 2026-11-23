import { createHash } from 'node:crypto';
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
  IdentityExportLinksResult,
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
const OWNER = '000000000000';
const T = Date.UTC(2026, 10, 24);
const FREEZE_ISO = '2026-11-24T00:00:00.000Z';
const REV = 'a'.repeat(40);
const ALICE = '00000000-0000-4000-8000-0000000a11ce';
const POINTER =
  'identity-export/staging/by-freeze/2026-11-24T00-00-00-000Z.json';
const SITE_POINTER =
  'profile-site-export/staging/by-freeze/2026-11-24T00-00-00-000Z.json';
const SITE_PREFIX =
  'profile-site-export/staging/2026-11-24T00-03-00-000Z-site0001/';

const sha = (text: string) =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

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

/** A whole, usable profile site run at the freeze, with its pointer. */
function siteRun(
  over: {
    manifest?: Record<string, unknown>;
    pointer?: Record<string, unknown>;
    cms?: string;
    /** The cms-fields.json stored, when not the one the manifest lists. */
    storedCms?: string;
  } = {}
): Record<string, string> {
  const cms = over.cms ?? JSON.stringify({ [ALICE]: { primary: {} } });
  const manifest = JSON.stringify({
    schema: '6529.profile-site-export.manifest.v1',
    usable: true,
    rehearsal: false,
    stage: 'staging',
    frozen_at: FREEZE_ISO,
    files: [
      { name: 'files/bafk1', bytes: 3, sha256: 'b'.repeat(64) },
      { name: 'cms-fields.json', bytes: cms.length, sha256: sha(cms) }
    ],
    ...over.manifest
  });
  const pointer = JSON.stringify({
    frozen_at: FREEZE_ISO,
    prefix: SITE_PREFIX,
    manifest: `${SITE_PREFIX}manifest.json`,
    manifest_sha256: sha(manifest),
    finished_at: '2026-11-24T00:09:00.000Z',
    ...over.pointer
  });
  return {
    [SITE_POINTER]: pointer,
    [`${SITE_PREFIX}manifest.json`]: manifest,
    [`${SITE_PREFIX}cms-fields.json`]: over.storedCms ?? cms
  };
}

function setup(
  options: {
    env?: Record<string, string | undefined>;
    /** The bucket's objects; a whole profile site run by default. */
    objects?: Record<string, string>;
    failPutOf?: string;
    /** The pointer's write lands, but its answer is lost and the retry refused. */
    pointerAnswerLost?: boolean;
    publicBlock?: boolean;
    snapshotAt?: string;
    replicaLagMs?: number | null;
    closeFails?: boolean;
    /** Answer a read of a missing key with 403, as S3 does without ListBucket. */
    missingAs403?: boolean;
    buildCommit?: string | null;
    /** IDENTITY_FREEZE_AT in the lambdas secret now (default the freeze). */
    freezeSecret?: string;
  } = {}
) {
  const secret =
    'freezeSecret' in options ? options.freezeSecret : '2026-11-24T00:00:00Z';
  const order: string[] = [];
  const bodies = new Map<string, string>(
    Object.entries(options.objects ?? siteRun())
  );
  const send = jest.fn(async (command: any) => {
    // Every call names the bucket's expected owner: the function's account.
    if (command.input.ExpectedBucketOwner !== OWNER) {
      throw new Error(`no ExpectedBucketOwner on ${command.constructor.name}`);
    }
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
      // S3 refuses an upload whose bytes don't match its checksum.
      const sum = createHash('sha256')
        .update(command.input.Body as Buffer)
        .digest('base64');
      if (command.input.ChecksumSHA256 !== sum) {
        throw new Error(`bad checksum for ${key}`);
      }
      if (options.pointerAnswerLost && key.includes('/by-freeze/')) {
        bodies.set(key, Buffer.from(command.input.Body as Buffer).toString());
        order.push(key);
        throw Object.assign(new Error('At least one precondition failed'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 }
        });
      }
      // A conditional write of a key that exists: 412.
      if (command.input.IfNoneMatch === '*' && bodies.has(key)) {
        throw Object.assign(new Error('At least one precondition failed'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 }
        });
      }
      order.push(key);
      bodies.set(key, Buffer.from(command.input.Body as Buffer).toString());
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const body = bodies.get(command.input.Key!);
      if (body === undefined) {
        throw options.missingAs403
          ? Object.assign(new Error('Access Denied'), {
              name: 'AccessDenied',
              $metadata: { httpStatusCode: 403 }
            })
          : Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
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
    identityFreezeAt: jest.fn(async () => ({
      secretId: 'prod/lambdas',
      key: 'IDENTITY_FREEZE_AT',
      value: secret
    })),
    s3: { send } as never,
    presign: async (bucket, key, seconds) =>
      `https://signed/${bucket.name}/${key}?s=${seconds}&owner=${bucket.owner}`,
    openSnapshot: jest.fn(async (target) => ({
      executor: executor as never,
      evidence: {
        host: target.host,
        transactionReadOnly: true,
        serverReadOnly: true,
        innodbReadOnly: null,
        snapshotAt: options.snapshotAt ?? '2026-11-24T00:30:00.000Z',
        replicaLagMs:
          options.replicaLagMs === undefined ? 40 : options.replicaLagMs
      },
      close
    })),
    now: (() => {
      let tick = T + 600_000;
      return () => new Date((tick += 1_000));
    })(),
    buildCommit: () =>
      options.buildCommit === undefined ? REV : options.buildCommit
  };
  return { deps, send, order, bodies, close, executor };
}

const atFreeze = {
  job: 'identityExport',
  freezeAt: '2026-11-24T00:00:00Z',
  expectTdhBlock: 24_000_000,
  extraIds: { inline: [ALICE] }
};

const rehearsal = {
  job: 'identityExport',
  noFreeze: true,
  revision: REV,
  noExtraIds: true,
  noCmsFields: true
};

const context = { invokedFunctionArn: ARN, awsRequestId: 'abcdef12-3456' };

async function run(
  deps: IdentityExportDeps,
  event: Record<string, unknown> = atFreeze,
  extra: Record<string, unknown> = {}
) {
  return (await runIdentityExportJob(
    parseIdentityExportEvent(event)!,
    { ...context, ...extra },
    deps
  )) as IdentityExportResult;
}

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
      revision: null,
      bulk: 2000,
      includeDelegations: true,
      extraIds: { inline: [ALICE] },
      cmsFields: null,
      acceptOverCredit: 0,
      acceptEditsAfterFreeze: 0,
      acceptRatingsChangedAfterFreeze: 0,
      acceptMissingExtraIds: 0,
      acceptProfileWritesAfterFreeze: 0,
      acceptUnmatchedCms: 0,
      acceptConsolidationsAfterFreeze: 0,
      acceptNoExtraIds: false,
      acceptBulk: null,
      acceptSnapshotGapMinutes: null,
      acceptUnknownReplicaLag: false,
      replacePointer: false
    });
    expect(
      parseIdentityExportEvent({
        ...rehearsal,
        revision: REV.toUpperCase(),
        noCmsFields: undefined,
        cmsFields: {
          key: 'profile-site-export/prod/2026-11-24T00-10-00-000Z-abcd1234/cms-fields.json'
        },
        bulk: 0,
        noDelegations: true
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
        }
      })
    );
  });

  it('takes the waves list left out and another bulk at the freeze only acknowledged', () => {
    expect(
      parseIdentityExportEvent({
        ...atFreeze,
        extraIds: undefined,
        noExtraIds: true,
        acceptNoExtraIds: true,
        bulk: 0,
        acceptBulk: 0,
        acceptConsolidationsAfterFreeze: 2,
        replacePointer: true
      })
    ).toEqual(
      expect.objectContaining({
        extraIds: null,
        acceptNoExtraIds: true,
        bulk: 0,
        acceptBulk: 0,
        acceptConsolidationsAfterFreeze: 2,
        replacePointer: true
      })
    );
  });

  it.each([
    [{ ...atFreeze, expectTdhBlock: undefined }, 'needs expectTdhBlock'],
    [{ ...atFreeze, freezeAt: undefined }, 'one of the two'],
    [{ ...atFreeze, noFreeze: true }, 'one of the two'],
    [{ ...atFreeze, freezeAt: '2026-11-24' }, 'freezeAt must be'],
    [{ ...atFreeze, revision: 'abc' }, 'revision must be'],
    [{ ...atFreeze, extraIds: undefined }, 'Give extraIds or noExtraIds'],
    [{ ...atFreeze, noExtraIds: true }, 'Give extraIds or noExtraIds'],
    [
      { ...atFreeze, noCmsFields: true },
      "come from the profile site export's pointer"
    ],
    [
      { ...atFreeze, cmsFields: { inline: { [ALICE]: {} } } },
      "come from the profile site export's pointer"
    ],
    [
      {
        ...atFreeze,
        cmsFields: { key: `${SITE_PREFIX}cms-fields.json` }
      },
      "come from the profile site export's pointer"
    ],
    [{ ...atFreeze, noDelegations: true }, 'noDelegations is for a rehearsal'],
    [
      { ...atFreeze, extraIds: undefined, noExtraIds: true },
      'acknowledge it with acceptNoExtraIds: true'
    ],
    [
      { ...atFreeze, acceptNoExtraIds: true },
      'acceptNoExtraIds is only with noExtraIds'
    ],
    [{ ...atFreeze, bulk: 0 }, 'acknowledge it with acceptBulk: 0'],
    [
      { ...atFreeze, bulk: 0, acceptBulk: 500 },
      'acknowledge it with acceptBulk: 0'
    ],
    [{ ...atFreeze, acceptBulk: 2000 }, 'leave acceptBulk out'],
    [{ ...atFreeze, extraIds: { key: 'db-dumps/x.json' } }, 'extraIds.key'],
    [
      { ...atFreeze, extraIds: { key: 'identity-export/inputs/' } },
      'extraIds.key'
    ],
    [
      { ...atFreeze, extraIds: { key: 'identity-export/../x.json' } },
      'extraIds.key'
    ],
    [{ ...atFreeze, extraIds: [ALICE] }, 'extraIds must be'],
    [{ ...atFreeze, acceptOverCredit: -1 }, 'must be a whole number'],
    [{ ...atFreeze, acceptOverCredit: '2' }, 'must be a whole number'],
    [{ ...atFreeze, replacePointer: 'yes' }, 'must be true'],
    [{ ...atFreeze, freeze_at: T }, 'Unknown fields: freeze_at'],
    [{ ...atFreeze, acceptSnapshotGapMinutes: 1.5 }, 'whole number of minutes'],
    [{ ...atFreeze, freezeAt: '2026-11-24T00:00:01Z' }, 'must be 00:00 UTC'],
    [{ ...atFreeze, freezeAt: T + 1 }, 'freezeAt must be'],
    [
      { ...rehearsal, acceptUnmatchedCms: 0 },
      'acceptUnmatchedCms: an acknowledgement is only for an export at the freeze'
    ],
    [
      { ...rehearsal, acceptNoExtraIds: true },
      'acceptNoExtraIds: an acknowledgement is only'
    ],
    [
      { ...rehearsal, acceptSnapshotGapMinutes: 120 },
      'acceptSnapshotGapMinutes is for an export at the freeze'
    ],
    [{ ...rehearsal, replacePointer: true }, 'a rehearsal writes no pointer'],
    [
      { job: 'identityExportLinks', prefix: 'profile-site-export/x/' },
      'prefix must be'
    ],
    [
      {
        job: 'identityExportLinks',
        prefix: 'identity-export/staging/x/',
        freezeAt: '2026-11-24T00:00:00Z'
      },
      'Give either prefix'
    ],
    [{ job: 'identityExportLinks' }, 'Give either prefix'],
    [
      { job: 'identityExportLinks', freezeAt: '2026-11-24T00:00:01Z' },
      'must be 00:00 UTC'
    ]
  ])('refuses %j', (bad, message) => {
    expect(() => parseIdentityExportEvent(bad)).toThrow(
      IdentityExportEventError
    );
    expect(() => parseIdentityExportEvent(bad)).toThrow(message);
  });
});

describe('runIdentityExportJob', () => {
  beforeEach(() => mockBuild.mockReset());

  it('reads the replica read-only, writes the export, then the manifest, then the pointer', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps, order, bodies, close } = setup();
    const result = await run(deps);

    expect(deps.openSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'replica-host' })
    );
    expect(close).toHaveBeenCalledTimes(1);
    const site = siteRun();
    const cms = site[`${SITE_PREFIX}cms-fields.json`];
    const siteManifest = site[`${SITE_PREFIX}manifest.json`];
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
        cmsFields: { [ALICE]: { primary: {} } },
        cmsFieldsFile: {
          count: 1,
          sha256: sha(cms),
          manifest: {
            key: `${SITE_PREFIX}manifest.json`,
            sha256: sha(siteManifest)
          }
        },
        exporterRevision: REV,
        notes: [],
        // A refusal names the event's fields, not the CLI's flags.
        acceptStyle: 'event'
      })
    );
    const cmsSource = {
      pointer: SITE_POINTER,
      prefix: SITE_PREFIX,
      manifest: `${SITE_PREFIX}manifest.json`,
      manifestSha256: sha(siteManifest),
      file: `${SITE_PREFIX}cms-fields.json`,
      sha256: sha(cms)
    };
    expect(result).toMatchObject({
      job: 'identityExport',
      bucket: BUCKET,
      stage: 'staging',
      host: 'replica-host',
      readOnly: true,
      usable: true,
      identities: 1,
      ratings: 0,
      tdhBlock: 24_000_000,
      revision: REV,
      buildCommit: REV,
      frozenAt: FREEZE_ISO,
      snapshotAt: '2026-11-24T00:30:00.000Z',
      snapshotGapSeconds: 1800,
      identityFreezeAtReading: 'time',
      identityFreezeAt: FREEZE_ISO,
      linksLastAtMost: expect.any(String),
      pointerKey: POINTER,
      pointerError: null,
      replacedPointer: null,
      presignedPointerUrl: expect.stringContaining(POINTER),
      identityFreezeAtSecret: 'prod/lambdas',
      cmsFieldsSource: cmsSource,
      scope: {
        freezeAt: FREEZE_ISO,
        expectTdhBlock: 24_000_000,
        bulk: 2000,
        includeDelegations: true,
        extraIds: 'inline',
        cmsFields: `${SITE_PREFIX}cms-fields.json`,
        replacePointer: false
      },
      bucketPrivacy: {
        bucket: BUCKET,
        owner: OWNER,
        publicAccessBlocked: true,
        policyPublic: false
      }
    });
    expect(result.prefix).toMatch(
      /^identity-export\/staging\/2026-11-24T00-10-01-000Z-abcdef12\/$/
    );
    // The run's objects, the manifest last in its prefix, then the pointer.
    expect(order).toEqual([
      `${result.prefix}identity-export.json`,
      `${result.prefix}summary.json`,
      `${result.prefix}links.json`,
      `${result.prefix}manifest.json`,
      POINTER
    ]);
    expect(result.manifestSha256).toBe(sha(bodies.get(result.manifestKey)!));
    expect(JSON.parse(bodies.get(POINTER)!)).toEqual({
      frozen_at: FREEZE_ISO,
      prefix: result.prefix,
      manifest: result.manifestKey,
      manifest_sha256: result.manifestSha256,
      export: result.exportKey,
      export_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      finished_at: expect.any(String)
    });
    const written = JSON.parse(bodies.get(result.exportKey)!);
    expect(written.identity_sync).toBeUndefined();
    expect(written.identities).toEqual([{ profile_id: ALICE }]);
    const manifest = JSON.parse(bodies.get(result.manifestKey)!);
    expect(manifest).toMatchObject({
      schema: '6529.identity-export.manifest.v1',
      usable: true,
      stage: 'staging',
      exporter_revision: REV,
      build_commit: REV,
      identity_freeze_at: { reading: 'time', at: FREEZE_ISO },
      cms_fields_source: cmsSource,
      replace_pointer: false,
      replaced_pointer: null,
      tdh_block: 24_000_000,
      identities: 1,
      snapshot_at: '2026-11-24T00:30:00.000Z',
      snapshot_gap_seconds: 1800,
      scope: { extraIds: 'inline', cmsFields: `${SITE_PREFIX}cms-fields.json` },
      read: { host: 'replica-host', read_only: true, replicaLagMs: 40 }
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
      },
      {
        name: 'links.json',
        bytes: Buffer.byteLength(bodies.get(`${result.prefix}links.json`)!),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      }
    ]);
    expect(result.presignedManifestUrl).toContain('manifest.json');
    expect(result.presignedManifestUrl).toContain(`owner=${OWNER}`);
  });

  it('reads the waves list from the bucket, and refuses a bad one before reading the database', async () => {
    mockBuild.mockResolvedValue(document());
    const good = setup({
      objects: {
        ...siteRun(),
        'identity-export/inputs/waves.json': JSON.stringify([ALICE])
      }
    });
    await run(good.deps, {
      ...atFreeze,
      extraIds: { key: 'identity-export/inputs/waves.json' }
    });
    expect(mockBuild.mock.calls[0][1].extraProfileIds).toEqual([ALICE]);

    const bad = setup({
      objects: { ...siteRun(), 'identity-export/inputs/waves.json': '[1' }
    });
    await expect(
      run(bad.deps, {
        ...atFreeze,
        extraIds: { key: 'identity-export/inputs/waves.json' }
      })
    ).rejects.toThrow('not valid JSON');
    expect(bad.deps.openSnapshot).not.toHaveBeenCalled();
    expect(bad.order).toEqual([]);
  });

  it('takes an empty cms-fields.json at the freeze: a site export with no sites', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps } = setup({ objects: siteRun({ cms: '{}' }) });
    const result = await run(deps);
    const options = mockBuild.mock.calls[0][1];
    expect(options.cmsFields).toEqual({});
    expect(options.cmsFieldsFile).toEqual(
      expect.objectContaining({ count: 0, sha256: sha('{}') })
    );
    expect(result.cmsFieldsSource?.sha256).toBe(sha('{}'));
    // Bare, in a rehearsal, it is still refused.
    const bare = setup({
      objects: { 'identity-export/inputs/cms.json': '{}' }
    });
    await expect(
      run(bare.deps, {
        ...rehearsal,
        noCmsFields: undefined,
        cmsFields: { key: 'identity-export/inputs/cms.json' }
      })
    ).rejects.toThrow('The cms fields file is empty');
  });

  it("takes a rehearsal's profile site values by key or inline", async () => {
    mockBuild.mockResolvedValue(document({ freeze_ms: null }));
    const { deps } = setup({
      objects: { 'identity-export/inputs/cms.json': '{"A": {"primary": {}}}' }
    });
    const result = await run(deps, {
      ...rehearsal,
      noCmsFields: undefined,
      cmsFields: { key: 'identity-export/inputs/cms.json' }
    });
    const options = mockBuild.mock.calls[0][1];
    expect(options.cmsFields).toEqual({ a: { primary: {} } });
    expect(options.cmsFieldsFile).toEqual({
      count: 1,
      sha256: sha('{"A": {"primary": {}}}'),
      manifest: null
    });
    expect(result.cmsFieldsSource).toBeNull();
    expect(result.scope.cmsFields).toBe('identity-export/inputs/cms.json');
  });

  describe("the profile site run at the freeze, through the site's pointer", () => {
    it.each([
      [
        'no pointer',
        {},
        `No profile site export for the freeze ${FREEZE_ISO}: ${SITE_POINTER} doesn't exist`
      ],
      [
        'a pointer for another freeze',
        siteRun({ pointer: { frozen_at: '2026-11-23T00:00:00.000Z' } }),
        'is for the freeze 2026-11-23T00:00:00.000Z'
      ],
      [
        'a pointer to another stage',
        siteRun({
          pointer: {
            prefix:
              'profile-site-export/prod/2026-11-24T00-03-00-000Z-site0001/'
          }
        }),
        "prefix must be a run's prefix under profile-site-export/staging/"
      ],
      [
        'a pointer to another manifest',
        siteRun({
          pointer: { manifest: `${SITE_PREFIX}manifest.partial.json` }
        }),
        'not its run'
      ],
      [
        'a manifest changed since the pointer',
        siteRun({ pointer: { manifest_sha256: '0'.repeat(64) } }),
        "records the manifest's sha256 as 0000"
      ],
      [
        'a run that is not whole and usable',
        siteRun({ manifest: { usable: false } }),
        'not of a whole, usable run'
      ],
      [
        'a rehearsal',
        siteRun({ manifest: { rehearsal: true } }),
        'not of a whole, usable run'
      ],
      [
        'a run of another freeze',
        siteRun({ manifest: { frozen_at: '2026-11-23T00:00:00.000Z' } }),
        'exported the freeze "2026-11-23T00:00:00.000Z"'
      ],
      [
        'a run of another stage',
        siteRun({ manifest: { stage: 'prod' } }),
        'is of the stage "prod", not staging'
      ],
      [
        'a cms-fields.json the manifest does not list',
        siteRun({ storedCms: '{"x": {}}' }),
        'lists cms-fields.json with sha256'
      ]
    ])(
      'refuses %s before reading the database',
      async (_name, objects, message) => {
        mockBuild.mockResolvedValue(document());
        const { deps, order } = setup({ objects });
        await expect(run(deps)).rejects.toThrow(message);
        expect(deps.openSnapshot).not.toHaveBeenCalled();
        expect(order).toEqual([]);
      }
    );

    it('says why a pointer can not be read when S3 answers 403', async () => {
      const { deps } = setup({ objects: {}, missingAs403: true });
      await expect(run(deps)).rejects.toThrow(
        "can't be read (S3 answers 403 for a key that doesn't exist)"
      );
    });
  });

  it('writes nothing when the export is refused, and still closes the snapshot', async () => {
    mockBuild.mockRejectedValue(
      new IdentityExportNotReadyError([
        { cause: 'over_credit', message: '2 raters over' }
      ])
    );
    const { deps, order, close } = setup();
    await expect(run(deps)).rejects.toThrow('2 raters over');
    expect(order).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('writes no manifest when an upload fails', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps, order } = setup({ failPutOf: 'summary.json' });
    await expect(run(deps)).rejects.toThrow('upload failed');
    expect(order.some((key) => key.endsWith('manifest.json'))).toBe(false);
  });

  it.each([[{ DB_HOST_READ: undefined }], [{ DB_HOST_READ: 'primary-host' }]])(
    'refuses without the read replica (%j)',
    async (env) => {
      const { deps, order } = setup({ env });
      await expect(run(deps)).rejects.toThrow(/read replica/);
      expect(deps.openSnapshot).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    }
  );

  it('refuses a bucket that does not block all public access', async () => {
    const { deps, order } = setup({ publicBlock: false });
    await expect(run(deps)).rejects.toThrow(/public access/);
    expect(deps.openSnapshot).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  describe('the pointer for the freeze', () => {
    it('refuses a second run for the freeze before reading, unless it replaces the pointer', async () => {
      mockBuild.mockResolvedValue(document());
      const { deps, bodies } = setup();
      const first = await run(deps);
      const second = setup({ objects: Object.fromEntries(bodies) });
      await expect(run(second.deps)).rejects.toThrow(
        `${POINTER} exists: the run under ${first.prefix} is this freeze's export. To make a new run the export instead, run again with replacePointer: true`
      );
      expect(second.deps.openSnapshot).not.toHaveBeenCalled();
      expect(second.order).toEqual([]);

      const replacing = await run(
        second.deps,
        { ...atFreeze, replacePointer: true },
        { awsRequestId: 'ffff0000' }
      );
      expect(replacing.prefix).not.toBe(first.prefix);
      expect(replacing.pointerKey).toBe(POINTER);
      expect(replacing.replacedPointer).toEqual(
        expect.objectContaining({
          prefix: first.prefix,
          manifest_sha256: first.manifestSha256
        })
      );
      expect(JSON.parse(second.bodies.get(POINTER)!).prefix).toBe(
        replacing.prefix
      );
      const manifest = JSON.parse(second.bodies.get(replacing.manifestKey)!);
      expect(manifest.replace_pointer).toBe(true);
      expect(manifest.replaced_pointer.prefix).toBe(first.prefix);
      // The replacing write is unconditional; the first was not.
      const pointerPuts = second.send.mock.calls
        .map(([command]) => command)
        .filter(
          (command) =>
            command instanceof PutObjectCommand && command.input.Key === POINTER
        );
      expect(pointerPuts.map((command) => command.input.IfNoneMatch)).toEqual([
        undefined
      ]);
      expect(deps.s3.send as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ Key: POINTER, IfNoneMatch: '*' })
        })
      );
    });

    it('keeps a pointer another run wrote meanwhile, and reports it', async () => {
      mockBuild.mockImplementation(async () => {
        // Another run writes the pointer while this one reads.
        bodies.set(POINTER, '{"prefix": "identity-export/staging/other/"}');
        return document();
      });
      const { deps, bodies } = setup();
      const result = await run(deps);
      expect(result.usable).toBe(true);
      expect(result.pointerKey).toBeNull();
      expect(result.pointerError).toContain(
        `${POINTER} names another run for this freeze, written while this one ran, and was kept`
      );
      expect(JSON.parse(bodies.get(POINTER)!).prefix).toBe(
        'identity-export/staging/other/'
      );
      expect(bodies.has(result.manifestKey)).toBe(true);
    });

    it('takes its own pointer as written when a retry is refused because the first write landed', async () => {
      mockBuild.mockResolvedValue(document());
      const { deps, bodies } = setup({ pointerAnswerLost: true });
      const result = await run(deps);
      expect(result.pointerKey).toBe(POINTER);
      expect(result.pointerError).toBeNull();
      expect(result.presignedPointerUrl).toContain(POINTER);
      expect(JSON.parse(bodies.get(POINTER)!)).toMatchObject({
        prefix: result.prefix,
        manifest_sha256: result.manifestSha256
      });
    });

    it('reports a pointer that could not be written; the run stays whole', async () => {
      mockBuild.mockResolvedValue(document());
      const { deps } = setup({ failPutOf: '2026-11-24T00-00-00-000Z.json' });
      const result = await run(deps);
      expect(result.pointerKey).toBeNull();
      expect(result.pointerError).toBe('upload failed');
      expect(result.manifestKey).toMatch(/manifest\.json$/);
    });
  });

  it('gives fresh links for an earlier run, by its prefix or its freeze', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps, bodies } = setup();
    const first = await run(deps);
    const byPrefix = (await runIdentityExportJob(
      parseIdentityExportEvent({
        job: 'identityExportLinks',
        prefix: first.prefix
      })!,
      context,
      deps
    )) as IdentityExportLinksResult;
    expect(byPrefix).toMatchObject({
      job: 'identityExportLinks',
      bucket: BUCKET,
      prefix: first.prefix,
      manifestKey: first.manifestKey,
      manifestSha256: first.manifestSha256,
      usable: true,
      pointerKey: null,
      presignedPointerUrl: null
    });
    const links = JSON.parse(bodies.get(byPrefix.linksKey)!);
    expect(Object.keys(links.links)).toEqual([
      'identity-export.json',
      'summary.json',
      'links.json',
      'manifest.json'
    ]);
    const byFreeze = (await runIdentityExportJob(
      parseIdentityExportEvent({
        job: 'identityExportLinks',
        freezeAt: '2026-11-24T00:00:00Z'
      })!,
      context,
      deps
    )) as IdentityExportLinksResult;
    expect(byFreeze).toMatchObject({
      prefix: first.prefix,
      manifestSha256: first.manifestSha256,
      pointerKey: POINTER,
      presignedPointerUrl: expect.stringContaining(POINTER)
    });
    // A manifest that is no longer the one the pointer names.
    bodies.set(first.manifestKey, `${bodies.get(first.manifestKey)} `);
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent({
          job: 'identityExportLinks',
          freezeAt: '2026-11-24T00:00:00Z'
        })!,
        context,
        deps
      )
    ).rejects.toThrow('The pointer for that freeze names');
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent({
          job: 'identityExportLinks',
          freezeAt: '2026-11-25T00:00:00Z'
        })!,
        context,
        deps
      )
    ).rejects.toThrow('No run for that freeze');
  });

  it('writes a rehearsal under its own prefix with only manifest.unusable.json', async () => {
    mockBuild.mockResolvedValue(document({ freeze_ms: null }));
    const { deps, order, bodies } = setup({
      env: { NODE_ENV: 'production' },
      freezeSecret: undefined
    });
    const result = await run(deps, rehearsal, { awsRequestId: 'abcdef12' });
    expect(result.prefix).toMatch(
      /^identity-export\/prod\/[0-9TZ-]+-abcdef12-rehearsal\/$/
    );
    expect(result.usable).toBe(false);
    expect(result.snapshotGapSeconds).toBeNull();
    expect(result.identityFreezeAtReading).toBe('unset');
    expect(result.manifestKey).toBe(`${result.prefix}manifest.unusable.json`);
    expect(order.some((key) => key.endsWith('/manifest.json'))).toBe(false);
    expect(result.pointerKey).toBeNull();
    expect(order.some((key) => key.includes('/by-freeze/'))).toBe(false);
    const manifest = JSON.parse(bodies.get(result.manifestKey)!);
    expect(manifest.usable).toBe(false);
    const again = await runIdentityExportJob(
      parseIdentityExportEvent({
        job: 'identityExportLinks',
        prefix: result.prefix
      })!,
      context,
      deps
    );
    expect(again).toMatchObject({ usable: false });
  });

  it.each([
    ['before the freeze', '2026-11-23T23:59:00.000Z', 40, /before the freeze/],
    [
      'less than 2 minutes after it',
      '2026-11-24T00:01:59.000Z',
      null,
      'The snapshot is 119 s after the freeze: wait until at least 120 s after it'
    ],
    [
      'too long after it',
      '2026-11-24T02:00:00.000Z',
      40,
      /over the 90-minute limit/
    ],
    [
      'from a replica as far behind as the gap',
      '2026-11-24T00:05:00.000Z',
      300_000,
      'The replica is 300000 ms behind its writer, not less than the 300 s since the freeze'
    ]
  ])(
    'refuses a snapshot %s, writing nothing',
    async (_name, snapshotAt, replicaLagMs, message) => {
      mockBuild.mockResolvedValue(document());
      const { deps, order, close } = setup({ snapshotAt, replicaLagMs });
      await expect(run(deps)).rejects.toThrow(message);
      expect(mockBuild).not.toHaveBeenCalled();
      expect(order).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    }
  );

  it('refuses a replica lag it can not read, unless told to rely on the gap alone', async () => {
    mockBuild.mockResolvedValue(document());
    const refused = setup({ replicaLagMs: null });
    await expect(run(refused.deps)).rejects.toThrow(
      "The replica's lag can't be read (information_schema.replica_host_status): only the gap since the freeze shows it holds the writes made before it. To rely on that gap alone, run again with acceptUnknownReplicaLag: true."
    );
    expect(mockBuild).not.toHaveBeenCalled();
    expect(refused.order).toEqual([]);
    const accepted = setup({ replicaLagMs: null });
    const result = await run(accepted.deps, {
      ...atFreeze,
      acceptUnknownReplicaLag: true
    });
    expect(result.evidence.replicaLagMs).toBeNull();
    expect(
      JSON.parse(accepted.bodies.get(result.manifestKey)!)
        .accept_unknown_replica_lag
    ).toBe(true);
    // Only for an export at the freeze.
    expect(() =>
      parseIdentityExportEvent({ ...rehearsal, acceptUnknownReplicaLag: true })
    ).toThrow('an acknowledgement is only for an export at the freeze');
  });

  it('takes a snapshot 2 minutes after the freeze, the lag unknown and accepted, or below the gap', async () => {
    mockBuild.mockResolvedValue(document());
    const unknown = setup({
      snapshotAt: '2026-11-24T00:02:00.000Z',
      replicaLagMs: null
    });
    expect(
      (await run(unknown.deps, { ...atFreeze, acceptUnknownReplicaLag: true }))
        .snapshotGapSeconds
    ).toBe(120);
    const behind = setup({
      snapshotAt: '2026-11-24T00:05:00.000Z',
      replicaLagMs: 299_999
    });
    expect((await run(behind.deps)).evidence.replicaLagMs).toBe(299_999);
  });

  it('takes a later snapshot when the gap is acknowledged', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps } = setup({ snapshotAt: '2026-11-24T02:00:00.000Z' });
    const result = await run(deps, {
      ...atFreeze,
      acceptSnapshotGapMinutes: 150
    });
    expect(result.snapshotGapSeconds).toBe(7200);
  });

  it('stops with its step before the deadline, writing nothing', async () => {
    mockBuild.mockImplementation(async (_source, options) => {
      options.log('core: 3 profiles');
      return document();
    });
    const { deps, order } = setup();
    await expect(
      run(deps, atFreeze, { getRemainingTimeInMillis: () => 30_000 })
    ).rejects.toThrow(/Stopped after "IDENTITY EXPORT core: 3 profiles"/);
    expect(order).toEqual([]);
  });

  it('checks the deadline after the delegations read and before the uploads', async () => {
    mockBuild.mockImplementation(async (_source, options) => {
      options.log('delegations: 2 read');
      return document();
    });
    const late = setup();
    await expect(
      run(late.deps, atFreeze, { getRemainingTimeInMillis: () => 30_000 })
    ).rejects.toThrow(/Stopped after "IDENTITY EXPORT delegations: 2 read"/);
    // Time enough for the read, not for the uploads.
    const remaining = jest
      .fn()
      .mockReturnValueOnce(600_000)
      .mockReturnValueOnce(600_000)
      .mockReturnValue(30_000);
    const { deps, order } = setup();
    await expect(
      run(deps, atFreeze, { getRemainingTimeInMillis: remaining })
    ).rejects.toThrow(/Stopped after "UPLOADS"/);
    expect(order).toEqual([]);
  });

  it("keeps the run's own error when closing the snapshot also fails", async () => {
    mockBuild.mockRejectedValue(new Error('read failed'));
    const { deps } = setup({ closeFails: true });
    await expect(run(deps)).rejects.toThrow('read failed');
  });

  it('reads a 403 on the manifest as no manifest, and says why', async () => {
    const { deps } = setup({ missingAs403: true });
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent({
          job: 'identityExportLinks',
          prefix: 'identity-export/staging/missing/'
        })!,
        context,
        deps
      )
    ).rejects.toThrow(/No manifest under .*S3 refused the read/);
  });

  it('refuses a links request for a pointer', () => {
    expect(() =>
      parseIdentityExportEvent({
        job: 'identityExportLinks',
        prefix: 'identity-export/prod/by-freeze/'
      })
    ).toThrow(IdentityExportEventError);
  });

  it('says so when a links request names a run with no manifest', async () => {
    const { deps } = setup();
    await expect(
      runIdentityExportJob(
        parseIdentityExportEvent({
          job: 'identityExportLinks',
          prefix: 'identity-export/staging/missing/'
        })!,
        context,
        deps
      )
    ).rejects.toThrow(/No manifest under identity-export\/staging\/missing\//);
  });

  it.each([
    [undefined, 'IDENTITY_FREEZE_AT is not set: an export at the freeze'],
    ['Tuesday', 'IDENTITY_FREEZE_AT is set but is not a time ("Tuesday")'],
    [
      '2026-11-25T00:00:00Z',
      'the freeze 2026-11-24T00:00:00.000Z is not IDENTITY_FREEZE_AT 2026-11-25T00:00:00.000Z'
    ],
    // Read as the site reads it: digits are milliseconds, so seconds are
    // another time.
    [String(T / 1000), 'is not IDENTITY_FREEZE_AT 1970-01-21']
  ])(
    'refuses IDENTITY_FREEZE_AT %j at the freeze, before reading',
    async (setting, message) => {
      mockBuild.mockResolvedValue(document());
      const { deps, order } = setup({ freezeSecret: setting });
      await expect(run(deps)).rejects.toThrow(message);
      await expect(run(deps)).rejects.toThrow(
        'read from the prod/lambdas secret of this region at the start of the run'
      );
      expect(deps.openSnapshot).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    }
  );

  it("reads IDENTITY_FREEZE_AT from the secret at each run, not the container's environment", async () => {
    mockBuild.mockResolvedValue(document());
    // A warm container loaded the secret before it was fixed.
    const fixed = setup({
      env: { IDENTITY_FREEZE_AT: '2026-11-25T00:00:00Z' },
      freezeSecret: '2026-11-24T00:00:00Z'
    });
    const result = await run(fixed.deps);
    expect(result).toMatchObject({
      usable: true,
      identityFreezeAtSecret: 'prod/lambdas',
      identityFreezeAtReading: 'time',
      identityFreezeAt: FREEZE_ISO
    });
    expect(fixed.deps.identityFreezeAt).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(fixed.bodies.get(result.manifestKey)!).identity_freeze_at
    ).toEqual({ secret: 'prod/lambdas', reading: 'time', at: FREEZE_ISO });
    // ...and the other way round.
    const stale = setup({
      env: { IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z' },
      freezeSecret: undefined
    });
    await expect(run(stale.deps)).rejects.toThrow(
      'IDENTITY_FREEZE_AT is not set'
    );
  });

  it('takes IDENTITY_FREEZE_AT as Unix milliseconds or with +00:00', async () => {
    mockBuild.mockResolvedValue(document());
    for (const setting of [String(T), '2026-11-24T00:00:00.000+00:00']) {
      const { deps } = setup({ freezeSecret: setting });
      await expect(run(deps)).resolves.toMatchObject({
        usable: true,
        identityFreezeAt: FREEZE_ISO
      });
    }
  });

  describe("the build's commit", () => {
    it('refuses a revision that is not the commit the function was built from, before reading', async () => {
      const { deps, order } = setup({ buildCommit: 'b'.repeat(40) });
      await expect(run(deps, { ...atFreeze, revision: REV })).rejects.toThrow(
        `revision ${REV} is not the commit this function was built from (${'b'.repeat(40)})`
      );
      expect(deps.openSnapshot).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    });

    it('writes the build commit, the same revision given or not', async () => {
      mockBuild.mockResolvedValue(document());
      const { deps } = setup({ buildCommit: 'b'.repeat(40) });
      const result = await run(deps, {
        ...atFreeze,
        revision: 'B'.repeat(40)
      });
      expect(result.revision).toBe('b'.repeat(40));
      expect(mockBuild.mock.calls[0][1].exporterRevision).toBe('b'.repeat(40));
    });

    it("keeps the invoker's revision when the build can't tell, and says so", async () => {
      mockBuild.mockResolvedValue(document());
      const unknown = setup({ buildCommit: null });
      await expect(run(unknown.deps)).rejects.toThrow(
        "This function's build doesn't record its commit: give revision"
      );
      const { deps, bodies } = setup({ buildCommit: null });
      const result = await run(deps, { ...atFreeze, revision: REV });
      expect(result).toMatchObject({ revision: REV, buildCommit: null });
      expect(mockBuild.mock.calls[0][1].notes).toEqual([
        `the function's build commit is unknown: exporter_revision ${REV} is the invoker's, unchecked`
      ]);
      expect(JSON.parse(bodies.get(result.manifestKey)!).build_commit).toBe(
        null
      );
    });
  });
});
