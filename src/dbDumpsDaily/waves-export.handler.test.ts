import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  ListObjectsV2Command,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import {
  recordsWaveIdFor,
  refuseBeforeExportStart,
  WavesExportRunHooks
} from '@/waves-export/cli';
import { WavesExportCommand } from '@/waves-export/cli-options';
import { WavesExportUsageError } from '@/waves-export/waves-export.errors';
import type { ReplicaLagRecord } from '@/waves-export/waves-export.replica-lag';
import {
  WAVES_EXPORT_STAGES,
  WavesExport
} from '@/waves-export/waves-export.service';
import {
  ExportWaveRow,
  Json,
  WavesExportSource
} from '@/waves-export/waves-export.types';
import { RawDirectory } from '@/waves-export/waves-export.writer';
import { StayReason } from '@/waves-scope/waves-scope';
import {
  PRESIGNED_URL_SECONDS,
  PrivateBucketError
} from './chain-exports/private-export-bucket';
import {
  MAX_CUT_OFFS,
  parseWavesExportEvent,
  runWavesExportJob,
  WavesExportJobContext,
  WavesExportJobDeps,
  WavesExportJobDone,
  WavesExportJobEventError,
  WavesExportJobProgress,
  WavesExportJobResult,
  WavesExportJobStateError
} from './waves-export.handler';

// Made up: an account of zeros and a region that doesn't exist.
const OWNER = '000000000000';
const REGION = 'xx-test-1';
const BUCKET = `6529-chain-exports-${OWNER}-${REGION}`;
const FUNCTION_ID = ['arn', 'aws', 'lambda', REGION, OWNER, 'function', 'x'];
const T_W = Date.UTC(2026, 10, 26);
const BUILD = 'c'.repeat(40);
const PREFIX = 'waves-export/staging/freeze-2026-11-26T00-00-00-000Z/';
const WAVES = ['w-1', 'w-2', 'w-3', 'w-4', 'w-5', 'w-6', 'w-7', 'w-8'];
/** The signed records wave: it stays on 6529.io. */
const RECORDS_WAVE = 'w-records';
/** Files the stages before drops write, and the run's own. */
const STAGE_FILES = [
  'competition_details.json',
  'competitions.json',
  'curations.json',
  'entry_logs.json',
  'entry_votes.json',
  'export.json',
  'export_runs.json',
  'group_lists.json',
  'group_members.json',
  'group_users.json',
  'groups.json',
  'groups_staying.json',
  'polls.json',
  'subwave_parents.json',
  'wave_rep.json',
  'waves_all.json',
  'waves_staying.json',
  'waves_v3.json'
];

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface Clock {
  t: number;
}

const refused = (name: string, status: number) =>
  Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status }
  });

/** The private bucket, in memory. */
class FakeBucket {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly presigned: { key: string; seconds: number }[] = [];
  publicBlock = true;
  /** The function's process is gone: nothing more reaches the bucket. */
  dead = false;
  /** Kills the process when a put of this key is about to land. */
  dieOnPut: ((key: string) => boolean) | null = null;
  /** Every put is refused. */
  refusePuts = false;

  readonly send = jest.fn(async (command: any) => {
    if (this.dead) throw new Error('the invocation was cut off');
    // Every call names the bucket's expected owner: the function's account.
    if (command.input.ExpectedBucketOwner !== OWNER) {
      throw new Error(`no ExpectedBucketOwner on ${command.constructor.name}`);
    }
    if (command.input.Bucket !== BUCKET) throw new Error('another bucket');
    if (command instanceof GetPublicAccessBlockCommand) {
      return {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: this.publicBlock,
          RestrictPublicBuckets: true
        }
      };
    }
    if (command instanceof GetBucketPolicyStatusCommand) {
      return { PolicyStatus: { IsPublic: false } };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      const body = Buffer.from(command.input.Body as Buffer);
      if (
        command.input.ChecksumSHA256 !==
        createHash('sha256').update(body).digest('base64')
      ) {
        throw new Error(`bad checksum for ${key}`);
      }
      if (this.refusePuts) throw refused('AccessDenied', 403);
      if (this.dieOnPut?.(key)) {
        this.dead = true;
        throw new Error('the invocation was cut off');
      }
      if (command.input.IfNoneMatch === '*' && this.objects.has(key)) {
        throw refused('PreconditionFailed', 412);
      }
      this.objects.set(key, body);
      this.puts.push(key);
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const body = this.objects.get(command.input.Key!);
      if (!body)
        throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return {
        Body: {
          transformToString: async () => body.toString('utf8'),
          transformToByteArray: async () => new Uint8Array(body)
        }
      };
    }
    if (command instanceof ListObjectsV2Command) {
      // Two keys a page, so the job follows the pages.
      const keys = Array.from(this.objects.keys())
        .filter((key) => key.startsWith(command.input.Prefix!))
        .sort();
      const from = Number(command.input.ContinuationToken ?? 0);
      const page = keys.slice(from, from + 2);
      return {
        Contents: page.map((Key) => ({
          Key,
          Size: this.objects.get(Key)!.length
        })),
        IsTruncated: from + 2 < keys.length,
        NextContinuationToken: String(from + 2)
      };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  });

  json(key: string): any {
    return JSON.parse(this.objects.get(key)!.toString('utf8'));
  }

  state(): any {
    return this.json(`${PREFIX}job.json`);
  }

  lines(key: string): Json[] {
    return gunzipSync(this.objects.get(key)!)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function drop(id: string, serial: number, signed: boolean): Json {
  return {
    id,
    serial_no: serial,
    author: { id: 'p-author' },
    created_at: T_W - serial,
    drop_type: 'CHAT',
    parts: [{ part_id: 1, content: `drop ${serial}`, media: [] }],
    is_author_signed: signed
  };
}

/** Waves of two drops each, the newer signed; each wave's drops take time. */
class FakeWaves implements WavesExportSource {
  readonly dropsRead: string[] = [];
  /** Called as a wave's drops are read. */
  onDrops: ((waveId: string) => void) | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly ids: readonly string[] = WAVES,
    private readonly perWaveMs = 25_000
  ) {}

  async listWaves(scope: {
    readonly recordsWaveId: string;
  }): Promise<ExportWaveRow[]> {
    const row = (id: string): ExportWaveRow => ({
      id,
      stay_reasons:
        id === RECORDS_WAVE && scope.recordsWaveId === RECORDS_WAVE
          ? [StayReason.RECORDS_WAVE]
          : [],
      parent_wave_id: null,
      visibility_group_id: null,
      admin_group_id: null,
      chat_group_id: null,
      participation_group_id: null,
      voting_group_id: null
    });
    return [...this.ids, RECORDS_WAVE].map(row);
  }
  async waveCurations() {
    return [];
  }
  async waveConfiguration(row: ExportWaveRow): Promise<Json> {
    return { id: row.id, name: `Wave ${row.id}`, picture: null };
  }
  async listCompetitionIds() {
    return [];
  }
  async competition() {
    return null;
  }
  async entryVotes() {
    return [];
  }
  async entryVoteLog() {
    return [];
  }
  async groups() {
    return {};
  }
  async identityGroupWallets() {
    return [];
  }
  async groupMembers() {
    return [];
  }
  async profileIdOf() {
    return null;
  }
  async waveRep() {
    return {};
  }
  async wavePolls() {
    return [];
  }
  async *wavePagesOfDrops(waveId: string) {
    this.onDrops?.(waveId);
    this.dropsRead.push(waveId);
    this.clock.t += this.perWaveMs;
    yield [drop(`${waveId}-2`, 2, true), drop(`${waveId}-1`, 1, false)];
  }
  async signedEvents(drops: Json[]) {
    return drops.map((it) => ({
      drop_id: String(it.id),
      current_event_id: `ev-${it.id}`,
      events: [{ id: `ev-${it.id}` }],
      grants: []
    }));
  }
}

const EXPORT_LAG: ReplicaLagRecord = {
  checked_by: 'export',
  read_at: '2026-11-26T00:10:00.000Z',
  server_read_only: true,
  readers: 2,
  worst_lag_ms: 40,
  worst_lag_age_ms: 5,
  stale_readers: 0,
  unknown_reason: null
};

interface Call {
  readonly command: WavesExportCommand;
  readonly hooks: WavesExportRunHooks;
  /** The DB settings the export's DB layer saw. */
  readonly db: Record<string, string | undefined>;
}

interface Setup {
  readonly bucket: FakeBucket;
  readonly clock: Clock;
  readonly source: FakeWaves;
  readonly env: Record<string, string | undefined>;
  readonly calls: Call[];
  readonly tmp: string;
  readonly deps: WavesExportJobDeps;
  readonly context: WavesExportJobContext;
  readonly invoke: (
    event: Record<string, unknown>
  ) => Promise<WavesExportJobResult>;
}

function setup(
  options: {
    bucket?: FakeBucket;
    clock?: Clock;
    source?: FakeWaves;
    env?: Record<string, string | undefined>;
    buildCommit?: string | null;
    remainingMs?: number;
    /** What the export throws when asked to run, instead of running. */
    exportThrows?: Error;
  } = {}
): Setup {
  const bucket = options.bucket ?? new FakeBucket();
  const clock = options.clock ?? { t: T_W + 10 * 60_000 };
  const source = options.source ?? new FakeWaves(clock);
  const env: Record<string, string | undefined> = {
    AWS_REGION: REGION,
    NODE_ENV: 'development',
    DB_HOST: 'the-writer',
    DB_USER: 'writer-user',
    DB_PASS: 'writer-pass',
    DB_HOST_READ: 'the-reader',
    DB_USER_READ: 'reader-user',
    DB_PASS_READ: 'reader-pass',
    SIGNED_RECORDS_WAVE_ID: RECORDS_WAVE,
    ...options.env
  };
  const calls: Call[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-export-job-'));
  // The command line's runExport, its DB context and replica check left
  // out: the same export, time check and options, on a made-up source.
  const runExport = jest.fn(
    async (command: WavesExportCommand, hooks: WavesExportRunHooks) => {
      calls.push({
        command,
        hooks,
        db: {
          DB_HOST: env.DB_HOST,
          DB_USER: env.DB_USER,
          DB_PASS: env.DB_PASS,
          DB_IAM_HOST: env.DB_IAM_HOST,
          DB_IAM_USER: env.DB_IAM_USER
        }
      });
      if (options.exportThrows) throw options.exportThrows;
      refuseBeforeExportStart(command.freezeMs, clock.t);
      return new WavesExport(source, {
        raw: new RawDirectory(path.join(command.out, 'raw')),
        stages: command.stages,
        freezeMs: command.freezeMs,
        exporterRevision: command.revision,
        waveIds: command.waveIds,
        dropPageSize: command.pageSize,
        concurrency: command.concurrency,
        bothMetric: command.bothMetric,
        recordsWaveId: recordsWaveIdFor(command.recordsWaveId, env),
        resumeDrops: command.resume,
        stopBeforeWave: hooks.stopBeforeWave,
        replicaLag: command.replicaLagCheckedBy
          ? {
              ...EXPORT_LAG,
              checked_by: 'person',
              person: command.replicaLagCheckedBy.person,
              note: command.replicaLagCheckedBy.note
            }
          : EXPORT_LAG,
        retryDelayMs: 0,
        now: () => clock.t,
        log: () => undefined
      }).run();
    }
  );
  const deps: WavesExportJobDeps = {
    prepareEnvironment: jest.fn(async () => undefined),
    env: () => env,
    s3: { send: bucket.send } as never,
    presign: async (target, key, seconds) => {
      bucket.presigned.push({ key, seconds });
      return `presigned:${target.name}/${key}?expires=${seconds}`;
    },
    now: () => clock.t,
    tmpDir: () => tmp,
    buildCommit: () =>
      options.buildCommit === undefined ? BUILD : options.buildCommit,
    runExport,
    flushEveryMs: 1_000_000
  };
  const context: WavesExportJobContext = {
    invokedFunctionArn: FUNCTION_ID.join(':'),
    awsRequestId: 'request-1',
    getRemainingTimeInMillis: () => options.remainingMs ?? 900_000
  };
  const invoke = (event: Record<string, unknown>) =>
    runWavesExportJob(
      parseWavesExportEvent({ job: 'wavesExport', ...event })!,
      context,
      deps
    );
  return { bucket, clock, source, env, calls, tmp, deps, context, invoke };
}

/** A real run at the freeze, one wave at a time, a minute of work each. */
const AT_FREEZE = {
  freezeAt: '2026-11-26T00:00:00Z',
  concurrency: 1,
  workSeconds: 60
};

function expectWholeExport(bucket: FakeBucket, waves: readonly string[]) {
  const manifest = bucket.json(`${PREFIX}manifest.json`);
  const names = manifest.files.map((file: { name: string }) => file.name);
  expect(names).toEqual(
    [
      ...STAGE_FILES.map((name) => `raw/${name}`),
      ...waves.map((id) => `raw/drops/${id}.jsonl.gz`),
      ...waves.map((id) => `raw/signed/${id}.jsonl.gz`)
    ].sort()
  );
  // Every file is in the bucket as the manifest says, whole.
  for (const file of manifest.files) {
    const body = bucket.objects.get(`${PREFIX}${file.name}`)!;
    expect({ name: file.name, bytes: body.length, sha256: sha(body) }).toEqual(
      file
    );
  }
  for (const id of waves) {
    expect(
      bucket.lines(`${PREFIX}raw/drops/${id}.jsonl.gz`).map((row) => row.id)
    ).toEqual([`${id}-2`, `${id}-1`]);
    expect(
      bucket
        .lines(`${PREFIX}raw/signed/${id}.jsonl.gz`)
        .map((row) => row.drop_id)
    ).toEqual([`${id}-2`]);
  }
  return manifest;
}

describe('the waves export job event', () => {
  const parse = (event: Record<string, unknown>) =>
    parseWavesExportEvent({ job: 'wavesExport', ...event });

  it('reads a run at the freeze and a rehearsal', () => {
    expect(parse({ freezeAt: '2026-11-26T00:00:00Z' })).toEqual({
      job: 'wavesExport',
      freezeMs: T_W,
      run: null,
      revision: null,
      waveIds: null,
      replicaLagCheckedBy: null,
      workSeconds: 720,
      concurrency: null,
      pageSize: null,
      bothMetric: false,
      allowFailedWaves: false,
      recordsWaveId: null
    });
    expect(
      parse({ freezeAt: '2026-11-26T00:00:00Z', recordsWaveId: 'w-records' })
    ).toMatchObject({ recordsWaveId: 'w-records' });
    expect(
      parse({
        rehearsal: true,
        run: 'r1',
        waves: ['w-2', 'w-1', 'w-2'],
        revision: 'A'.repeat(40)
      })
    ).toMatchObject({
      freezeMs: null,
      run: 'r1',
      waveIds: ['w-1', 'w-2'],
      revision: 'a'.repeat(40)
    });
    expect(parse({ freezeAt: T_W })).toMatchObject({ freezeMs: T_W });
    expect(parseWavesExportEvent({ job: 'identityExport' })).toBeNull();
  });

  it.each([
    [{}, /freezeAt, or rehearsal/],
    [{ freezeAt: '2026-11-26T00:00:00Z', rehearsal: true }, /one of the two/],
    [{ rehearsal: true }, /A rehearsal needs run/],
    [{ freezeAt: '2026-11-26' }, /ISO 8601 UTC/],
    [{ freezeAt: '2026-11-26T00:00:00Z', out: '/x' }, /Unknown fields: out/],
    [{ freezeAt: '2026-11-26T00:00:00Z', run: 'R 1' }, /run must be/],
    [{ freezeAt: '2026-11-26T00:00:00Z', revision: 'abc' }, /40-hex/],
    [{ freezeAt: '2026-11-26T00:00:00Z', waves: [] }, /lists no wave/],
    [{ freezeAt: '2026-11-26T00:00:00Z', waves: ['a/b'] }, /wave id/],
    [{ freezeAt: '2026-11-26T00:00:00Z', workSeconds: 900 }, /workSeconds/],
    [
      { freezeAt: '2026-11-26T00:00:00Z', recordsWaveId: '--waves x' },
      /recordsWaveId must be a wave id/
    ],
    [
      { freezeAt: '2026-11-26T00:00:00Z', replicaLagCheckedBy: 'someone' },
      /go together/
    ],
    [
      {
        freezeAt: '2026-11-26T00:00:00Z',
        replicaLagCheckedBy: 'someone',
        replicaLagCheckNote: '--stages drops'
      },
      /must not start with --/
    ],
    [
      {
        rehearsal: true,
        run: 'r1',
        replicaLagCheckedBy: 'someone',
        replicaLagCheckNote: 'read it'
      },
      /a rehearsal only reports the lag/
    ]
  ])('refuses %j', (event, message) => {
    expect(() => parse(event)).toThrow(WavesExportJobEventError);
    expect(() => parse(event)).toThrow(message);
  });
});

describe('the waves export job', () => {
  it('resumes across three invocations to done, each wave read once', async () => {
    const run = setup();
    const first = (await run.invoke(AT_FREEZE)) as WavesExportJobProgress;
    expect(first).toMatchObject({
      done: false,
      prefix: PREFIX,
      bucket: BUCKET,
      stage: 'staging',
      revision: BUILD,
      invocations: 1,
      stagesDone: WAVES_EXPORT_STAGES.filter((it) => it !== 'drops'),
      next: { stage: 'drops', wavesLeft: 5, waves: 8 }
    });
    // Each finished wave is in the bucket and listed as soon as it stops.
    expect(Object.keys(run.bucket.state().files)).toEqual(
      expect.arrayContaining([
        'drops/w-1.jsonl.gz',
        'signed/w-1.jsonl.gz',
        'drops/w-3.jsonl.gz'
      ])
    );
    const second = (await run.invoke(AT_FREEZE)) as WavesExportJobProgress;
    expect(second).toMatchObject({
      done: false,
      invocations: 2,
      next: { stage: 'drops', wavesLeft: 2, waves: 8 }
    });
    const third = (await run.invoke(AT_FREEZE)) as WavesExportJobDone;
    expect(third).toMatchObject({
      done: true,
      invocations: 3,
      stagesDone: [...WAVES_EXPORT_STAGES],
      files: STAGE_FILES.length + 16,
      failedWaves: [],
      failedWavesAccepted: true,
      manifestKey: `${PREFIX}manifest.json`,
      unlistedObjects: 0
    });
    expect(run.source.dropsRead).toEqual(WAVES);
    const manifest = expectWholeExport(run.bucket, WAVES);
    expect(manifest).toMatchObject({
      schema: '6529.waves-export.manifest.v1',
      freeze_at: new Date(T_W).toISOString(),
      rehearsal: false,
      exporter_revision: BUILD,
      stages: [...WAVES_EXPORT_STAGES],
      drop_files: 8,
      signed_files: 8
    });
    expect(third.manifestSha256).toBe(
      sha(run.bucket.objects.get(`${PREFIX}manifest.json`)!)
    );
    // One run of the export a stage, with --resume, three for the drops.
    expect(run.calls.map((call) => call.command.stages.join())).toEqual([
      ...WAVES_EXPORT_STAGES,
      'drops',
      'drops'
    ]);
    expect(run.calls.every((call) => call.command.resume)).toBe(true);
    // The run log in the bucket has every run, so one freeze per OUT holds.
    const runs = run.bucket.json(`${PREFIX}raw/export_runs.json`);
    expect(runs.map((it: { stages: string[] }) => it.stages.join())).toEqual(
      run.calls.map((call) => call.command.stages.join())
    );
    expect(new Set(runs.map((it: any) => it.freeze_ms))).toEqual(
      new Set([T_W])
    );
    expect(third.links.map((link) => link.name)).toEqual([
      'manifest.json',
      expect.stringMatching(/^links-2026-11-26T.*\.json$/),
      'raw/export.json',
      'raw/export_runs.json'
    ]);
    const links = run.bucket.json(third.linksKey);
    expect(Object.keys(links.files).sort()).toEqual(
      manifest.files.map((file: { name: string }) => file.name)
    );
  });

  it('stops at its deadline, with every file of the waves it read whole and listed', async () => {
    const run = setup();
    const result = (await run.invoke({
      ...AT_FREEZE,
      workSeconds: 100
    })) as WavesExportJobProgress;
    // 100 s of work at 25 s a wave: four waves started before it was up.
    expect(result.next).toEqual({ stage: 'drops', wavesLeft: 4, waves: 8 });
    expect(run.source.dropsRead).toEqual(['w-1', 'w-2', 'w-3', 'w-4']);
    const state = run.bucket.state();
    expect(state.stages_done).not.toContain('drops');
    expect(state.in_flight).toBeNull();
    const listed = Object.keys(state.files).filter((name) =>
      name.startsWith('drops/')
    );
    expect(listed.sort()).toEqual([
      'drops/w-1.jsonl.gz',
      'drops/w-2.jsonl.gz',
      'drops/w-3.jsonl.gz',
      'drops/w-4.jsonl.gz'
    ]);
    for (const name of Object.keys(state.files)) {
      const body = run.bucket.objects.get(`${PREFIX}raw/${name}`)!;
      expect(sha(body)).toBe(state.files[name].sha256);
    }
    expect(run.bucket.lines(`${PREFIX}raw/drops/w-4.jsonl.gz`)).toHaveLength(2);
    // Nothing is left in /tmp after the invocation.
    expect(fs.readdirSync(path.join(run.tmp, 'waves-export-job'))).toEqual([]);
  });

  it('starts no stage once its time is up, and keeps time for the uploads', async () => {
    const run = setup({ remainingMs: 200_000 });
    // The waves stage takes 90 s; 200 s left less 120 s kept is 80 s.
    run.source.waveConfiguration = async (row: ExportWaveRow) => {
      run.clock.t += 90_000 / WAVES.length;
      return { id: row.id, name: row.id, picture: null };
    };
    const result = (await run.invoke({
      freezeAt: '2026-11-26T00:00:00Z'
    })) as WavesExportJobProgress;
    expect(result.next).toEqual({
      stage: 'decisions',
      wavesLeft: null,
      waves: null
    });
    expect(run.calls.map((call) => call.command.stages.join())).toEqual([
      'waves'
    ]);
    expect(run.bucket.state().stages_done).toEqual(['waves']);
  });

  it("refuses a bucket that doesn't block public access, before anything else", async () => {
    const run = setup();
    run.bucket.publicBlock = false;
    await expect(run.invoke(AT_FREEZE)).rejects.toThrow(PrivateBucketError);
    await expect(run.invoke(AT_FREEZE)).rejects.toThrow(
      'does not block all public access'
    );
    expect(run.bucket.puts).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it("refuses before five minutes after the freeze, on the export's own check", async () => {
    const run = setup({ clock: { t: T_W + 5 * 60_000 - 1 } });
    const refusal = run.invoke(AT_FREEZE);
    await expect(refusal).rejects.toThrow(WavesExportUsageError);
    await expect(refusal).rejects.toThrow(
      'The export starts from 2026-11-26T00:05:00.000Z'
    );
    expect(run.bucket.puts).toEqual([]);
    expect(run.calls).toEqual([]);
    run.clock.t += 1;
    await expect(run.invoke(AT_FREEZE)).resolves.toMatchObject({
      done: false
    });
  });

  it('runs a rehearsal at any time, under its own name', async () => {
    const run = setup({ clock: { t: T_W - 86_400_000 } });
    const result = await run.invoke({
      rehearsal: true,
      run: 'r1',
      waves: ['w-2'],
      workSeconds: 840
    });
    expect(result).toMatchObject({
      done: true,
      rehearsal: true,
      freezeAt: null,
      prefix: 'waves-export/staging/rehearsal-r1/'
    });
    expect(run.calls[0].command).toMatchObject({
      freezeMs: null,
      rehearsal: true,
      waveIds: ['w-2']
    });
    expect(run.source.dropsRead).toEqual(['w-2']);
  });

  it('keeps the records wave on 6529.io, from the event or the function settings', async () => {
    const fromEnv = setup();
    await fromEnv.invoke(AT_FREEZE);
    // Every stage's run keeps the export's DB scope for the next one.
    expect(fromEnv.calls.map((call) => call.hooks.keepDbScope)).toEqual(
      Array(fromEnv.calls.length).fill(true)
    );
    expect(fromEnv.calls.map((call) => call.command.recordsWaveId)).toEqual(
      Array(fromEnv.calls.length).fill(null)
    );
    const runs = fromEnv.bucket.json(`${PREFIX}raw/export_runs.json`);
    expect(runs[0].records_wave_id).toBe(RECORDS_WAVE);
    const exported = fromEnv.bucket.json(`${PREFIX}raw/waves_v3.json`);
    expect(Object.keys(exported)).not.toContain(RECORDS_WAVE);

    const fromEvent = setup({ env: { SIGNED_RECORDS_WAVE_ID: undefined } });
    await fromEvent.invoke({ ...AT_FREEZE, recordsWaveId: RECORDS_WAVE });
    expect(fromEvent.calls.map((call) => call.command.recordsWaveId)).toEqual(
      Array(fromEvent.calls.length).fill(RECORDS_WAVE)
    );

    // None, on purpose: the event passes it through, and no wave stays as
    // the records wave.
    const none = setup({ env: { SIGNED_RECORDS_WAVE_ID: undefined } });
    await none.invoke({ ...AT_FREEZE, recordsWaveId: 'none' });
    expect(none.calls.map((call) => call.command.recordsWaveId)).toEqual(
      Array(none.calls.length).fill('none')
    );
    expect(none.bucket.json(`${PREFIX}raw/export_runs.json`)[0]).toMatchObject({
      records_wave_id: null
    });
    expect(
      Object.keys(none.bucket.json(`${PREFIX}raw/waves_v3.json`))
    ).toContain(RECORDS_WAVE);

    // Neither: the export refuses, and the job says so.
    const neither = setup({ env: { SIGNED_RECORDS_WAVE_ID: undefined } });
    await expect(neither.invoke(AT_FREEZE)).rejects.toThrow(
      'The export needs the signed records wave'
    );
  });

  it('passes the person-only lag flags only from the invocation that gives them', async () => {
    const run = setup({
      env: {
        EXPORTER_REVISION: 'd'.repeat(40),
        WAVES_FREEZE_AT: '2026-01-01T00:00:00Z'
      }
    });
    const person = {
      replicaLagCheckedBy: 'the operator',
      replicaLagCheckNote: 'AuroraReplicaLagMaximum at 00:09 UTC: 20 ms'
    };
    await run.invoke({ ...AT_FREEZE, ...person });
    const given = run.calls.length;
    expect(run.calls.map((call) => call.command.replicaLagCheckedBy)).toEqual(
      Array(given).fill({
        person: 'the operator',
        note: 'AuroraReplicaLagMaximum at 00:09 UTC: 20 ms'
      })
    );
    // Never kept as the run's state, so never a default for a later one.
    const stateText = run.bucket.objects
      .get(`${PREFIX}job.json`)!
      .toString('utf8');
    expect(stateText).not.toContain('the operator');
    await run.invoke(AT_FREEZE);
    expect(run.calls.length).toBeGreaterThan(given);
    expect(
      run.calls.slice(given).map((call) => call.command.replicaLagCheckedBy)
    ).toEqual(Array(run.calls.length - given).fill(null));
    // Nothing comes from the environment's export settings either.
    expect(run.calls.map((call) => call.command.revision)).toEqual(
      Array(run.calls.length).fill(BUILD)
    );
    expect(run.calls.map((call) => call.command.freezeMs)).toEqual(
      Array(run.calls.length).fill(T_W)
    );
    // The export's run log records whose word each run went ahead on.
    const runs = run.bucket.json(`${PREFIX}raw/export_runs.json`);
    expect(runs[0].replica_lag).toMatchObject({
      checked_by: 'person',
      person: 'the operator'
    });
    expect(runs[runs.length - 1].replica_lag.checked_by).toBe('export');
  });

  it('signs every link for six hours at most', async () => {
    const run = setup();
    let result = await run.invoke({ ...AT_FREEZE, workSeconds: 840 });
    expect(result.done).toBe(true);
    const done = result as WavesExportJobDone;
    expect(PRESIGNED_URL_SECONDS).toBeLessThanOrEqual(6 * 60 * 60);
    expect(run.bucket.presigned.length).toBeGreaterThan(30);
    for (const { seconds } of run.bucket.presigned) {
      expect(seconds).toBeLessThanOrEqual(6 * 60 * 60);
    }
    expect(Date.parse(done.linksLastAtMost)).toBeLessThanOrEqual(
      run.clock.t + 6 * 60 * 60 * 1000
    );
    expect(
      run.bucket.json(done.linksKey).expires_in_seconds_at_most
    ).toBeLessThanOrEqual(6 * 60 * 60);
    for (const link of done.links) {
      expect(link.url).toMatch(/expires=(\d+)$/);
      expect(Number(/expires=(\d+)$/.exec(link.url)![1])).toBeLessThanOrEqual(
        6 * 60 * 60
      );
    }
    // A finished run invoked again: fresh links, nothing read or rewritten.
    const manifest = run.bucket.objects.get(`${PREFIX}manifest.json`);
    run.clock.t += 7 * 60 * 60 * 1000;
    const calls = run.calls.length;
    result = await run.invoke({ ...AT_FREEZE, workSeconds: 840 });
    const again = result as WavesExportJobDone;
    expect(again.done).toBe(true);
    expect(again.linksKey).not.toBe(done.linksKey);
    expect(Date.parse(again.linksLastAtMost)).toBe(
      run.clock.t + 6 * 60 * 60 * 1000
    );
    expect(run.calls.length).toBe(calls);
    expect(run.bucket.objects.get(`${PREFIX}manifest.json`)).toBe(manifest);
  });

  it('resumes cleanly after an invocation cut off between its uploads and its state', async () => {
    const bucket = new FakeBucket();
    const clock = { t: T_W + 10 * 60_000 };
    const first = setup({ bucket, clock });
    // The process ends just as it would list its first finished waves:
    // their files are in the bucket, job.json doesn't list them.
    bucket.dieOnPut = (key) =>
      key === `${PREFIX}job.json` &&
      Array.from(bucket.objects.keys()).some((it) => it.includes('/drops/'));
    await expect(first.invoke(AT_FREEZE)).rejects.toThrow(/cut off/);
    const cut = bucket.state();
    expect(cut.in_flight).toMatchObject({ stage: 'drops' });
    expect(Object.keys(cut.files).some((it) => it.startsWith('drops/'))).toBe(
      false
    );
    const orphans = Array.from(bucket.objects.keys()).filter((it) =>
      it.includes('/drops/')
    );
    expect(orphans.length).toBeGreaterThan(0);
    // The next invocation: a new process, its own /tmp.
    bucket.dead = false;
    bucket.dieOnPut = null;
    const second = setup({ bucket, clock });
    let result = await second.invoke(AT_FREEZE);
    expect(bucket.state().cut_offs).toBe(1);
    while (!result.done) result = await second.invoke(AT_FREEZE);
    // The waves whose files weren't listed were read again, once each, and
    // their files replaced: no wave is lost, none is in twice.
    expect(second.source.dropsRead).toEqual(WAVES);
    expect((result as WavesExportJobDone).unlistedObjects).toBe(0);
    expectWholeExport(bucket, WAVES);
    expect(
      Array.from(bucket.objects.keys()).filter((it) => it.includes('/drops/'))
    ).toHaveLength(8);
    // The run log it uploaded before it was cut off is newer than the one
    // job.json listed: the next invocation took it, so no run is missing.
    const runs = bucket.json(`${PREFIX}raw/export_runs.json`);
    expect(runs.map((it: { stages: string[] }) => it.stages.join())).toEqual([
      ...first.calls.map((call) => call.command.stages.join()),
      ...second.calls.map((call) => call.command.stages.join())
    ]);
    expect(first.calls[first.calls.length - 1].command.stages).toEqual([
      'drops'
    ]);
  });

  it('lists finished waves while the stage runs, so a cut-off loses only the waves after them', async () => {
    const bucket = new FakeBucket();
    const clock = { t: T_W + 10 * 60_000 };
    const first = setup({ bucket, clock });
    const deps = { ...first.deps, flushEveryMs: 2 };
    const listedAtStart: string[][] = [];
    first.source.onDrops = (waveId) => {
      const state = bucket.state();
      listedAtStart.push(
        Object.keys(state.files).filter((it) => it.startsWith('drops/'))
      );
      // The process is gone before w-6 is read.
      if (waveId === 'w-6') {
        bucket.dead = true;
        throw new Error('the invocation was cut off');
      }
    };
    // Each wave's read takes a little real time, so the flushes run.
    const pages = first.source.wavePagesOfDrops.bind(first.source);
    first.source.wavePagesOfDrops = async function* (waveId: string) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield* pages(waveId);
    };
    await expect(
      runWavesExportJob(
        parseWavesExportEvent({
          job: 'wavesExport',
          ...AT_FREEZE,
          workSeconds: 840
        })!,
        first.context,
        deps
      )
    ).rejects.toThrow(/cut off/);
    // Waves were listed before the stage ended.
    expect(listedAtStart[5].length).toBeGreaterThan(0);
    const listed = Object.keys(bucket.state().files)
      .filter((it) => it.startsWith('drops/'))
      .sort();
    expect(listed.length).toBeGreaterThan(0);
    bucket.dead = false;
    const second = setup({ bucket, clock });
    const result = await second.invoke({ ...AT_FREEZE, workSeconds: 840 });
    expect(result.done).toBe(true);
    // A cut-off that finished files is no cut-off in a row.
    expect(bucket.state().cut_offs).toBe(0);
    // Only the waves not listed were read again.
    const kept = listed.map((it) =>
      it.slice('drops/'.length, -'.jsonl.gz'.length)
    );
    expect(second.source.dropsRead).toEqual(
      WAVES.filter((id) => !kept.includes(id))
    );
    expectWholeExport(bucket, WAVES);
  });

  it('lets no wave start once a run failed, though its other reads go on', async () => {
    const run = setup();
    let releaseW2: () => void = () => undefined;
    const w2Held = new Promise<void>((resolve) => {
      releaseW2 = resolve;
    });
    const pages = run.source.wavePagesOfDrops.bind(run.source);
    run.source.wavePagesOfDrops = async function* (waveId: string) {
      if (waveId === 'w-1') {
        run.source.dropsRead.push(waveId);
        throw new Error('replica gone');
      }
      if (waveId === 'w-2') await w2Held;
      yield* pages(waveId);
    };
    await expect(
      run.invoke({ ...AT_FREEZE, concurrency: 2, workSeconds: 840 })
    ).rejects.toThrow('replica gone');
    // The read of w-2 was still going when the run failed on w-1: it ends
    // after the invocation did, and no other wave is read after it.
    releaseW2();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(run.source.dropsRead).toContain('w-2');
    expect(
      run.source.dropsRead.filter((id) => id !== 'w-1' && id !== 'w-2')
    ).toEqual([]);
  });

  it('refuses a stage the time limit cut off twice in a row with nothing finished', async () => {
    const bucket = new FakeBucket();
    const clock = { t: T_W + 10 * 60_000 };
    const cutOff = async () => {
      const run = setup({ bucket, clock });
      // The first wave's drops outlast the invocation.
      run.source.onDrops = () => {
        bucket.dead = true;
        throw new Error('the invocation was cut off');
      };
      await expect(run.invoke(AT_FREEZE)).rejects.toThrow();
      bucket.dead = false;
    };
    await cutOff();
    await cutOff();
    expect(bucket.state()).toMatchObject({
      in_flight: { stage: 'drops' },
      cut_offs: 1
    });
    const run = setup({ bucket, clock });
    const refusal = run.invoke(AT_FREEZE);
    await expect(refusal).rejects.toThrow(WavesExportJobStateError);
    await expect(refusal).rejects.toThrow(
      `cut off the drops stage in ${MAX_CUT_OFFS} invocations in a row`
    );
    expect(run.calls).toEqual([]);
  });

  it('points the DB layer at the read replica for the export only', async () => {
    const run = setup();
    await run.invoke(AT_FREEZE);
    expect(run.calls.length).toBeGreaterThan(0);
    for (const call of run.calls) {
      expect(call.db).toMatchObject({
        DB_HOST: 'the-reader',
        DB_USER: 'reader-user',
        DB_PASS: 'reader-pass'
      });
    }
    expect(run.env).toMatchObject({
      DB_HOST: 'the-writer',
      DB_USER: 'writer-user',
      DB_PASS: 'writer-pass'
    });
    const iam = setup({
      env: {
        DB_IAM_AUTH: 'true',
        DB_IAM_HOST: 'the-iam-writer',
        DB_IAM_USER: 'iam-writer',
        DB_IAM_HOST_READ: 'the-iam-reader',
        DB_IAM_USER_READ: 'iam-reader'
      }
    });
    await iam.invoke(AT_FREEZE);
    expect(iam.calls[0].db).toMatchObject({
      DB_IAM_HOST: 'the-iam-reader',
      DB_IAM_USER: 'iam-reader'
    });
    expect(iam.env.DB_IAM_HOST).toBe('the-iam-writer');
  });

  it.each([
    [{ DB_HOST_READ: undefined }, 'DB_HOST_READ is not set'],
    [{ DB_HOST_READ: 'The-Writer' }, 'DB_HOST_READ is the primary']
  ])('refuses without a read replica: %j', async (env, message) => {
    const run = setup({ env });
    await expect(run.invoke(AT_FREEZE)).rejects.toThrow(message);
    expect(run.calls).toEqual([]);
  });

  it('refuses inputs that differ from the run they would go on with', async () => {
    const run = setup();
    await run.invoke(AT_FREEZE);
    const before = run.bucket.objects.get(`${PREFIX}job.json`);
    await expect(run.invoke({ ...AT_FREEZE, waves: ['w-1'] })).rejects.toThrow(
      /started with other inputs \(waves null, now \["w-1"\]\)/
    );
    await expect(
      run.invoke({ ...AT_FREEZE, revision: 'e'.repeat(40) })
    ).rejects.toThrow(/not the commit this function was built from/);
    expect(run.bucket.objects.get(`${PREFIX}job.json`)).toBe(before);
    // Another name is another run.
    await expect(
      run.invoke({ ...AT_FREEZE, waves: ['w-1'], run: 'only-one' })
    ).resolves.toMatchObject({
      prefix: 'waves-export/staging/freeze-2026-11-26T00-00-00-000Z-only-one/'
    });
  });

  it('needs a revision when the build has none', async () => {
    const run = setup({ buildCommit: null });
    await expect(run.invoke(AT_FREEZE)).rejects.toThrow(/give revision/);
    await expect(
      run.invoke({ ...AT_FREEZE, revision: 'F'.repeat(40) })
    ).resolves.toMatchObject({ revision: 'f'.repeat(40) });
  });

  it("passes the export's refusal on as it is, keeping what was finished", async () => {
    const run = setup({
      exportThrows: new WavesExportUsageError(
        'The read replica may be up to 61.5 s behind',
        { showHelp: false }
      )
    });
    await expect(run.invoke(AT_FREEZE)).rejects.toThrow(
      'The read replica may be up to 61.5 s behind'
    );
    expect(run.bucket.state()).toMatchObject({
      in_flight: null,
      stages_done: []
    });
  });

  it("still reports the export's refusal when saving after it fails", async () => {
    const run = setup();
    const refusal = new WavesExportUsageError(
      'The read replica may be up to 61.5 s behind',
      { showHelp: false }
    );
    const deps: WavesExportJobDeps = {
      ...run.deps,
      runExport: async () => {
        run.bucket.refusePuts = true;
        throw refusal;
      }
    };
    await expect(
      runWavesExportJob(
        parseWavesExportEvent({ job: 'wavesExport', ...AT_FREEZE })!,
        run.context,
        deps
      )
    ).rejects.toBe(refusal);
  });

  it("reports the replica's errors by their code, never their message", async () => {
    const error = Object.assign(
      new Error("Access denied for user 'reader'@'the-reader'"),
      { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, fatal: true }
    );
    const run = setup({ exportThrows: error });
    const refusal = run.invoke(AT_FREEZE);
    await expect(refusal).rejects.toThrow(
      'The read replica failed while running the waves stage: ER_ACCESS_DENIED_ERROR'
    );
    await expect(refusal).rejects.not.toThrow('the-reader');
  });

  it("refuses to hand out links when a listed file isn't in the bucket", async () => {
    const run = setup();
    const done = await run.invoke({ ...AT_FREEZE, workSeconds: 840 });
    expect(done.done).toBe(true);
    run.bucket.objects.delete(`${PREFIX}raw/drops/w-3.jsonl.gz`);
    await expect(
      run.invoke({ ...AT_FREEZE, workSeconds: 840 })
    ).rejects.toThrow(
      /1 file job.json lists is missing from the bucket or has another size \(raw\/drops\/w-3.jsonl.gz\)/
    );
  });

  it('says when waves were left out, until they are accepted', async () => {
    const run = setup();
    run.source.waveConfiguration = async (row: ExportWaveRow) => {
      if (row.id === 'w-5') throw new Error('Wave w-5 not found');
      return { id: row.id, name: row.id, picture: null };
    };
    const done = (await run.invoke({
      ...AT_FREEZE,
      workSeconds: 840
    })) as WavesExportJobDone;
    expect(done.failedWaves).toEqual([
      { id: 'w-5', error: 'Error: Wave w-5 not found' }
    ]);
    expect(done.failedWavesAccepted).toBe(false);
    expect(run.source.dropsRead).not.toContain('w-5');
    const accepted = (await run.invoke({
      ...AT_FREEZE,
      workSeconds: 840,
      allowFailedWaves: true
    })) as WavesExportJobDone;
    expect(accepted.failedWavesAccepted).toBe(true);
  });
});
