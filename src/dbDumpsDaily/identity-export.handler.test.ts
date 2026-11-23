import { createHash } from 'node:crypto';
import {
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { IdentityExportNotReadyError } from '@/identity-export/identity-export.errors';
import { Logger } from '@/logging';
import {
  checkReplicaLag,
  checkSnapshotTime,
  ReplicaLagAcceptance,
  IdentityExportDeps,
  IdentityExportEventError,
  IdentityExportLinksResult,
  IdentityExportResult,
  IdentityExportServiceError,
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
    /**
     * The pointer's write is refused (412), and reading it back finds it
     * missing or is refused (403).
     */
    pointerConflictUnread?: 'missing' | 'forbidden';
    /** The pointer's write is refused (412), and reading it back throws this. */
    pointerReadFailsWith?: Error;
    publicBlock?: boolean;
    snapshotAt?: string;
    replicaLagMs?: number | null;
    /** The lag row's age (default 0, null when the lag is). */
    replicaLagAgeMs?: number | null;
    /** Why the lag couldn't be read (default: when it is null, not Aurora). */
    replicaLagError?: string | null;
    /** Why the lag is unknown (default: unreadable when it is null). */
    replicaLagUnknown?: 'unreadable' | 'dated_ahead' | null;
    /** How far ahead of UTC the row is dated (7 200 000 ms when dated_ahead). */
    replicaLagAheadMs?: number | null;
    /** The bucket's privacy check fails with this error. */
    privacyFailsWith?: Error;
    /** What the upload named by failPutOf throws (an 'upload failed' Error). */
    failPutWith?: Error;
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
  // Set once the pointer's write is refused: its read-back comes after.
  let pointerRefused = false;
  const send = jest.fn(async (command: any) => {
    // Every call names the bucket's expected owner: the function's account.
    if (command.input.ExpectedBucketOwner !== OWNER) {
      throw new Error(`no ExpectedBucketOwner on ${command.constructor.name}`);
    }
    if (command instanceof GetPublicAccessBlockCommand) {
      if (options.privacyFailsWith) throw options.privacyFailsWith;
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
        throw options.failPutWith ?? new Error('upload failed');
      }
      // S3 refuses an upload whose bytes don't match its checksum.
      const sum = createHash('sha256')
        .update(command.input.Body as Buffer)
        .digest('base64');
      if (command.input.ChecksumSHA256 !== sum) {
        throw new Error(`bad checksum for ${key}`);
      }
      if (
        (options.pointerConflictUnread || options.pointerReadFailsWith) &&
        key.includes('/by-freeze/')
      ) {
        pointerRefused = true;
        throw Object.assign(new Error('At least one precondition failed'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 }
        });
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
      if (
        options.pointerReadFailsWith &&
        pointerRefused &&
        command.input.Key!.startsWith('identity-export/') &&
        command.input.Key!.includes('/by-freeze/')
      ) {
        throw options.pointerReadFailsWith;
      }
      const body = bodies.get(command.input.Key!);
      if (body === undefined) {
        const forbidden =
          options.missingAs403 ||
          (options.pointerConflictUnread === 'forbidden' &&
            command.input.Key!.startsWith('identity-export/'));
        throw forbidden
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
        endpoint: 'reader' as const,
        transactionReadOnly: true,
        serverReadOnly: true,
        innodbReadOnly: null,
        snapshotAt: options.snapshotAt ?? '2026-11-24T00:30:00.000Z',
        replicaLagMs:
          options.replicaLagMs === undefined ? 40 : options.replicaLagMs,
        replicaLagAgeMs:
          options.replicaLagAgeMs !== undefined
            ? options.replicaLagAgeMs
            : options.replicaLagMs === null
              ? null
              : 0,
        replicaLagError:
          options.replicaLagError !== undefined
            ? options.replicaLagError
            : options.replicaLagMs === null
              ? 'ER_UNKNOWN_TABLE 1109'
              : null,
        replicaLagUnknown:
          options.replicaLagUnknown !== undefined
            ? options.replicaLagUnknown
            : options.replicaLagMs === null
              ? ('unreadable' as const)
              : null,
        replicaLagAheadMs:
          options.replicaLagAheadMs !== undefined
            ? options.replicaLagAheadMs
            : options.replicaLagUnknown === 'dated_ahead'
              ? 7_200_000
              : null
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

  it('takes acceptUnknownReplicaLag as a case or a list of them, older_than_gap and dated_ahead with their bounds', () => {
    expect(
      parseIdentityExportEvent({
        ...atFreeze,
        acceptUnknownReplicaLag: { older_than_gap: 3_660_000 }
      })
    ).toEqual(
      expect.objectContaining({
        acceptUnknownReplicaLag: [{ older_than_gap: 3_660_000 }]
      })
    );
    expect(
      parseIdentityExportEvent({
        ...atFreeze,
        acceptUnknownReplicaLag: [
          { dated_ahead: 7_140_000 },
          { older_than_gap: 180_000 }
        ]
      })
    ).toEqual(
      expect.objectContaining({
        acceptUnknownReplicaLag: [
          { dated_ahead: 7_140_000 },
          { older_than_gap: 180_000 }
        ]
      })
    );
    expect(
      parseIdentityExportEvent({
        ...atFreeze,
        acceptUnknownReplicaLag: ['unreadable', { dated_ahead: 7_140_000 }]
      })
    ).toEqual(
      expect.objectContaining({
        acceptUnknownReplicaLag: ['unreadable', { dated_ahead: 7_140_000 }]
      })
    );
  });

  it('takes bounds at the edges of the time zones', () => {
    for (const bounds of [
      [{ older_than_gap: 120_000 }, { dated_ahead: 51_000_000 }],
      [{ older_than_gap: 51_000_000 }, { dated_ahead: 1_740_000 }]
    ]) {
      expect(
        parseIdentityExportEvent({
          ...atFreeze,
          acceptUnknownReplicaLag: bounds
        })
      ).toEqual(expect.objectContaining({ acceptUnknownReplicaLag: bounds }));
    }
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
      acceptNoCmsFields: false,
      acceptBulk: null,
      acceptSnapshotGapMinutes: null,
      acceptUnknownReplicaLag: [],
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
      { ...atFreeze, acceptUnknownReplicaLag: true },
      'acceptUnknownReplicaLag must name each case to accept, as the refusals do: "unreadable", {"dated_ahead": <smallest lead in ms: Monday\'s replicaLagAheadMs minus 60000>}, or {"older_than_gap": <largest row age in ms: Monday\'s replicaLagAgeMs plus 60000>}; one or a list, each once. A bound on a row\'s age is 120000 to 51000000 ms, on its lead 1740000 to 51000000 ms. true and a bare "dated_ahead" or "older_than_gap" are not accepted: a rerun that lands on another reader showing another case, or a reader that stopped, must be refused.'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: 'older_than_gap' },
      'true and a bare "dated_ahead" or "older_than_gap" are not accepted'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: 'dated_ahead' },
      'true and a bare "dated_ahead" or "older_than_gap" are not accepted'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: ['unreadable', 'dated_ahead'] },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    // Both bounds within the zones: a lead of a minute or more, an age of
    // the 2-minute minimum gap or more, neither past 14 h 10 min.
    [
      { ...atFreeze, acceptUnknownReplicaLag: { dated_ahead: 59_999 } },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    // No time zone is less than 30 minutes from UTC.
    [
      { ...atFreeze, acceptUnknownReplicaLag: { dated_ahead: 1_739_999 } },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: { dated_ahead: 51_000_001 } },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: { older_than_gap: 119_999 } },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: { older_than_gap: 51_000_001 } },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: { dated_ahead: '7140000' } },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      {
        ...atFreeze,
        acceptUnknownReplicaLag: [
          { dated_ahead: 7_140_000 },
          { dated_ahead: 7_000_000 }
        ]
      },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: 'stale' },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      {
        ...atFreeze,
        acceptUnknownReplicaLag: [
          { older_than_gap: 180_000 },
          { older_than_gap: 240_000 }
        ]
      },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: ['unreadable', 'unreadable'] },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: { older_than_gap: 0 } },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      { ...atFreeze, acceptUnknownReplicaLag: { older_than_gap: 1.5 } },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      {
        ...atFreeze,
        acceptUnknownReplicaLag: { older_than_gap: 8 * 24 * 3_600_000 }
      },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
    [
      {
        ...atFreeze,
        acceptUnknownReplicaLag: { older_than_gap: 180_000, extra: 1 }
      },
      'acceptUnknownReplicaLag must name each case to accept'
    ],
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
      endpoint: 'reader',
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
      read: {
        endpoint: 'reader',
        read_only: true,
        replicaLagMs: 40,
        replicaLagAgeMs: 0,
        replicaLagError: null,
        replicaLagUnknown: null,
        replicaLagAheadMs: null
      },
      replica_lag_accepted: null
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

  it('takes an empty cms-fields.json at the freeze only with acceptNoCmsFields: a site export with no sites', async () => {
    mockBuild.mockResolvedValue(document());
    // A fault in the site export that wrote {} looks the same: refused
    // before the database is read.
    const refused = setup({ objects: siteRun({ cms: '{}' }) });
    await expect(run(refused.deps)).rejects.toThrow(
      'the profile site export has no profile site values (its cms-fields.json is empty), so no identity would carry one. Only if that site export really has no sites, acknowledge it with "acceptNoCmsFields": true; one that should have sites is a fault: report it'
    );
    expect(refused.deps.openSnapshot).not.toHaveBeenCalled();
    expect(refused.order).toEqual([]);
    // The flag with a file that has values: refused too.
    const full = setup();
    await expect(
      run(full.deps, { ...atFreeze, acceptNoCmsFields: true })
    ).rejects.toThrow(
      'acceptNoCmsFields is only for an empty cms-fields.json: this one has 1 profile site values; leave acceptNoCmsFields out'
    );
    expect(full.deps.openSnapshot).not.toHaveBeenCalled();
    const { deps } = setup({ objects: siteRun({ cms: '{}' }) });
    const result = await run(deps, { ...atFreeze, acceptNoCmsFields: true });
    const options = mockBuild.mock.calls[0][1];
    expect(options.acceptNoCmsFields).toBe(true);
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

    it.each([
      ['missing', 'it is missing'],
      ['forbidden', 'S3 refused the read']
    ] as const)(
      'says it is unknown whose run the pointer names when it reads back %s',
      async (unread, reason) => {
        mockBuild.mockResolvedValue(document());
        const { deps } = setup({ pointerConflictUnread: unread });
        const result = await run(deps);
        expect(result.usable).toBe(true);
        expect(result.pointerKey).toBeNull();
        expect(result.presignedPointerUrl).toBeNull();
        expect(result.pointerError).toBe(
          `S3 refused to write ${POINTER} because one is there, and reading it back failed (${reason}): whether it names this run is unknown. Ask for links by freezeAt: if their prefix is this run's, the pointer is this run's; if not, it names another run, and this run is fetched by its prefix.`
        );
      }
    );

    it('reports a pointer that could not be written; the run stays whole', async () => {
      mockBuild.mockResolvedValue(document());
      const { deps } = setup({ failPutOf: '2026-11-24T00-00-00-000Z.json' });
      const result = await run(deps);
      expect(result.pointerKey).toBeNull();
      // Its name only: the message stays in the log.
      expect(result.pointerError).toBe(
        "The pointer write failed: Error. Its message is in the function's log."
      );
      expect(result.manifestKey).toMatch(/manifest\.json$/);
    });

    it('gives a failed pointer write by its code, never its message', async () => {
      mockBuild.mockResolvedValue(document());
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        const timedOut = setup({
          failPutOf: '2026-11-24T00-00-00-000Z.json',
          failPutWith: Object.assign(
            new Error('connect ETIMEDOUT 192.0.2.7:443'),
            {
              code: 'ETIMEDOUT',
              errno: -110,
              syscall: 'connect',
              address: '192.0.2.7',
              port: 443
            }
          )
        });
        const result = await run(timedOut.deps);
        expect(result.pointerKey).toBeNull();
        expect(result.pointerError).toBe(
          "The pointer write failed: ETIMEDOUT -110. Its message is in the function's log."
        );
        expect(JSON.stringify(result)).not.toContain('192.0.2.7');
        // The message goes to the log.
        expect(
          warn.mock.calls.some(([line]) =>
            String(line).includes('connect ETIMEDOUT 192.0.2.7:443')
          )
        ).toBe(true);
        // A DNS failure says so, by its code.
        const dns = setup({
          failPutOf: '2026-11-24T00-00-00-000Z.json',
          failPutWith: Object.assign(
            new Error('getaddrinfo EAI_AGAIN bucket.s3.example.invalid'),
            {
              code: 'EAI_AGAIN',
              errno: -3001,
              syscall: 'getaddrinfo',
              hostname: 'bucket.s3.example.invalid'
            }
          )
        });
        const looked = await run(dns.deps);
        expect(looked.pointerError).toBe(
          "The pointer write failed: DNS lookup failed, EAI_AGAIN -3001. Its message is in the function's log."
        );
        expect(JSON.stringify(looked)).not.toContain('example.invalid');
      } finally {
        warn.mockRestore();
      }
    });

    it('gives a failed read-back by its code, never its message', async () => {
      mockBuild.mockResolvedValue(document());
      const { deps } = setup({
        pointerReadFailsWith: Object.assign(
          new Error('socket hang up from bucket.s3.example.invalid'),
          { code: 'ECONNRESET' }
        )
      });
      const result = await run(deps);
      expect(result.pointerKey).toBeNull();
      expect(result.pointerError).toBe(
        `S3 refused to write ${POINTER} because one is there, and reading it back failed (ECONNRESET): whether it names this run is unknown. Ask for links by freezeAt: if their prefix is this run's, the pointer is this run's; if not, it names another run, and this run is fetched by its prefix.`
      );
      expect(JSON.stringify(result)).not.toMatch(/socket hang up|example/);
      // An error that is no network error: its name only.
      const parse = setup({
        pointerReadFailsWith: new SyntaxError('Unexpected token < in JSON')
      });
      expect((await run(parse.deps)).pointerError).toContain(
        'reading it back failed (SyntaxError)'
      );
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
      '400 ms before the freeze',
      '2026-11-23T23:59:59.600Z',
      40,
      /is before the freeze/
    ],
    [
      '119.6 s after it',
      '2026-11-24T00:01:59.600Z',
      40,
      'The snapshot is 119.6 s after the freeze: wait until at least 120 s after it'
    ],
    [
      'from a replica as far behind as the gap, to the millisecond',
      '2026-11-24T00:05:00.400Z',
      300_400,
      "The replica may be 300400 ms behind its writer (a 300400 ms lag in a row 0 ms old), which with 1500 ms for the row's timestamp is not less than the 300400 ms since the freeze"
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
      "The replica may be 300000 ms behind its writer (a 300000 ms lag in a row 0 ms old), which with 1500 ms for the row's timestamp is not less than the 300000 ms since the freeze"
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

  it('checks the gap in milliseconds and reports it both ways', async () => {
    const T0 = Date.UTC(2026, 10, 24);
    expect(checkSnapshotTime(T0, T0 + 120_000, null, 120)).toEqual({
      gapMs: 120_000,
      gapSeconds: 120
    });
    expect(checkSnapshotTime(T0, T0 + 300_400, null, 120)).toEqual({
      gapMs: 300_400,
      gapSeconds: 300
    });
    expect(() => checkSnapshotTime(T0, T0 - 400, null)).toThrow(
      'before the freeze'
    );
    expect(() => checkSnapshotTime(T0, T0 + 119_600, null, 120)).toThrow(
      'The snapshot is 119.6 s after the freeze'
    );
    // Just over the limit, by half a second.
    expect(() => checkSnapshotTime(T0, T0 + 90 * 60_000 + 500, null)).toThrow(
      'over the 90-minute limit'
    );
    const lag = (lagMs: number | null, ageMs: number | null) => ({
      replicaLagMs: lagMs,
      replicaLagAgeMs: ageMs,
      replicaLagError: lagMs === null || ageMs === null ? 'unknown' : null,
      replicaLagUnknown:
        lagMs === null || ageMs === null ? ('unreadable' as const) : null,
      replicaLagAheadMs: null
    });
    expect(() => checkReplicaLag(300_400, lag(300_400, 0))).toThrow(
      'not less than the 300400 ms since the freeze'
    );
    // With the row's 1.5 s margin, to the millisecond.
    expect(() => checkReplicaLag(300_400, lag(298_900, 0))).toThrow(
      "which with 1500 ms for the row's timestamp is not less than the 300400 ms since the freeze"
    );
    expect(() => checkReplicaLag(300_400, lag(298_899, 0))).not.toThrow();
    mockBuild.mockResolvedValue(document());
    const { deps, bodies } = setup({
      snapshotAt: '2026-11-24T00:05:00.400Z',
      replicaLagMs: 298_899
    });
    const result = await run(deps);
    expect([result.snapshotGapMs, result.snapshotGapSeconds]).toEqual([
      300_400, 300
    ]);
    expect(result).toMatchObject({
      acceptUnknownReplicaLag: [],
      replacePointer: false
    });
    const manifest = JSON.parse(bodies.get(result.manifestKey)!);
    expect([manifest.snapshot_gap_ms, manifest.snapshot_gap_seconds]).toEqual([
      300_400, 300
    ]);
  });

  it("counts the lag row's age: a stale row's lag runs from when it was written", async () => {
    const lag = (lagMs: number, ageMs: number) => ({
      replicaLagMs: lagMs,
      replicaLagAgeMs: ageMs,
      replicaLagError: null,
      replicaLagUnknown: null,
      replicaLagAheadMs: null
    });
    // A small lag in an old row: lag plus age, plus the 1.5 s margin,
    // against the gap.
    expect(() => checkReplicaLag(300_400, lag(100_000, 198_900))).toThrow(
      "The replica may be 298900 ms behind its writer (a 100000 ms lag in a row 198900 ms old), which with 1500 ms for the row's timestamp is not less than the 300400 ms since the freeze: it may not hold every write made before the freeze. Wait a few minutes and run again."
    );
    expect(() => checkReplicaLag(300_400, lag(100_000, 198_899))).not.toThrow();
    // A row older than the whole gap: checked first, and not a wait.
    const old =
      "The replica's lag row is 300400 ms old (a 0 ms lag), older than the 300400 ms since the freeze: LAST_UPDATE_TIMESTAMP may not be in UTC, or the reader stopped updating its row. If the same refusal returns with the row's age grown by the time you waited, the reader stopped updating: report it. Run once more first: a passing error, such as a timeout, clears, and through the reader endpoint the run may land on another reader. Accept it (acceptUnknownReplicaLag: {\"older_than_gap\": <Monday's replicaLagAgeMs plus 60000>}) only for a reading Monday's rehearsal also showed, and only with the identity lead's agreement: the run then relies on the 2-minute minimum gap, and still on the lag the row reports when it has one. Otherwise report it.";
    expect(() => checkReplicaLag(300_400, lag(0, 300_400))).toThrow(old);
    expect(() => checkReplicaLag(300_400, lag(10, 400_000))).toThrow(
      "The replica's lag row is 400000 ms old (a 10 ms lag), older than the 300400 ms since the freeze"
    );
    expect(() => checkReplicaLag(300_400, lag(0, 300_399))).toThrow(
      'The replica may be 300399 ms behind its writer'
    );
    // A lag with no age is an unknown lag.
    expect(() =>
      checkReplicaLag(300_400, {
        replicaLagMs: 40,
        replicaLagAgeMs: null,
        replicaLagError:
          "LAST_UPDATE_TIMESTAMP is null: the row's age is unknown",
        replicaLagUnknown: 'unreadable',
        replicaLagAheadMs: null
      })
    ).toThrow(
      "can't be read from information_schema.replica_host_status (LAST_UPDATE_TIMESTAMP is null: the row's age is unknown)"
    );
    // The job holds the snapshot to it, writing nothing.
    mockBuild.mockResolvedValue(document());
    const stale = setup({
      snapshotAt: '2026-11-24T00:05:00.000Z',
      replicaLagMs: 1_000,
      replicaLagAgeMs: 297_500
    });
    await expect(run(stale.deps)).rejects.toThrow(
      'The replica may be 298500 ms behind its writer (a 1000 ms lag in a row 297500 ms old)'
    );
    expect(mockBuild).not.toHaveBeenCalled();
    expect(stale.order).toEqual([]);
    const stopped = setup({
      snapshotAt: '2026-11-24T00:05:00.000Z',
      replicaLagMs: 5,
      replicaLagAgeMs: 3_600_000
    });
    await expect(run(stopped.deps)).rejects.toThrow(
      "The replica's lag row is 3600000 ms old (a 5 ms lag), older than the 300000 ms since the freeze"
    );
    expect(stopped.order).toEqual([]);
    const fresh = setup({
      snapshotAt: '2026-11-24T00:05:00.000Z',
      replicaLagMs: 1_000,
      replicaLagAgeMs: 297_499
    });
    const result = await run(fresh.deps);
    expect(result.evidence).toMatchObject({
      replicaLagMs: 1_000,
      replicaLagAgeMs: 297_499
    });
  });

  it('refuses a replica lag it can not read, unless told to rely on the gap alone', async () => {
    mockBuild.mockResolvedValue(document());
    const refused = setup({ replicaLagMs: null });
    await expect(run(refused.deps)).rejects.toThrow(
      "The replica's lag can't be read from information_schema.replica_host_status (ER_UNKNOWN_TABLE 1109). Run once more first: a passing error, such as a timeout, clears, and through the reader endpoint the run may land on another reader. Accept it (acceptUnknownReplicaLag: \"unreadable\") only for a reading Monday's rehearsal also showed: for an error, only ER_UNKNOWN_TABLE 1109 or ER_UNKNOWN_SYSTEM_VARIABLE 1193 (the reader isn't Aurora), and only with the identity lead's agreement: the run then relies on the 2-minute minimum gap, and still on the lag the row reports when it has one. Otherwise report it."
    );
    // The server's own error is named, whatever it is: a parse error is a
    // fault to report, not an Aurora question.
    const parseError = setup({
      replicaLagMs: null,
      replicaLagError: 'ER_PARSE_ERROR 1064'
    });
    await expect(run(parseError.deps)).rejects.toThrow('(ER_PARSE_ERROR 1064)');
    expect(() =>
      checkReplicaLag(300_000, {
        replicaLagMs: null,
        replicaLagAgeMs: null,
        replicaLagError: null,
        replicaLagUnknown: null,
        replicaLagAheadMs: null
      })
    ).toThrow('(no reason given)');
    // And the snapshot's log line names it.
    const info = jest.spyOn(Logger.prototype, 'info');
    try {
      await run(setup({ replicaLagMs: null }).deps).catch(() => undefined);
      expect(
        info.mock.calls.some(([line]) =>
          String(line).includes(
            '[REPLICA LAG unknown MS] [LAG ROW AGE unknown MS] [REPLICA LAG ERROR ER_UNKNOWN_TABLE 1109] [REPLICA LAG UNKNOWN unreadable]'
          )
        )
      ).toBe(true);
    } finally {
      info.mockRestore();
    }
    expect(mockBuild).not.toHaveBeenCalled();
    expect(refused.order).toEqual([]);
    const accepted = setup({ replicaLagMs: null });
    const result = await run(accepted.deps, {
      ...atFreeze,
      acceptUnknownReplicaLag: 'unreadable'
    });
    expect(result.evidence.replicaLagMs).toBeNull();
    expect(result.replicaLagAccepted).toBe('unreadable');
    expect(result.acceptUnknownReplicaLag).toEqual(['unreadable']);
    expect(
      JSON.parse(accepted.bodies.get(result.manifestKey)!)
        .accept_unknown_replica_lag
    ).toEqual(['unreadable']);
    // Only for an export at the freeze.
    expect(() =>
      parseIdentityExportEvent({
        ...rehearsal,
        acceptUnknownReplicaLag: 'unreadable'
      })
    ).toThrow('an acknowledgement is only for an export at the freeze');
  });

  it('takes a snapshot 2 minutes after the freeze, the lag unknown and accepted, or below the gap', async () => {
    mockBuild.mockResolvedValue(document());
    const unknown = setup({
      snapshotAt: '2026-11-24T00:02:00.000Z',
      replicaLagMs: null
    });
    expect(
      (
        await run(unknown.deps, {
          ...atFreeze,
          acceptUnknownReplicaLag: ['unreadable']
        })
      ).snapshotGapSeconds
    ).toBe(120);
    const behind = setup({
      snapshotAt: '2026-11-24T00:05:00.000Z',
      replicaLagMs: 298_499
    });
    expect((await run(behind.deps)).evidence.replicaLagMs).toBe(298_499);
  });

  it('accepts a lag it can not trust only when told to, records which, and never a real lag', async () => {
    const reading = (
      lagMs: number | null,
      ageMs: number | null,
      unknown: 'unreadable' | 'dated_ahead' | null = null,
      aheadMs = 7_200_000
    ) => ({
      replicaLagMs: lagMs,
      replicaLagAgeMs: ageMs,
      replicaLagError: unknown
        ? `LAST_UPDATE_TIMESTAMP is ${aheadMs} ms ahead of UTC_TIMESTAMP: not UTC, so the row's age is unknown`
        : null,
      replicaLagUnknown: unknown,
      replicaLagAheadMs: unknown === 'dated_ahead' ? aheadMs : null
    });
    // Monday read the row 7 200 000 ms ahead (a +2 h offset): Tuesday
    // accepts a lead down to that less a minute.
    const LEAD: ReplicaLagAcceptance[] = [{ dated_ahead: 7_140_000 }];
    // Each untrustworthy reading: refused, and accepted only when told to.
    expect(() =>
      checkReplicaLag(300_000, reading(null, null, 'dated_ahead'))
    ).toThrow(
      "The replica's lag row is dated ahead of UTC (LAST_UPDATE_TIMESTAMP is 7200000 ms ahead of UTC_TIMESTAMP: not UTC, so the row's age is unknown): LAST_UPDATE_TIMESTAMP may not be in UTC, so the row's age is unknown. Run once more first: a passing error, such as a timeout, clears, and through the reader endpoint the run may land on another reader. Accept it (acceptUnknownReplicaLag: {\"dated_ahead\": <Monday's replicaLagAheadMs minus 60000>}) only for a reading Monday's rehearsal also showed, and only with the identity lead's agreement: the run then relies on the 2-minute minimum gap, and still on the lag the row reports when it has one. Otherwise report it."
    );
    const all: ReplicaLagAcceptance[] = [
      'unreadable',
      { older_than_gap: 400_000 }
    ];
    expect(
      checkReplicaLag(300_000, reading(null, null, 'dated_ahead'), LEAD)
    ).toBe('dated_ahead');
    expect(
      checkReplicaLag(300_000, reading(null, null, 'unreadable'), [
        'unreadable'
      ])
    ).toBe('unreadable');
    expect(
      checkReplicaLag(300_000, reading(5, 300_000), [
        { older_than_gap: 300_000 }
      ])
    ).toBe('older_than_gap');
    // Only the case named: a rerun that lands on a reader showing another
    // case is refused.
    expect(() =>
      checkReplicaLag(300_000, reading(5, 300_000), ['unreadable'])
    ).toThrow("The replica's lag row is 300000 ms old");
    expect(() =>
      checkReplicaLag(300_000, reading(null, null, 'dated_ahead'), [
        'unreadable',
        { older_than_gap: 3_600_000 }
      ])
    ).toThrow("The replica's lag row is dated ahead of UTC");
    // A trusted reading passes with nothing accepted, named or not.
    expect(checkReplicaLag(300_000, reading(5, 1_000))).toBeNull();
    expect(checkReplicaLag(300_000, reading(5, 1_000), all)).toBeNull();
    // A real lag, its row younger than the gap, is never accepted.
    expect(() =>
      checkReplicaLag(300_000, reading(299_000, 1_000), all)
    ).toThrow('The replica may be 300000 ms behind its writer');
    expect(() =>
      checkReplicaLag(300_000, reading(1_000, 298_000), all)
    ).toThrow('Wait a few minutes and run again.');
    // An accepted case still holds the lag the row reports to the gap. A
    // bounded case adds the bound's 60 s margin: a stall within it passes
    // the bound, so it counts as lag.
    expect(() =>
      checkReplicaLag(300_000, reading(238_500, null, 'dated_ahead'), LEAD)
    ).toThrow(
      "The replica reports a 238500 ms lag (its row's age not counted: dated_ahead; 60000 ms more for a stall within the bound's margin), which with 1500 ms for the row's timestamp is not less than the 300000 ms since the freeze"
    );
    expect(
      checkReplicaLag(300_000, reading(238_499, null, 'dated_ahead'), LEAD)
    ).toBe('dated_ahead');
    expect(() =>
      checkReplicaLag(300_000, reading(238_500, 400_000), all)
    ).toThrow(
      "reports a 238500 ms lag (its row's age not counted: older_than_gap; 60000 ms more for a stall within the bound's margin)"
    );
    expect(checkReplicaLag(300_000, reading(238_499, 400_000), all)).toBe(
      'older_than_gap'
    );
    // unreadable has no bound, so no margin is added.
    expect(() =>
      checkReplicaLag(300_000, reading(298_500, null, 'unreadable'), all)
    ).toThrow("(its row's age not counted: unreadable), which");
    expect(
      checkReplicaLag(300_000, reading(298_499, null, 'unreadable'), all)
    ).toBe('unreadable');
    // An untrusted row's lag never changes: run once more, then report it.
    expect(() =>
      checkReplicaLag(300_000, reading(298_500, null, 'dated_ahead'), LEAD)
    ).toThrow(
      "The row can't be trusted, and a stale row's lag never changes: run once more, and if this refusal comes back unchanged, report it."
    );
    expect(() =>
      checkReplicaLag(300_000, reading(298_500, null, 'dated_ahead'), LEAD)
    ).not.toThrow('Wait a few minutes');
    // With a dated_ahead bound accepted, any other reading is refused: a
    // reader dated ahead that stopped reads as fresh once its lead has run
    // out (a +2 h reader stalled for about 2 h).
    expect(() =>
      checkReplicaLag(300_000, reading(20, 500), [{ dated_ahead: 7_139_000 }])
    ).toThrow(
      "dated_ahead was accepted down to a 7139000 ms lead, but this reader's row reads as fresh: a reader dated ahead that stopped updating reads that way once its lead has run out. Run once more without changing anything; if it reads the same, report it."
    );
    expect(() =>
      checkReplicaLag(300_000, reading(20, 360_000), [...LEAD, ...all])
    ).toThrow(
      "dated_ahead was accepted down to a 7140000 ms lead, but this reader's row reads older_than_gap"
    );
    expect(() =>
      checkReplicaLag(300_000, reading(null, null, 'unreadable'), [
        ...LEAD,
        'unreadable'
      ])
    ).toThrow("this reader's row reads unreadable");
    // Without that bound, the same fresh row passes.
    expect(checkReplicaLag(300_000, reading(20, 500), all)).toBeNull();
    // older_than_gap only up to the bound given: a row that keeps aging
    // past Monday's reading is refused, a constant offset passes.
    const bounded: ReplicaLagAcceptance[] = [{ older_than_gap: 3_660_000 }];
    expect(checkReplicaLag(300_000, reading(5, 3_660_000), bounded)).toBe(
      'older_than_gap'
    );
    expect(() =>
      checkReplicaLag(300_000, reading(5, 3_660_001), bounded)
    ).toThrow(
      "The replica's lag row is 3660001 ms old, over the 3660000 ms accepted for older_than_gap: it has aged past Monday's reading, so the reader may have stopped updating its row. Report it; don't raise the bound."
    );
    // dated_ahead only down to the lead given: a constant offset passes, a
    // lead that shrinks past Monday's reading is refused.
    expect(
      checkReplicaLag(300_000, reading(5, null, 'dated_ahead', 7_199_800), LEAD)
    ).toBe('dated_ahead');
    expect(
      checkReplicaLag(300_000, reading(5, null, 'dated_ahead', 7_140_000), LEAD)
    ).toBe('dated_ahead');
    // The reader stopped at 23:50: by 00:05 its row's lead has shrunk by
    // 15 minutes, still ahead of UTC, and it is refused.
    expect(() =>
      checkReplicaLag(300_000, reading(5, null, 'dated_ahead', 6_300_000), LEAD)
    ).toThrow(
      "The replica's lag row is dated 6300000 ms ahead of UTC, less than the 7140000 ms accepted for dated_ahead: its lead has shrunk since Monday's reading, so the reader may have stopped updating its row. Report it; don't lower the bound."
    );
    expect(() =>
      checkReplicaLag(300_000, reading(5, null, 'dated_ahead', 7_139_999), LEAD)
    ).toThrow('less than the 7140000 ms accepted for dated_ahead');
    // A dated_ahead row without its lead can't pass a bound.
    expect(() =>
      checkReplicaLag(
        300_000,
        { ...reading(5, null, 'dated_ahead'), replicaLagAheadMs: null },
        LEAD
      )
    ).toThrow('less than the 7140000 ms accepted');
    // The job records the case, in the response, the manifest and the log.
    mockBuild.mockResolvedValue(document());
    const warn = jest.spyOn(Logger.prototype, 'warn');
    try {
      const { deps, bodies } = setup({
        snapshotAt: '2026-11-24T00:05:00.000Z',
        replicaLagMs: 5,
        replicaLagAgeMs: 3_600_000
      });
      const result = await run(deps, {
        ...atFreeze,
        acceptUnknownReplicaLag: { older_than_gap: 3_660_000 }
      });
      expect(result.replicaLagAccepted).toBe('older_than_gap');
      const manifest = JSON.parse(bodies.get(result.manifestKey)!);
      expect(manifest.replica_lag_accepted).toBe('older_than_gap');
      // The acceptance as given, bound included.
      expect(manifest.accept_unknown_replica_lag).toEqual([
        { older_than_gap: 3_660_000 }
      ]);
      expect(
        warn.mock.calls.some(([line]) =>
          String(line).includes(
            "[REPLICA LAG ACCEPTED older_than_gap] [THE ROW'S REPORTED LAG, 5 MS, STILL CHECKED] [THE 120 S MINIMUM GAP HELD]"
          )
        )
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('names the lag case in every run, a rehearsal against the minimum gap', async () => {
    mockBuild.mockResolvedValue(document());
    const clean = await run(setup().deps);
    expect(clean.replicaLagCase).toBeNull();
    const accepted = setup({
      snapshotAt: '2026-11-24T00:05:00.000Z',
      replicaLagMs: 5,
      replicaLagAgeMs: 3_600_000
    });
    const result = await run(accepted.deps, {
      ...atFreeze,
      acceptUnknownReplicaLag: { older_than_gap: 3_660_000 }
    });
    expect([result.replicaLagCase, result.replicaLagAccepted]).toEqual([
      'older_than_gap',
      'older_than_gap'
    ]);
    expect(
      JSON.parse(accepted.bodies.get(result.manifestKey)!).replica_lag_case
    ).toBe('older_than_gap');
    // A rehearsal checks no lag, but names the case a real run would refuse
    // on, so Monday can write it down.
    mockBuild.mockResolvedValue(document({ freeze_ms: null }));
    for (const [options, expected] of [
      [{ replicaLagMs: null }, 'unreadable'],
      [
        {
          replicaLagMs: 5,
          replicaLagAgeMs: null,
          replicaLagUnknown: 'dated_ahead' as const
        },
        'dated_ahead'
      ],
      // Older than the 2-minute minimum gap.
      [{ replicaLagMs: 5, replicaLagAgeMs: 180_000 }, 'older_than_gap'],
      [{ replicaLagMs: 5, replicaLagAgeMs: 2_000 }, null]
    ] as const) {
      const { deps, bodies } = setup(options);
      const rehearsed = await run(deps, rehearsal);
      expect(rehearsed.replicaLagCase).toBe(expected);
      expect(rehearsed.replicaLagAccepted).toBeNull();
      expect(
        JSON.parse(bodies.get(rehearsed.manifestKey)!).replica_lag_case
      ).toBe(expected);
    }
    // A row dated ahead gives its lead, for Monday's two readings to
    // compare, in the response and the manifest.
    const ahead = setup({
      replicaLagMs: 5,
      replicaLagAgeMs: null,
      replicaLagUnknown: 'dated_ahead',
      replicaLagAheadMs: 7_199_000
    });
    const led = await run(ahead.deps, rehearsal);
    expect([led.replicaLagCase, led.evidence.replicaLagAheadMs]).toEqual([
      'dated_ahead',
      7_199_000
    ]);
    expect(
      JSON.parse(ahead.bodies.get(led.manifestKey)!).read.replicaLagAheadMs
    ).toBe(7_199_000);
    // A run at the freeze names the case against its own gap: a row 200 s
    // old, 300 s after the freeze, is trusted, though older than the
    // 2-minute minimum.
    mockBuild.mockResolvedValue(document());
    const later = setup({
      snapshotAt: '2026-11-24T00:05:00.000Z',
      replicaLagMs: 5,
      replicaLagAgeMs: 200_000
    });
    const atGap = await run(later.deps);
    expect([atGap.replicaLagCase, atGap.replicaLagAccepted]).toEqual([
      null,
      null
    ]);
  });

  it('accepts a row dated ahead at the freeze only down to the lead given, and records it', async () => {
    mockBuild.mockResolvedValue(document());
    const dated = (aheadMs: number) =>
      setup({
        snapshotAt: '2026-11-24T00:05:00.000Z',
        replicaLagMs: 5,
        replicaLagAgeMs: null,
        replicaLagUnknown: 'dated_ahead',
        replicaLagAheadMs: aheadMs
      });
    const event = {
      ...atFreeze,
      acceptUnknownReplicaLag: { dated_ahead: 7_140_000 }
    };
    const offset = dated(7_199_000);
    const result = await run(offset.deps, event);
    expect([result.replicaLagCase, result.replicaLagAccepted]).toEqual([
      'dated_ahead',
      'dated_ahead'
    ]);
    const manifest = JSON.parse(offset.bodies.get(result.manifestKey)!);
    expect(manifest.replica_lag_accepted).toBe('dated_ahead');
    expect(manifest.accept_unknown_replica_lag).toEqual([
      { dated_ahead: 7_140_000 }
    ]);
    // A reader that stopped: its lead has shrunk past the bound. Refused,
    // nothing written.
    const stopped = dated(6_300_000);
    await expect(run(stopped.deps, event)).rejects.toThrow(
      "The replica's lag row is dated 6300000 ms ahead of UTC, less than the 7140000 ms accepted for dated_ahead"
    );
    expect(stopped.order).toEqual([]);
  });

  it("gives a failed read replica's error by its code only, its message to the log", async () => {
    const error = jest.spyOn(Logger.prototype, 'error');
    try {
      const opening = async (failure: Error) => {
        const { deps } = setup();
        (deps.openSnapshot as jest.Mock).mockRejectedValue(failure);
        return await run(deps).then(
          () => null,
          (e: Error) => e
        );
      };
      // A DNS failure: "DNS lookup failed, retry" and its code, never the
      // host.
      const again = await opening(
        Object.assign(
          new Error('getaddrinfo EAI_AGAIN reader.example.invalid'),
          {
            code: 'EAI_AGAIN',
            errno: -3001,
            syscall: 'getaddrinfo',
            hostname: 'reader.example.invalid'
          }
        )
      );
      expect(again?.name).toBe('IdentityExportDatabaseError');
      expect(again?.message).toBe(
        "DNS lookup failed, retry: EAI_AGAIN -3001 (The read replica, while opening the read-only snapshot). The host it looked up is in the function's log."
      );
      const notFound = await opening(
        Object.assign(
          new Error('getaddrinfo ENOTFOUND reader.example.invalid'),
          {
            code: 'ENOTFOUND',
            errno: -3008,
            hostname: 'reader.example.invalid'
          }
        )
      );
      expect(notFound?.message).toBe(
        "DNS lookup failed, retry: ENOTFOUND -3008 (The read replica, while opening the read-only snapshot). The host it looked up is in the function's log."
      );
      // An error carrying only the hostname.
      const bare = await opening(
        Object.assign(new Error('lost reader.example.invalid'), {
          hostname: 'reader.example.invalid'
        })
      );
      expect(bare?.message).toBe(
        "The read replica failed while opening the read-only snapshot: Error. Its message, which can name the host or user, is in the function's log."
      );
      for (const failure of [again, notFound, bare]) {
        expect(failure?.message).not.toContain('reader.example');
      }
      // A SELECT refused, naming the user and host: every query of the read
      // goes through the replica's executor.
      mockBuild.mockImplementation(async (source) => {
        await source.latestTdhBlock();
        return document();
      });
      const denied = setup();
      denied.executor.execute.mockRejectedValue(
        Object.assign(
          new Error(
            "ER_TABLEACCESS_DENIED_ERROR: SELECT command denied to user 'reader'@'192.0.2.10' for table 'tdh_blocks'"
          ),
          {
            code: 'ER_TABLEACCESS_DENIED_ERROR',
            errno: 1142,
            sqlMessage:
              "SELECT command denied to user 'reader'@'192.0.2.10' for table 'tdh_blocks'"
          }
        )
      );
      const refused = await run(denied.deps).then(
        () => null,
        (e: Error) => e
      );
      expect(refused?.message).toBe(
        "The read replica failed while reading the snapshot: ER_TABLEACCESS_DENIED_ERROR 1142. Its message, which can name the host or user, is in the function's log."
      );
      expect(refused?.message).not.toMatch(/'reader'|192\.0\.2\.10/);
      expect(denied.close).toHaveBeenCalledTimes(1);
      expect(denied.order).toEqual([]);
      // The full messages are in the log.
      const logged = error.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).toContain(
        '[READ REPLICA FAILED] [opening the read-only snapshot] getaddrinfo EAI_AGAIN reader.example.invalid'
      );
      expect(logged).toContain("'reader'@'192.0.2.10'");
      // An export refusal is not a database error: it is kept as it is.
      mockBuild.mockRejectedValue(
        new IdentityExportNotReadyError([{ cause: 'day', message: 'not yet' }])
      );
      await expect(run(setup().deps)).rejects.toBeInstanceOf(
        IdentityExportNotReadyError
      );
    } finally {
      error.mockRestore();
    }
  });

  it('gives any other network failure by its code, apart from the replica', async () => {
    const error = jest.spyOn(Logger.prototype, 'error');
    try {
      mockBuild.mockResolvedValue(document());
      const signing = setup();
      const presign = jest.fn(async () => {
        throw Object.assign(
          new Error('getaddrinfo EAI_AGAIN s3.example.invalid'),
          {
            code: 'EAI_AGAIN',
            errno: -3001,
            syscall: 'getaddrinfo',
            hostname: 's3.example.invalid'
          }
        );
      });
      const failure = await run({ ...signing.deps, presign }).then(
        () => null,
        (e: Error) => e
      );
      expect(failure?.name).toBe('IdentityExportNetworkError');
      expect(failure?.message).toBe(
        "DNS lookup failed, retry: EAI_AGAIN -3001 (A network call, while running the export). The host it looked up is in the function's log."
      );
      const upload = setup();
      const send = upload.send.getMockImplementation()!;
      upload.send.mockImplementation(async (command: any) => {
        if (command instanceof PutObjectCommand) {
          throw Object.assign(
            new Error('write ECONNRESET s3.example.invalid'),
            { code: 'ECONNRESET', syscall: 'write' }
          );
        }
        return send(command);
      });
      const reset = await run(upload.deps).then(
        () => null,
        (e: Error) => e
      );
      expect(reset?.message).toBe(
        "A network call failed while running the export: ECONNRESET. Its message, which can name the host or user, is in the function's log."
      );
      expect(
        error.mock.calls.map(([line]) => String(line)).join('\n')
      ).toContain('[NETWORK CALL FAILED] [running the export]');
      // Not a network error: kept as it is.
      const plain = setup({ failPutOf: 'summary.json' });
      await expect(run(plain.deps)).rejects.toThrow('upload failed');
    } finally {
      error.mockRestore();
    }
  });

  it('reports a DNS failure in the bucket check by its code, never the host', async () => {
    const error = jest.spyOn(Logger.prototype, 'error');
    try {
      mockBuild.mockResolvedValue(document());
      const { deps, order } = setup({
        privacyFailsWith: Object.assign(
          new Error('getaddrinfo EAI_AGAIN bucket.s3.example.invalid'),
          {
            code: 'EAI_AGAIN',
            errno: -3001,
            syscall: 'getaddrinfo',
            hostname: 'bucket.s3.example.invalid'
          }
        )
      });
      const failure = await run(deps).then(
        () => null,
        (e: Error) => e
      );
      expect(failure?.name).toBe('IdentityExportNetworkError');
      expect(failure?.message).toBe(
        "DNS lookup failed, retry: EAI_AGAIN -3001 (A network call, while running the export). The host it looked up is in the function's log."
      );
      expect(order).toEqual([]);
      // The links job's check too.
      const links = await runIdentityExportJob(
        parseIdentityExportEvent({
          job: 'identityExportLinks',
          freezeAt: '2026-11-24T00:00:00Z'
        })!,
        context,
        deps
      ).then(
        () => null,
        (e: Error) => e
      );
      expect(links?.message).toMatch(
        /^DNS lookup failed, retry: EAI_AGAIN -3001 \(A network call, while renewing the links\)/
      );
      expect(links?.message).not.toContain('example.invalid');
    } finally {
      error.mockRestore();
    }
  });

  it('gives an S3 refusal in the bucket check by its name and status, not its message', async () => {
    mockBuild.mockResolvedValue(document());
    const { deps, order } = setup({
      privacyFailsWith: Object.assign(
        new Error('User is not authorized to perform this action'),
        { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }
      )
    });
    const failure = await run(deps).then(
      () => null,
      (e: Error) => e
    );
    expect(failure?.message).toBe(
      `Can't read the public access block of ${BUCKET} as its owner's: AccessDenied (403)`
    );
    expect(order).toEqual([]);
  });

  it('gives an AWS refusal by its name and status, never its message', async () => {
    const error = jest.spyOn(Logger.prototype, 'error');
    try {
      mockBuild.mockResolvedValue(document());
      const upload = setup({
        failPutOf: 'summary.json',
        failPutWith: Object.assign(
          new Error('Access Denied on bucket.s3.example.invalid'),
          { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }
        )
      });
      const refused = await run(upload.deps).then(
        () => null,
        (e: Error) => e
      );
      expect(refused).toBeInstanceOf(IdentityExportServiceError);
      expect(refused?.message).toBe(
        "An AWS call was refused while running the export: AccessDenied (403). Its message is in the function's log."
      );
      // The secret's read too.
      const secret = setup();
      (secret.deps.identityFreezeAt as jest.Mock).mockRejectedValue(
        Object.assign(
          new Error('User is not authorized to perform: GetSecretValue'),
          {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 400 }
          }
        )
      );
      const unread = await run(secret.deps).then(
        () => null,
        (e: Error) => e
      );
      expect(unread?.message).toBe(
        "An AWS call was refused while running the export: AccessDeniedException (400). Its message is in the function's log."
      );
      expect(
        error.mock.calls.map(([line]) => String(line)).join('\n')
      ).toContain('[AWS CALL REFUSED] [running the export] Access Denied');
    } finally {
      error.mockRestore();
    }
  });

  it('counts a TLS failure, and an error naming its host, as network errors', async () => {
    mockBuild.mockResolvedValue(document());
    for (const [failure, code] of [
      [
        Object.assign(
          new Error(
            "Hostname/IP does not match certificate's altnames: Host: bucket.s3.example.invalid"
          ),
          { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
        ),
        'ERR_TLS_CERT_ALTNAME_INVALID'
      ],
      [
        Object.assign(
          new Error('connection to bucket.s3.example.invalid lost'),
          {
            name: 'Error',
            host: 'bucket.s3.example.invalid'
          }
        ),
        'Error'
      ]
    ] as const) {
      const { deps } = setup({
        failPutOf: 'summary.json',
        failPutWith: failure
      });
      const error = await run(deps).then(
        () => null,
        (e: Error) => e
      );
      expect(error?.name).toBe('IdentityExportNetworkError');
      expect(error?.message).toBe(
        `A network call failed while running the export: ${code}. Its message, which can name the host or user, is in the function's log.`
      );
    }
  });

  it("leaves a programming error's ERR_ code alone: it is no network call", async () => {
    mockBuild.mockResolvedValue(document());
    const bug = Object.assign(
      new TypeError('The "chunk" argument must be of type string'),
      { code: 'ERR_INVALID_ARG_TYPE' }
    );
    const { deps } = setup({ failPutOf: 'summary.json', failPutWith: bug });
    await expect(run(deps)).rejects.toBe(bug);
  });

  it("keeps the reader's hostname out of the response, the manifest, the pointer and the files", async () => {
    mockBuild.mockResolvedValue(document());
    const { deps, bodies, order } = setup();
    const result = await run(deps);
    expect(result.endpoint).toBe('reader');
    const written = [
      JSON.stringify(result),
      ...order.map((key) => bodies.get(key)!)
    ];
    expect(order).toEqual(
      expect.arrayContaining([result.manifestKey, POINTER])
    );
    for (const text of written) {
      expect(text).not.toContain('replica-host');
      expect(text).not.toContain('primary-host');
    }
    expect(JSON.parse(bodies.get(result.manifestKey)!).read.endpoint).toBe(
      'reader'
    );
  });

  it('logs the manifest sha256 and the pointer in its [EXPORT DONE] line', async () => {
    mockBuild.mockResolvedValue(document());
    const info = jest.spyOn(Logger.prototype, 'info');
    try {
      const done = () =>
        info.mock.calls
          .map(([line]) => String(line))
          .filter((line) => line.startsWith('[EXPORT DONE]'));
      const written = setup();
      const result = await run(written.deps);
      expect(done().pop()).toContain(
        `[${result.prefix}] [manifest.json] [MANIFEST SHA256 ${result.manifestSha256}] [POINTER ${POINTER}]`
      );
      const failed = setup({ failPutOf: '2026-11-24T00-00-00-000Z.json' });
      await run(failed.deps);
      expect(done().pop()).toContain('[POINTER NOT WRITTEN]');
      mockBuild.mockResolvedValue(document({ freeze_ms: null }));
      await run(setup().deps, rehearsal);
      expect(done().pop()).toContain('[POINTER NONE (A REHEARSAL)]');
    } finally {
      info.mockRestore();
    }
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
