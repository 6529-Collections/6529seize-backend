import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  activeEntries,
  eligibleGroupsForWave,
  forEachLimited,
  namedGroups,
  WAVES_EXPORT_STAGES,
  WavesExport
} from './waves-export.service';
import {
  ExportActiveEntry,
  ExportWaveRow,
  Json,
  WavesExportSource
} from './waves-export.types';
import type { ReplicaLagRecord } from './waves-export.replica-lag';
import { RawDirectory } from './waves-export.writer';

const T_W = Date.UTC(2026, 10, 25, 0, 0, 0);

const EXPORT_LAG: ReplicaLagRecord = {
  checked_by: 'export',
  read_at: '2026-11-25T00:06:00.000Z',
  server_read_only: true,
  readers: 2,
  worst_lag_ms: 40,
  worst_lag_age_ms: 5,
  stale_readers: 0,
  unknown_reason: null
};

const PERSON_LAG: ReplicaLagRecord = {
  checked_by: 'person',
  person: 'the operator',
  note: 'AuroraReplicaLagMaximum read at 00:06 UTC: 20 ms',
  read_at: '2026-11-25T00:06:00.000Z',
  server_read_only: true,
  readers: 0,
  worst_lag_ms: null,
  worst_lag_age_ms: null,
  stale_readers: null,
  unknown_reason:
    'information_schema.replica_host_status has no row for any reader'
};

function wave(
  id: string,
  parent: string | null,
  groups: Partial<ExportWaveRow> = {}
): ExportWaveRow {
  return {
    id,
    parent_wave_id: parent,
    visibility_group_id: null,
    admin_group_id: null,
    chat_group_id: null,
    participation_group_id: null,
    voting_group_id: null,
    ...groups
  };
}

function configuration(
  id: string,
  read: string | null,
  post: string | null,
  admin: string | null
): Json {
  return {
    id,
    name: `Wave ${id}`,
    picture: null,
    serial_no: 1,
    created_at: 1_000,
    author: { id: 'p-creator' },
    is_dm_wave: false,
    visibility: { scope: { group: read ? { id: read } : null } },
    chat: {
      enabled: true,
      scope: { group: post ? { id: post } : null },
      links_disabled: false,
      replies: { open: true, collapsed: false }
    },
    wave: {
      admin_group: { group: admin ? { id: admin } : null },
      admin_drop_deletion_enabled: false
    },
    description_drop: { parts: [{ content: 'About', media: [] }] }
  };
}

function drop(
  id: string,
  serial: number,
  signed: boolean,
  extra: Json = {}
): Json {
  return {
    id,
    serial_no: serial,
    author: { id: 'p-author', handle: 'author' },
    created_at: T_W - serial,
    updated_at: null,
    drop_type: 'CHAT',
    title: null,
    parts: [{ part_id: 1, content: `drop ${serial}`, media: [] }],
    is_author_signed: signed,
    is_signed: signed,
    moderation: { status: 'VISIBLE', can_view: true },
    reactions: [],
    ...extra
  };
}

class FakeSource implements WavesExportSource {
  readonly configurationCalls: [string, string[]][] = [];
  readonly signedBatches: number[] = [];

  async listWaves() {
    return [
      wave('w-pub', null, { admin_group_id: 'g-admin' }),
      wave('w-sub', 'w-pub', { chat_group_id: 'g-post' }),
      wave('w-members', null, {
        visibility_group_id: 'g-read',
        admin_group_id: 'g-admin'
      }),
      wave('w-broken', null)
    ];
  }

  async waveConfiguration(row: ExportWaveRow, eligible: string[]) {
    this.configurationCalls.push([row.id, eligible]);
    if (row.id === 'w-broken') throw new Error('Wave w-broken not found');
    return configuration(
      row.id,
      row.visibility_group_id,
      row.chat_group_id,
      row.admin_group_id
    );
  }

  async listCompetitionIds(waveIds: string[]) {
    expect(waveIds).not.toContain('w-broken');
    return ['c-1', 'c-2', 'c-elsewhere'];
  }

  async competition(id: string) {
    const competitions: Record<string, Json> = {
      'c-1': {
        id: 'c-1',
        wave_id: 'w-pub',
        lifecycle: 'PUBLISHED',
        participation: { group_id: 'g-submit' },
        voting: { group_id: 'g-vote' }
      },
      'c-2': {
        id: 'c-2',
        wave_id: 'w-members',
        lifecycle: 'DRAFT',
        participation: { group_id: null },
        voting: { group_id: 'g-missing' }
      },
      'c-elsewhere': {
        id: 'c-elsewhere',
        wave_id: 'w-dm',
        lifecycle: 'PUBLISHED'
      }
    };
    const entries: Record<string, Json[]> = {
      'c-1': [
        {
          id: 'e-1',
          drop_id: 'd-1',
          status: 'ACTIVE',
          submitter: { id: 'p1' }
        },
        {
          id: 'e-2',
          drop_id: 'd-2',
          status: 'WINNER',
          submitter: { id: 'p2' }
        },
        {
          id: 'e-3',
          drop_id: 'd-3',
          status: 'WITHDRAWN',
          submitter: { id: 'p3' }
        }
      ],
      'c-2': [
        { id: 'e-4', drop_id: 'd-4', status: 'ACTIVE', submitter: { id: 'p4' } }
      ]
    };
    return {
      competition: competitions[id],
      details: {
        entries: entries[id] ?? [],
        decisions: [],
        outcomes: [],
        pauses: [],
        versions: [],
        voters: []
      }
    };
  }

  async entryVotes(entry: ExportActiveEntry) {
    return [
      { voter_profile_id: 'p9', value: 5, updated_at: 7, entry: entry.entry_id }
    ];
  }

  async entryVoteLog(entry: ExportActiveEntry) {
    return [
      { id: `${entry.entry_id}-2`, old_vote: 2, new_vote: 5, created_at: 20 },
      { id: `${entry.entry_id}-1`, old_vote: 0, new_vote: 2, created_at: 10 }
    ];
  }

  async groups(ids: string[]) {
    const out: Record<string, Json> = {};
    for (const id of ids) {
      if (id === 'g-missing') continue;
      out[id] = {
        id,
        name: id,
        visible: true,
        created_at: 1,
        created_by: { id: 'p-creator' },
        group:
          id === 'g-vote'
            ? {
                tdh: { min: 1, max: null, inclusion_strategy: 'BOTH' },
                rep: { user_identity: 'rater-handle', category: 'Art' },
                cic: {},
                level: {},
                owns_nfts: [],
                identity_group_id: 'ig-vote',
                excluded_identity_group_id: 'ig-vote-out'
              }
            : { tdh: {}, rep: {}, cic: {}, level: {}, owns_nfts: [] }
      };
    }
    return out;
  }

  async identityGroupWallets(identityGroupId: string) {
    return identityGroupId === 'ig-vote'
      ? [
          '0xBB00000000000000000000000000000000000002',
          '0xaa00000000000000000000000000000000000001'
        ]
      : ['0xCC00000000000000000000000000000000000003'];
  }

  async groupMembers(group: Json) {
    expect(group.id).toBe('g-vote');
    return [
      { wallet: '0xDD00000000000000000000000000000000000004', key: 'member' }
    ];
  }

  async profileIdOf(key: string) {
    return key === 'rater-handle' ? 'p-rater' : null;
  }

  async waveRep(waveIds: string[]) {
    expect(waveIds).toEqual(['w-members', 'w-pub', 'w-sub']);
    return {
      'w-pub': [
        { category: 'Good', profile_id: 'p1', rating: 3, last_modified: 1 },
        { category: 'Art', profile_id: 'p2', rating: -1, last_modified: 2 }
      ]
    };
  }

  async wavePolls(waveId: string, state: 'OPEN' | 'CLOSED', now: number) {
    expect(now).toBe(T_W);
    return waveId === 'w-pub' && state === 'CLOSED'
      ? [{ id: 'd-poll', content: 'Which?', poll: { id: 'poll-1' } }]
      : [];
  }

  async *wavePagesOfDrops(waveId: string, pageSize: number) {
    expect(pageSize).toBe(2);
    if (waveId !== 'w-pub') return;
    yield [drop('d-9', 9, true), drop('d-8', 8, false)];
    yield [
      drop('d-7', 7, true, { reply_to: { drop_id: 'd-8', drop_part_id: 1 } })
    ];
  }

  async signedEvents(drops: Json[]) {
    this.signedBatches.push(drops.length);
    return drops.map((d) => ({
      drop_id: String(d.id),
      current_event_id: `ev-${d.id}`,
      events: [{ id: `ev-${d.id}`, auth_ref: 'g-1' }],
      grants: [{ id: 'g-1', wallet: '0x01' }]
    }));
  }
}

function readLines(file: string): string[] {
  return gunzipSync(fs.readFileSync(file))
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
}

describe('WavesExport', () => {
  let out: string;
  let source: FakeSource;
  let messages: string[];

  beforeAll(async () => {
    out =
      process.env.WAVES_EXPORT_TEST_OUT ??
      fs.mkdtempSync(path.join(os.tmpdir(), 'waves-export-'));
    source = new FakeSource();
    messages = [];
    await new WavesExport(source, {
      raw: new RawDirectory(path.join(out, 'raw')),
      stages: [...WAVES_EXPORT_STAGES],
      freezeMs: T_W,
      exporterRevision: 'a'.repeat(40),
      waveIds: null,
      dropPageSize: 2,
      concurrency: 2,
      bothMetric: false,
      replicaLag: EXPORT_LAG,
      now: () => T_W + 1,
      log: (message) => messages.push(message)
    }).run();
  });

  afterAll(() => {
    if (!process.env.WAVES_EXPORT_TEST_OUT) {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  const raw = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(out, 'raw', name), 'utf8'));

  it('writes every wave read, its configuration and its parent', () => {
    const waves = raw('waves_v3.json');
    expect(Object.keys(waves)).toEqual([
      'w-broken',
      'w-members',
      'w-pub',
      'w-sub'
    ]);
    expect(waves['w-broken']._error).toContain('not found');
    expect(waves['w-members'].configuration.visibility.scope.group.id).toBe(
      'g-read'
    );
    expect(raw('subwave_parents.json')).toEqual({ 'w-sub': 'w-pub' });
    expect(raw('waves_all.json')).toEqual([
      { id: 'w-broken' },
      { id: 'w-members' },
      { id: 'w-pub' }
    ]);
    // A subwave's read shows its parent's read group too.
    expect(Object.fromEntries(source.configurationCalls)['w-members']).toEqual([
      'g-admin',
      'g-read'
    ]);
  });

  it('writes the decisions of exported waves only', () => {
    expect(Object.keys(raw('competitions.json'))).toEqual(['c-1', 'c-2']);
    expect(raw('competition_details.json')['c-1'].entries).toHaveLength(3);
  });

  it('writes votes and vote logs of ACTIVE entries of PUBLISHED decisions', () => {
    expect(Object.keys(raw('entry_votes.json'))).toEqual(['e-1']);
    expect(raw('entry_logs.json')).toEqual({
      'd-1': [
        { id: 'e-1-2', old_vote: 2, new_vote: 5, created_at: 20 },
        { id: 'e-1-1', old_vote: 0, new_vote: 2, created_at: 10 }
      ]
    });
  });

  it('writes the named groups, their lists, raters and static members', () => {
    const groups = raw('groups.json');
    expect(Object.keys(groups)).toEqual([
      'g-admin',
      'g-missing',
      'g-post',
      'g-read',
      'g-submit',
      'g-vote'
    ]);
    expect(groups['g-missing']).toEqual({ _error: 404 });
    expect(raw('group_lists.json')).toEqual({
      'g-vote': {
        include: [
          '0xaa00000000000000000000000000000000000001',
          '0xbb00000000000000000000000000000000000002'
        ],
        exclude: ['0xcc00000000000000000000000000000000000003']
      }
    });
    expect(raw('group_users.json')).toEqual({ 'rater-handle': 'p-rater' });
    // TDH plus xTDH is not a clause yet: that group is its members.
    expect(raw('group_members.json')).toEqual({
      'g-vote': [
        { wallet: '0xdd00000000000000000000000000000000000004', key: 'member' }
      ]
    });
  });

  it('writes wave REP and polls', () => {
    expect(raw('wave_rep.json')).toEqual({
      categories: { 'w-pub': [{ category: 'Art' }, { category: 'Good' }] },
      ratings: {
        'w-pub': [
          { category: 'Good', profile_id: 'p1', rating: 3, last_modified: 1 },
          { category: 'Art', profile_id: 'p2', rating: -1, last_modified: 2 }
        ]
      }
    });
    expect(raw('polls.json')).toEqual({
      'w-pub': {
        CLOSED: [{ id: 'd-poll', content: 'Which?', poll: { id: 'poll-1' } }]
      }
    });
  });

  it('writes drops as the snapshot tooling reads them, replies included', () => {
    const lines = readLines(path.join(out, 'raw', 'drops', 'w-pub.jsonl.gz'));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.startsWith('{"id": "d-')).toBe(true);
      expect(line).toMatch(/"serial_no": \d+, /);
    }
    const rows = lines.map((line) => JSON.parse(line));
    expect(rows.map((row) => row.serial_no)).toEqual([9, 8, 7]);
    expect(rows[0].wave_id).toBe('w-pub');
    expect(rows[2].reply_to).toEqual({ drop_id: 'd-8', part_id: 1 });
    expect(
      fs.existsSync(path.join(out, 'raw', 'drops', 'w-sub.jsonl.gz'))
    ).toBe(false);
  });

  it('writes signed events of author-signed drops, by drop id', () => {
    const lines = readLines(path.join(out, 'raw', 'signed', 'w-pub.jsonl.gz'));
    expect(lines.map((line) => JSON.parse(line).drop_id)).toEqual([
      'd-7',
      'd-9'
    ]);
    expect(source.signedBatches).toEqual([1, 1]);
  });

  it('records what it wrote', () => {
    const summary = raw('export.json');
    expect(summary).toMatchObject({
      format: '6529io-waves-export-raw-v1',
      freeze_ms: T_W,
      exporter_revision: 'a'.repeat(40),
      started_at: T_W + 1,
      finished_at: T_W + 1,
      counts: {
        decisions: 2,
        drops: 3,
        entries: 4,
        groups: 5,
        groups_as_members: 1,
        groups_missing: 1,
        polls: 1,
        signed_drops: 2,
        subwaves: 1,
        vote_log_rows: 2,
        vote_rows: 1,
        wave_rep_rows: 2,
        waves: 3,
        waves_failed: 1
      },
      both_metric: false,
      failed_waves: [
        { id: 'w-broken', error: 'Error: Wave w-broken not found' }
      ],
      runs: [
        {
          run_started_at: T_W + 1,
          stages: [...WAVES_EXPORT_STAGES],
          replica_lag: EXPORT_LAG
        }
      ]
    });
    expect(raw('export_runs.json')).toEqual(summary.runs);
    expect(messages.some((message) => message.startsWith('== drops'))).toBe(
      true
    );
  });

  it('keeps finished waves on --resume and tries a failed read again', async () => {
    let calls = 0;
    const flaky = new FakeSource();
    flaky.wavePagesOfDrops = async function* (waveId: string, size: number) {
      calls++;
      if (calls === 1) throw new Error('connection lost');
      yield* FakeSource.prototype.wavePagesOfDrops.call(this, waveId, size);
    };
    const run = (resumeDrops: boolean, source: FakeSource) =>
      new WavesExport(source, {
        raw: new RawDirectory(path.join(out, 'raw')),
        stages: ['drops'],
        freezeMs: T_W,
        exporterRevision: 'a'.repeat(40),
        waveIds: null,
        dropPageSize: 2,
        concurrency: 1,
        bothMetric: false,
        resumeDrops,
        retryDelayMs: 0,
        log: () => undefined
      }).run();
    const resumed = await run(true, new FakeSource());
    expect(resumed.counts).toMatchObject({ drops: 0, drop_waves_kept: 1 });
    // Every run is kept in order, each with its own lag record (none here).
    expect(
      raw('export.json').runs.map(
        (it: {
          stages: string[];
          replica_lag: { checked_by: string } | null;
        }) => [it.stages.join(','), it.replica_lag?.checked_by ?? null]
      )
    ).toEqual([
      [WAVES_EXPORT_STAGES.join(','), 'export'],
      ['drops', null]
    ]);
    // The waves stage's failures carry over from its waves file.
    expect(resumed.failed_waves.map((wave) => wave.id)).toEqual(['w-broken']);
    const again = await run(false, flaky);
    expect(again.counts).toMatchObject({ drops: 3, drop_waves_kept: 0 });
    expect(
      readLines(path.join(out, 'raw', 'drops', 'w-pub.jsonl.gz'))
    ).toHaveLength(3);
  });

  it('puts no partial file in place when a wave cannot be read', async () => {
    const broken = new FakeSource();
    broken.wavePagesOfDrops = async function* () {
      yield [drop('d-1', 1, false)];
      throw new Error('replica gone');
    };
    const target = path.join(out, 'raw', 'drops', 'w-pub.jsonl.gz');
    fs.rmSync(target, { force: true });
    await expect(
      new WavesExport(broken, {
        raw: new RawDirectory(path.join(out, 'raw')),
        stages: ['drops'],
        freezeMs: T_W,
        exporterRevision: 'a'.repeat(40),
        waveIds: null,
        dropPageSize: 2,
        concurrency: 1,
        bothMetric: false,
        retryDelayMs: 0,
        log: () => undefined
      }).run()
    ).rejects.toThrow('replica gone');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });

  it("keeps a stopped run's lag record, a person's check too, and its failed waves on --resume", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-export-stop-'));
    try {
      const file = (name: string) =>
        JSON.parse(fs.readFileSync(path.join(dir, 'raw', name), 'utf8'));
      const options = (
        stages: (typeof WAVES_EXPORT_STAGES)[number][],
        replicaLag: ReplicaLagRecord,
        startedAt: number
      ) => ({
        raw: new RawDirectory(path.join(dir, 'raw')),
        stages,
        freezeMs: T_W,
        exporterRevision: 'a'.repeat(40),
        waveIds: null,
        dropPageSize: 2,
        concurrency: 1,
        bothMetric: false,
        resumeDrops: true,
        retryDelayMs: 0,
        replicaLag,
        now: () => startedAt,
        log: () => undefined
      });
      // A run on a person's word stops in its drops stage.
      const stopping = new FakeSource();
      stopping.wavePagesOfDrops = async function* () {
        yield* [];
        throw new Error('connection lost');
      };
      await expect(
        new WavesExport(
          stopping,
          options([...WAVES_EXPORT_STAGES], PERSON_LAG, T_W + 1)
        ).run()
      ).rejects.toThrow('connection lost');
      expect(fs.existsSync(path.join(dir, 'raw', 'export.json'))).toBe(false);
      const first = {
        run_started_at: T_W + 1,
        stages: [...WAVES_EXPORT_STAGES],
        replica_lag: PERSON_LAG
      };
      expect(file('export_runs.json')).toEqual([first]);
      // The resumed run adds its own record and keeps the person's.
      const resumed = await new WavesExport(
        new FakeSource(),
        options(['drops'], EXPORT_LAG, T_W + 2)
      ).run();
      const runs = [
        first,
        { run_started_at: T_W + 2, stages: ['drops'], replica_lag: EXPORT_LAG }
      ];
      expect(file('export_runs.json')).toEqual(runs);
      expect(file('export.json')).toMatchObject({
        runs,
        failed_waves: [
          { id: 'w-broken', error: 'Error: Wave w-broken not found' }
        ]
      });
      expect(resumed.failed_waves).toEqual([
        { id: 'w-broken', error: 'Error: Wave w-broken not found' }
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('export helpers', () => {
  it('shows a wave its own groups and its parent read group', () => {
    const parent = wave('p', null, { visibility_group_id: 'g-parent' });
    const child = wave('c', 'p', {
      admin_group_id: 'g-a',
      chat_group_id: 'g-a',
      voting_group_id: 'g-v'
    });
    expect(eligibleGroupsForWave(child, new Map([['p', parent]]))).toEqual([
      'g-a',
      'g-parent',
      'g-v'
    ]);
  });

  it('names groups by role as the fetch stage does', () => {
    const uses = namedGroups(
      { w: { id: 'w', configuration: configuration('w', 'r', 'p', 'a') } },
      { c: { participation: { group_id: 's' }, voting: { group_id: 'r' } } }
    );
    expect(
      Object.fromEntries(
        Array.from(uses.entries()).map(([k, v]) => [k, Array.from(v).sort()])
      )
    ).toEqual({
      a: ['admin'],
      p: ['post'],
      r: ['read', 'vote'],
      s: ['submit']
    });
  });

  it('lists ACTIVE entries of PUBLISHED decisions only', () => {
    expect(
      activeEntries(
        {
          a: { wave_id: 'w', lifecycle: 'PUBLISHED' },
          b: { wave_id: 'w', lifecycle: 'ENDED' }
        },
        {
          a: {
            entries: [
              { id: 'e1', drop_id: 'd1', status: 'ACTIVE' },
              { id: 'e2', drop_id: 'd2', status: 'WINNER' }
            ]
          },
          b: { entries: [{ id: 'e3', drop_id: 'd3', status: 'ACTIVE' }] }
        }
      )
    ).toEqual([
      { competition_id: 'a', wave_id: 'w', entry_id: 'e1', drop_id: 'd1' }
    ]);
  });

  it('runs at most the given number of tasks at once', async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await forEachLimited([1, 2, 3, 4, 5], 2, async (item) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      done.push(item);
      running--;
    });
    expect(most).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
