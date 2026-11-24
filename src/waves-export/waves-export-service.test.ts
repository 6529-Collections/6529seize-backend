import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  activeEntries,
  eligibleGroupsForWave,
  exportedGroups,
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
import {
  WavesExportStoppedError,
  WavesExportUsageError
} from './waves-export.errors';
import type { ReplicaLagRecord } from './waves-export.replica-lag';
import { RawDirectory } from './waves-export.writer';
import { StayReason } from '@/waves-scope/waves-scope';

const T_W = Date.UTC(2026, 10, 25, 0, 0, 0);
/** The signed records wave: it stays on 6529.io. */
const RECORDS = 'w-records';

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
  groups: Partial<ExportWaveRow> = {},
  stayReasons: StayReason[] = []
): ExportWaveRow {
  return {
    id,
    stay_reasons: stayReasons,
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
  readonly competitionCalls: string[] = [];
  readonly dropCalls: string[] = [];
  readonly groupCalls: string[][] = [];
  readonly curationCalls: string[][] = [];

  /**
   * Two waves that move, one the backend can't read, and a public subwave
   * of a wave that moves; six that stay on 6529.io, one for each reason, one
   * with two, and a public subwave of a members-only wave (parent_stays).
   * The backend's reasons are the shared rule's.
   */
  async listWaves(scope: { readonly recordsWaveId: string }) {
    return [
      wave('w-pub', null, { admin_group_id: 'g-admin' }),
      wave('w-sub', 'w-pub', {
        chat_group_id: 'g-post',
        admin_group_id: 'g-missing'
      }),
      wave('w-broken', null),
      wave('w-under-members', 'w-members', {}, [StayReason.PARENT_STAYS]),
      wave(
        'w-members',
        null,
        { visibility_group_id: 'g-read', admin_group_id: 'g-admin' },
        [StayReason.MEMBERS_ONLY]
      ),
      wave('w-dm', null, {}, [StayReason.DIRECT_MESSAGE]),
      // An ordinary, public post group: it stays by its id alone.
      wave(
        RECORDS,
        null,
        { chat_group_id: 'g-records-post' },
        scope.recordsWaveId === RECORDS ? [StayReason.RECORDS_WAVE] : []
      ),
      // A public wave with a hidden admin group.
      wave('w-hidden-admin', null, { admin_group_id: 'g-hidden' }, [
        StayReason.HIDDEN_OR_PRIVATE_GROUP
      ]),
      wave('w-members-private', null, { visibility_group_id: 'g-private' }, [
        StayReason.MEMBERS_ONLY,
        StayReason.HIDDEN_OR_PRIVATE_GROUP
      ])
    ];
  }

  async waveCurations(waveIds: string[]) {
    this.curationCalls.push([...waveIds]);
    return [
      { id: 'cu-2', wave_id: 'w-pub', group_id: 'g-curators' },
      { id: 'cu-1', wave_id: 'w-sub', group_id: 'g-post' },
      { id: 'cu-3', wave_id: 'w-members', group_id: 'g-read' }
    ].filter((curation) => waveIds.includes(curation.wave_id));
  }

  async waveConfiguration(row: ExportWaveRow, eligible: string[]) {
    this.configurationCalls.push([row.id, eligible]);
    if (row.id === 'w-broken') throw new Error('Wave w-broken not found');
    const wave = configuration(
      row.id,
      row.visibility_group_id,
      row.chat_group_id,
      row.admin_group_id
    );
    // A wave's own submit and vote groups, as its configuration shows them.
    return row.id === 'w-pub'
      ? {
          ...wave,
          participation: { scope: { group: { id: 'g-submit' } } },
          voting: { scope: { group: { id: 'g-wave-vote' } } }
        }
      : wave;
  }

  async listCompetitionIds(waveIds: string[]) {
    expect(waveIds).not.toContain('w-broken');
    // As the backend lists them: by wave_id. c-elsewhere's record names
    // another wave, which the export checks.
    return [
      ...(waveIds.includes('w-pub') ? ['c-1', 'c-elsewhere'] : []),
      ...(waveIds.includes('w-members') ? ['c-2'] : [])
    ];
  }

  async competition(id: string) {
    this.competitionCalls.push(id);
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
      {
        id: `${entry.entry_id}-2`,
        voter_profile_id: 'p9',
        old_vote: 2,
        new_vote: 5,
        created_at: 20
      },
      {
        id: `${entry.entry_id}-1`,
        voter_profile_id: 'p8',
        old_vote: 0,
        new_vote: 2,
        created_at: 10
      }
    ];
  }

  async groups(ids: string[]) {
    this.groupCalls.push([...ids]);
    const out: Record<string, Json> = {};
    for (const id of ids) {
      if (id === 'g-missing' || id === 'g-gone') continue;
      out[id] = {
        id,
        name: id,
        visible: id !== 'g-hidden',
        is_private: id === 'g-private',
        is_direct_message: id === 'g-dm-group',
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
            : id === 'g-curators'
              ? {
                  // A REP rater the chain evaluates: no reason to take the
                  // group as its members, but it has a rater.
                  tdh: {},
                  rep: {
                    user_identity: 'rater-handle',
                    category: 'Good',
                    direction: 'RECEIVED',
                    min: 1
                  },
                  cic: {},
                  level: {},
                  owns_nfts: []
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
    expect(['g-vote', 'g-curators']).toContain(group.id);
    return group.id === 'g-vote'
      ? [
          {
            wallet: '0xDD00000000000000000000000000000000000004',
            key: 'member'
          }
        ]
      : [
          {
            wallet: '0xEE00000000000000000000000000000000000005',
            key: 'curator'
          }
        ];
  }

  async profileIdOf(key: string) {
    return key === 'rater-handle' ? 'p-rater' : null;
  }

  async waveRep(waveIds: string[]) {
    expect(waveIds).toEqual(['w-pub', 'w-sub']);
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
    this.dropCalls.push(waveId);
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
      recordsWaveId: RECORDS,
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

  it('writes every wave that moves, its configuration and its parent', () => {
    const waves = raw('waves_v3.json');
    expect(Object.keys(waves)).toEqual(['w-broken', 'w-pub', 'w-sub']);
    expect(waves['w-broken']._error).toContain('not found');
    expect(waves['w-sub'].configuration.chat.scope.group.id).toBe('g-post');
    // Each says it moves, as the API's ApiWave does.
    expect(waves['w-sub'].configuration.stays_on_site).toBe(false);
    expect(waves['w-sub'].stay_reasons).toEqual([]);
    // Its curations, a staying wave's left out.
    // By wave, every wave written with an entry, the failed one too.
    expect(raw('curations.json')).toEqual({
      'w-broken': [],
      'w-pub': [{ id: 'cu-2', wave_id: 'w-pub', group_id: 'g-curators' }],
      'w-sub': [{ id: 'cu-1', wave_id: 'w-sub', group_id: 'g-post' }]
    });
    // Each subwave written, with its parent.
    expect(raw('subwave_parents.json')).toEqual({ 'w-sub': 'w-pub' });
    expect(raw('waves_all.json')).toEqual([
      { id: 'w-broken' },
      { id: 'w-pub' }
    ]);
    // A subwave's read shows its parent's read group too.
    expect(Object.fromEntries(source.configurationCalls)['w-sub']).toEqual([
      'g-missing',
      'g-post'
    ]);
  });

  it('leaves out every wave that stays, whole, and counts them by reason', () => {
    const staying = [
      'w-dm',
      'w-hidden-admin',
      'w-members',
      'w-members-private',
      'w-under-members',
      RECORDS
    ];
    const read = new Set(source.configurationCalls.map(([id]) => id));
    for (const id of staying) {
      expect(read.has(id)).toBe(false);
      expect(source.dropCalls).not.toContain(id);
      expect(
        fs.existsSync(path.join(out, 'raw', 'drops', `${id}.jsonl.gz`))
      ).toBe(false);
    }
    // A staying wave's decisions, curations and groups are never read.
    expect(source.competitionCalls).not.toContain('c-2');
    expect(source.curationCalls).toEqual([['w-broken', 'w-pub', 'w-sub']]);
    for (const group of ['g-read', 'g-hidden', 'g-private', 'g-records-post']) {
      expect(source.groupCalls.flat()).not.toContain(group);
    }
    expect(raw('waves_staying.json')).toEqual({
      total: 6,
      by_reason: {
        direct_message: 1,
        records_wave: 1,
        members_only: 2,
        hidden_or_private_group: 2,
        parent_stays: 1,
        not_on_chain: 0
      },
      // Direct messages are counted, not named.
      waves: {
        'w-hidden-admin': ['hidden_or_private_group'],
        'w-members': ['members_only'],
        'w-members-private': ['members_only', 'hidden_or_private_group'],
        'w-under-members': ['parent_stays'],
        [RECORDS]: ['records_wave']
      }
    });
    expect(raw('export.json')).toMatchObject({
      records_wave_id: RECORDS,
      left_out: {
        waves: {
          total: 6,
          direct_message: 1,
          records_wave: 1,
          members_only: 2,
          hidden_or_private_group: 2,
          parent_stays: 1,
          not_on_chain: 0
        },
        groups: { total: 0, hidden_or_private_group: 0, direct_message: 0 }
      }
    });
  });

  it('writes the decisions of exported waves only', () => {
    expect(Object.keys(raw('competitions.json'))).toEqual(['c-1']);
    expect(raw('competition_details.json')['c-1'].entries).toHaveLength(3);
  });

  it('writes votes and vote logs of ACTIVE entries of PUBLISHED decisions', () => {
    expect(Object.keys(raw('entry_votes.json'))).toEqual(['e-1']);
    expect(raw('entry_logs.json')).toEqual({
      // Each row names its voter, as entry_votes.json's rows do.
      'd-1': [
        {
          id: 'e-1-2',
          voter_profile_id: 'p9',
          old_vote: 2,
          new_vote: 5,
          created_at: 20
        },
        {
          id: 'e-1-1',
          voter_profile_id: 'p8',
          old_vote: 0,
          new_vote: 2,
          created_at: 10
        }
      ]
    });
  });

  it('writes the named groups, their lists, raters and static members', () => {
    const groups = raw('groups.json');
    // Every group a moving wave, its decisions or its curations name: a
    // wave's own vote group (g-wave-vote) and a curation's (g-curators)
    // included; none a staying wave alone names (g-read, g-records-post).
    expect(Object.keys(groups)).toEqual([
      'g-admin',
      'g-curators',
      'g-missing',
      'g-post',
      'g-submit',
      'g-vote',
      'g-wave-vote'
    ]);
    expect(groups['g-missing']).toEqual({ _error: 404 });
    // Each with its visibility, for the snapshot builder.
    for (const id of Object.keys(groups).filter((id) => id !== 'g-missing')) {
      expect(groups[id]).toMatchObject({ visible: true, is_private: false });
    }
    expect(raw('groups_staying.json')).toEqual({});
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
    // A group with a rater is its members too, whatever its criteria.
    expect(raw('group_members.json')).toEqual({
      'g-curators': [
        { wallet: '0xee00000000000000000000000000000000000005', key: 'curator' }
      ],
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
        decisions: 1,
        drops: 3,
        entries: 3,
        curations: 2,
        groups: 6,
        groups_as_members: 2,
        groups_missing: 1,
        groups_staying: 0,
        polls: 1,
        signed_drops: 2,
        subwaves: 1,
        vote_log_rows: 2,
        vote_rows: 1,
        wave_rep_rows: 2,
        waves: 2,
        waves_failed: 1,
        waves_staying: 6
      },
      both_metric: false,
      failed_waves: [
        { id: 'w-broken', error: 'Error: Wave w-broken not found' }
      ],
      runs: [
        {
          run_started_at: T_W + 1,
          freeze_ms: T_W,
          exporter_revision: 'a'.repeat(40),
          records_wave_id: RECORDS,
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
        recordsWaveId: RECORDS,
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
        recordsWaveId: RECORDS,
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
        recordsWaveId: RECORDS,
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
        freeze_ms: T_W,
        exporter_revision: 'a'.repeat(40),
        records_wave_id: RECORDS,
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
        {
          run_started_at: T_W + 2,
          freeze_ms: T_W,
          exporter_revision: 'a'.repeat(40),
          records_wave_id: RECORDS,
          stages: ['drops'],
          replica_lag: EXPORT_LAG
        }
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

  it('leaves out a group a moving wave names that is private by now, and says so', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-export-group-'));
    try {
      const changed = new FakeSource();
      const read = changed.groups.bind(changed);
      changed.groups = async (ids: string[]) => {
        const found = await read(ids);
        found['g-post'] = { ...found['g-post'], is_private: true };
        return found;
      };
      const log: string[] = [];
      await new WavesExport(changed, {
        raw: new RawDirectory(path.join(dir, 'raw')),
        stages: ['waves', 'decisions', 'groups'],
        freezeMs: T_W,
        exporterRevision: 'a'.repeat(40),
        waveIds: null,
        dropPageSize: 2,
        concurrency: 1,
        bothMetric: false,
        recordsWaveId: RECORDS,
        retryDelayMs: 0,
        now: () => T_W,
        log: (message) => log.push(message)
      }).run();
      const file = (name: string) =>
        JSON.parse(fs.readFileSync(path.join(dir, 'raw', name), 'utf8'));
      expect(Object.keys(file('groups.json'))).not.toContain('g-post');
      expect(file('groups_staying.json')).toEqual({
        'g-post': 'hidden_or_private_group'
      });
      expect(file('export.json').left_out.groups).toEqual({
        total: 1,
        hidden_or_private_group: 1,
        direct_message: 0
      });
      expect(log).toContain(
        'group g-post stays on 6529.io (hidden_or_private_group) but a wave that moves names it: left out'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('a DIR from another freeze', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-export-freeze-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const exportInto = (
      freezeMs: number | null,
      stages: (typeof WAVES_EXPORT_STAGES)[number][],
      resumeDrops = false,
      recordsWaveId: string | null = RECORDS,
      log: (message: string) => void = () => undefined,
      source = new FakeSource()
    ) =>
      new WavesExport(source, {
        raw: new RawDirectory(path.join(dir, 'raw')),
        stages,
        freezeMs,
        exporterRevision: 'a'.repeat(40),
        waveIds: null,
        dropPageSize: 2,
        concurrency: 1,
        bothMetric: false,
        recordsWaveId,
        resumeDrops,
        retryDelayMs: 0,
        replicaLag: null,
        now: () => T_W,
        log
      }).run();
    const runsFile = () =>
      JSON.parse(
        fs.readFileSync(path.join(dir, 'raw', 'export_runs.json'), 'utf8')
      );

    it('is refused when its earlier run kept another records wave', async () => {
      await exportInto(T_W, ['waves']);
      const refusal = exportInto(T_W, ['decisions'], false, 'w-pub');
      await expect(refusal).rejects.toThrow(WavesExportUsageError);
      await expect(refusal).rejects.toThrow(
        `holds an earlier run that kept wave ${RECORDS} as the records wave on 6529.io, and this run keeps wave w-pub as the records wave.`
      );
      expect(runsFile()).toHaveLength(1);
    });

    it('runs with no records wave when the setting says none, and records it', async () => {
      const source = new FakeSource();
      await exportInto(T_W, ['waves'], false, null, () => undefined, source);
      const file = (name: string) =>
        JSON.parse(fs.readFileSync(path.join(dir, 'raw', name), 'utf8'));
      // No wave is the records wave, so that one moves on its own groups.
      expect(Object.keys(file('waves_v3.json'))).toContain(RECORDS);
      expect(file('waves_staying.json').by_reason.records_wave).toBe(0);
      expect(file('export.json')).toMatchObject({
        records_wave_id: null,
        left_out: { waves: { records_wave: 0 } }
      });
      expect(runsFile()[0].records_wave_id).toBeNull();
      // An OUT run with none takes no records wave after it.
      await expect(exportInto(T_W, ['decisions'])).rejects.toThrow(
        `holds an earlier run that kept no records wave on 6529.io, and this run keeps wave ${RECORDS} as the records wave.`
      );
    });

    it("refuses a run when no wave has the records wave's id; a rehearsal says so and goes on", async () => {
      const source = new FakeSource();
      const refusal = exportInto(
        T_W,
        ['waves'],
        false,
        'w-nope',
        () => undefined,
        source
      );
      await expect(refusal).rejects.toThrow(
        "No wave of 6529.io has the records wave's id, w-nope (--records-wave-id or SIGNED_RECORDS_WAVE_ID): check it, or the records wave would move with the rest."
      );
      expect(source.configurationCalls).toEqual([]);
      // The refused run left no record: the same OUT takes the right id.
      expect(fs.existsSync(path.join(dir, 'raw', 'export_runs.json'))).toBe(
        false
      );
      await expect(exportInto(T_W, ['waves'])).resolves.toBeDefined();
      fs.rmSync(path.join(dir, 'raw'), { recursive: true, force: true });
      const log: string[] = [];
      await exportInto(null, ['waves'], false, 'w-nope', (message) =>
        log.push(message)
      );
      expect(log).toContain(
        "rehearsal: No wave of 6529.io has the records wave's id, w-nope (--records-wave-id or SIGNED_RECORDS_WAVE_ID): check it, or the records wave would move with the rest. A run after the freeze refuses on this."
      );
    });

    it("is refused after a rehearsal's run, whatever the stages", async () => {
      await exportInto(null, ['waves']);
      for (const [stages, resume] of [
        [[...WAVES_EXPORT_STAGES], false],
        [['drops'], true],
        [['decisions'], false]
      ] as const) {
        const refusal = exportInto(T_W, [...stages], resume);
        await expect(refusal).rejects.toThrow(WavesExportUsageError);
        await expect(refusal).rejects.toThrow(
          `holds an earlier run for a rehearsal, and this run is for the freeze at 2026-11-25T00:00:00.000Z. Their files would mix: its drops of waves gone since would stay, --resume would keep its drops, and a run without the waves stage would read its wave list. Run the export into a new, empty OUT.`
        );
      }
      // A refused run adds no record.
      expect(
        runsFile().map((run: { freeze_ms: unknown }) => run.freeze_ms)
      ).toEqual([null]);
    });

    it('is refused after a real run for a rehearsal or another freeze', async () => {
      await exportInto(T_W, ['waves']);
      await expect(exportInto(null, ['waves'])).rejects.toThrow(
        'holds an earlier run for the freeze at 2026-11-25T00:00:00.000Z, and this run is for a rehearsal.'
      );
      await expect(exportInto(T_W + 86_400_000, ['waves'])).rejects.toThrow(
        'and this run is for the freeze at 2026-11-26T00:00:00.000Z.'
      );
      // The same freeze goes on.
      await expect(exportInto(T_W, ['decisions'])).resolves.toBeDefined();
      expect(runsFile()).toHaveLength(2);
    });

    it("reads the freeze of a run from before the run records, or refuses when it can't", async () => {
      const raw = new RawDirectory(path.join(dir, 'raw'));
      await raw.save('export.json', { freeze_ms: null });
      await expect(exportInto(T_W, ['drops'], true)).rejects.toThrow(
        'holds an earlier run for a rehearsal'
      );
      fs.rmSync(path.join(dir, 'raw', 'export.json'));
      await raw.save('waves_v3.json', {});
      await expect(exportInto(T_W, ['drops'], true)).rejects.toThrow(
        'holds an earlier run for a freeze it did not record'
      );
      await raw.save('export_runs.json', [{ run_started_at: 1, stages: [] }]);
      await expect(exportInto(T_W, ['waves'])).rejects.toThrow(
        'holds an earlier run for a freeze it did not record'
      );
    });
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

  it("names a wave's own submit and vote groups and every curation's group too", () => {
    const wave = {
      ...configuration('w', 'r', 'p', 'a'),
      participation: { scope: { group: { id: 's2' } } },
      voting: { scope: { group: { id: 'v2' } } }
    };
    const uses = exportedGroups(
      { w: { id: 'w', configuration: wave } },
      { c: { participation: { group_id: 's' }, voting: { group_id: 'r' } } },
      { w: [{ id: 'cu', wave_id: 'w', group_id: 'g-cu' }] }
    );
    expect(
      Object.fromEntries(
        Array.from(uses.entries()).map(([k, v]) => [k, Array.from(v).sort()])
      )
    ).toEqual({
      a: ['admin'],
      'g-cu': ['curation'],
      p: ['post'],
      r: ['read', 'vote'],
      s: ['submit'],
      s2: ['submit'],
      v2: ['vote']
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

describe('WavesExport stopped by its caller in the drops stage', () => {
  const WAVES = ['w-1', 'w-2', 'w-3', 'w-4', 'w-5'];

  /** Five waves of two drops each, the first signed. */
  class FiveWaves extends FakeSource {
    readonly dropsRead: string[] = [];

    async listWaves() {
      return [
        ...WAVES.map((id) => wave(id, null)),
        wave(RECORDS, null, {}, [StayReason.RECORDS_WAVE])
      ];
    }

    async waveConfiguration(row: ExportWaveRow) {
      return configuration(row.id, null, null, null);
    }

    async *wavePagesOfDrops(waveId: string) {
      this.dropsRead.push(waveId);
      yield [drop(`${waveId}-b`, 2, true), drop(`${waveId}-a`, 1, false)];
    }
  }

  const exportOf = (
    out: string,
    source: FakeSource,
    stages: readonly (typeof WAVES_EXPORT_STAGES)[number][],
    stopBeforeWave?: () => boolean
  ) =>
    new WavesExport(source, {
      raw: new RawDirectory(path.join(out, 'raw')),
      stages,
      freezeMs: T_W,
      exporterRevision: 'a'.repeat(40),
      waveIds: null,
      dropPageSize: 2,
      concurrency: 2,
      bothMetric: false,
      recordsWaveId: RECORDS,
      resumeDrops: true,
      stopBeforeWave,
      retryDelayMs: 0,
      log: () => undefined
    }).run();

  it('finishes the waves it started, writes no export.json, and a resumed run reads only the rest', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-export-stop-'));
    await exportOf(out, new FiveWaves(), ['waves']);
    fs.rmSync(path.join(out, 'raw', 'export.json'));
    const first = new FiveWaves();
    let asked = 0;
    const stopped = exportOf(out, first, ['drops'], () => ++asked > 2);
    await expect(stopped).rejects.toThrow(WavesExportStoppedError);
    await expect(stopped).rejects.toMatchObject({ wavesLeft: 3, waves: 5 });
    // Two at once: the first two waves, in either order.
    expect(first.dropsRead.sort()).toEqual(['w-1', 'w-2']);
    const raw = path.join(out, 'raw');
    // Each wave it read is whole: its drops and its signed file.
    for (const id of ['w-1', 'w-2']) {
      expect(readLines(path.join(raw, 'drops', `${id}.jsonl.gz`))).toHaveLength(
        2
      );
      expect(
        readLines(path.join(raw, 'signed', `${id}.jsonl.gz`))
      ).toHaveLength(1);
    }
    expect(fs.readdirSync(path.join(raw, 'drops')).sort()).toEqual([
      'w-1.jsonl.gz',
      'w-2.jsonl.gz'
    ]);
    expect(fs.existsSync(path.join(raw, 'export.json'))).toBe(false);
    // The stopped run is in the run log all the same.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(raw, 'export_runs.json'), 'utf8')
      ).map((run: { stages: string[] }) => run.stages.join(','))
    ).toEqual(['waves', 'drops']);
    const second = new FiveWaves();
    const summary = await exportOf(out, second, ['drops'], () => false);
    expect(second.dropsRead.sort()).toEqual(['w-3', 'w-4', 'w-5']);
    expect(summary.counts).toMatchObject({ drops: 6, drop_waves_kept: 2 });
    expect(fs.readdirSync(path.join(raw, 'drops'))).toHaveLength(5);
  });

  it('never stops a run that has no stopBeforeWave', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-export-stop-'));
    const source = new FiveWaves();
    await exportOf(out, source, ['waves', 'drops']);
    expect(source.dropsRead.sort()).toEqual(WAVES);
  });
});
