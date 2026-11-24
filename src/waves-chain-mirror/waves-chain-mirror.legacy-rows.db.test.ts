// A rebuild's rows of the imported objects 6529.io has none of (its tables
// dropped for the rebuild), against what 6529.io held; and the live mirror,
// which writes none of them.
import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cidPath, rawCidHexOf } from '@/chain-gateway/chain-gateway.client';
import {
  legacyCompetitionDecisionId,
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITIONS_TABLE,
  WAVES_CHAIN_INDEX_STATE_TABLE,
  DROPS_TABLE,
  PROFILE_GROUPS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_METADATA_TABLE,
  WAVES_TABLE
} from '@/constants';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';
import {
  clearMirrorTables,
  ensurePrincipalMap,
  mapPrincipals,
  seedChainDecision
} from '@/tests/fixtures/waves-chain-mirror.db.fixture';
import {
  aChainGroupRow,
  aChainWaveRow,
  chainWord
} from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import { ChainObject } from '@/waves-chain-index/waves-chain-index.api';
import {
  EMPTY_INDEX_STATE,
  WavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import { UNKNOWN_SCAN } from '@/waves-chain-index/waves-chain-index.events';
import { groupRow, waveRow } from '@/waves-chain-index/waves-chain-index.rows';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { WavesChainObjectsMirror } from './waves-chain-mirror.objects';
import { WavesChainObjectsDb } from './waves-chain-mirror.objects.db';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
import { mirrorPlannedRows } from './waves-chain-mirror.legacy-rows';
import { groupRowOf, NO_CRITERIA } from './waves-chain-mirror.groups';
import { groupListId, groupShortIdOf } from './waves-chain-mirror.ids';
import { rebuildWavesChainMirror } from './waves-chain-mirror.rebuild';
import { WavesChainMirror } from './waves-chain-mirror.service';

const T = 1_764_000_000_000;
const RESULT = T + 86_400_000;
const P1 = chainWord('11');
const W = chainWord('0b');
const D = chainWord('d1');
const D2 = chainWord('d2');
const ZERO = chainWord('00');
const WAVE = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000c9';
const COMPETITION = legacyCompetitionId(WAVE);
/** The run's switch time: the waves import's start. */
const SWITCH = RESULT + 1_000;
/** As the rebuild check passes it: the switch the chain index keeps. */
const PLANNED = mirrorPlannedRows({ switchAt: 'chain-index' });
const drop = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const FILES = 'http://files.example/legacy';
const GATEWAY = 'http://gateway.example/legacy';
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-mirror-legacy-'));
const filesFetch = jest.fn(async (url: string | URL | Request) => {
  const file = path.join(filesDir, String(url).slice(FILES.length + 1));
  return fs.existsSync(file)
    ? new Response(fs.readFileSync(file))
    : new Response(null, { status: 404 });
});

/** A document in the run's files source; its CID. */
function file(doc: unknown): string {
  const bytes = Buffer.from(`${JSON.stringify(doc)}\n`);
  const cid = rawCidHexOf(bytes);
  fs.writeFileSync(path.join(filesDir, cidPath(cid)), bytes);
  return cid;
}

/** The rank wave as 6529.io held it, and its primary competition's row. */
function rankWave() {
  return aWave(
    {
      type: WaveType.RANK,
      created_by: 'profile-1',
      created_at: T,
      updated_at: null,
      decisions_strategy: {
        first_decision_time: RESULT,
        subsequent_decisions: [],
        is_rolling: false
      }
    },
    { id: WAVE, name: 'A rank wave', serial_no: 1 }
  );
}

/** The import's document of a competition (6529.io's own object). */
function decisionDoc(record: Record<string, unknown>) {
  return {
    v: 1,
    kind: 'decision',
    id: record.id,
    wave_id: record.wave_id,
    type: record.type,
    title: record.title,
    description: record.description,
    config_version: record.config_version,
    participation: record.participation_config,
    voting: record.voting_config,
    decisions: record.decision_config,
    winners: record.winner_config,
    outcome_config: record.outcome_config,
    capabilities: ['MAIN_STAGE'],
    created_at: record.created_at,
    published_at: record.published_at,
    ended_at: record.ended_at,
    archived_at: record.archived_at,
    lifecycle: record.lifecycle
  };
}

describe("a rebuild's rows of imported objects", () => {
  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);
  const stamp = { height: 20, generation: 1 };

  afterAll(() => fs.rmSync(filesDir, { recursive: true, force: true }));

  /**
   * The chain's import of a rank wave, its primary decision (an entry, a
   * winner and its result) and a second decision in it; 6529.io's rows of
   * them dropped.
   */
  async function seedWorld(waveDocFields: Record<string, unknown> = {}) {
    await clearMirrorTables(sqlExecutor);
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [P1]: 'profile-1' });
    const waveCid = file({
      v: 1,
      kind: 'wave',
      legacy_id: WAVE,
      serial_no: 1,
      name: 'A rank wave',
      picture: null,
      created_at: T,
      parent_wave: null,
      description: [{ content: 'What the wave is about', media: [] }],
      chat: {
        enabled: true,
        links_disabled: false,
        replies: { open: true, collapsed: false }
      },
      admin_drop_deletion_enabled: false,
      ...waveDocFields
    });
    const wave = aChainWaveRow(W, {
      origin: 'legacy',
      legacyId: WAVE,
      controller: P1,
      metadataCid: waveCid
    });
    await index.upsert(
      'waves',
      [
        waveRow({
          ...(wave.data as ChainObject),
          legacyId: WAVE,
          origin: 'legacy',
          status: 'open',
          readGroup: { groupId: ZERO },
          postGroup: { groupId: ZERO },
          adminGroup: { groupId: ZERO }
        })
      ],
      stamp
    );
    const record = nativeOriginalPrimaryFixture(rankWave());
    const entry = (
      id: string,
      decisionId: string,
      legacyId: string,
      fields = {}
    ) => ({
      entryId: id,
      legacyId,
      decisionId,
      author: P1,
      status: 'active',
      total: '0',
      origin: 'legacy',
      createdMs: T + 1000,
      lastIncrease: { time: 0, height: 0, index: 0 },
      ...fields
    });
    await seedChainDecision(
      index,
      {
        decision: {
          decisionId: D,
          legacyId: COMPETITION,
          waveId: W,
          status: 'published',
          kind: 'rank',
          origin: 'legacy',
          counted: true,
          nextResultTime: 0,
          metadataCid: file(
            decisionDoc(record as unknown as Record<string, unknown>)
          )
        },
        entries: [
          entry(chainWord('e1'), D, drop(1)),
          entry(chainWord('e2'), D, drop(2), {
            status: 'winner',
            resultTime: RESULT,
            rank: 1
          })
        ],
        results: [
          {
            resultTime: RESULT,
            status: 'decided',
            stage: 'final',
            origin: 'legacy',
            settledHeight: 10,
            winners: [{ entryId: chainWord('e2'), rank: 1, score: '42' }]
          }
        ]
      },
      30
    );
    await seedChainDecision(
      index,
      {
        decision: {
          decisionId: D2,
          legacyId: OTHER,
          waveId: W,
          status: 'published',
          kind: 'rank',
          origin: 'legacy',
          counted: true,
          nextResultTime: 0,
          metadataCid: file(
            decisionDoc({
              ...(record as unknown as Record<string, unknown>),
              id: OTHER,
              legacy_wave_id: null,
              title: 'A second competition'
            })
          )
        },
        entries: [entry(chainWord('e3'), D2, drop(3))]
      },
      30
    );
    await index.writeEvents(
      [
        {
          height: 30,
          seq: 0,
          blockTime: RESULT + 5_000,
          kind: 'WAVE_CREATED',
          origin: 'OPERATION',
          waveId: W,
          waveLegacyId: WAVE,
          decisionId: null,
          decisionLegacyId: null,
          entryId: null,
          entryLegacyId: null,
          pollId: null,
          pollLegacyId: null,
          groupId: null,
          groupLegacyId: null,
          actor: P1,
          data: {}
        }
      ],
      31,
      UNKNOWN_SCAN
    );
    await index.saveState(
      {
        ...EMPTY_INDEX_STATE,
        generation: 1,
        lastFullAt: 1,
        feedNext: 31,
        network: 'net-1',
        importStartedAt: SWITCH
      },
      1
    );
    return record;
  }

  const rows = (table: string, where = '1 = 1', params = {}) =>
    sqlExecutor.execute<Record<string, unknown>>(
      `select * from ${table} where ${where}`,
      params
    );

  it('writes the imported wave, decisions, entries, result and winner as 6529.io held them', async () => {
    const record = await seedWorld();
    const rebuilt = await rebuildWavesChainMirror(
      { sources: { files: FILES, gateway: GATEWAY } },
      () => sqlExecutor,
      { CHAIN_GATEWAY_URL: GATEWAY },
      { fetchImpl: filesFetch as unknown as typeof fetch }
    );
    expect(rebuilt.missingDocuments).toBe(0);

    // The wave, under its legacy id, as 6529.io's create makes it; no
    // description drop (the import-files reader's).
    const fixture = rankWave();
    expect(await rows(WAVES_TABLE)).toEqual([
      expect.objectContaining({
        id: WAVE,
        name: fixture.name,
        picture: null,
        created_at: T,
        created_by: 'profile-1',
        description_drop_id: '',
        parent_wave_id: null,
        visibility_group_id: null,
        admin_group_id: null,
        chat_group_id: null,
        chat_enabled: true,
        chat_replies_open: true,
        admin_drop_deletion_enabled: false
      })
    ]);
    expect(await rows(DROPS_TABLE)).toEqual([]);

    // The primary competition: 6529.io's row, and the second one's.
    const [competition] = await rows(COMPETITIONS_TABLE, 'id = :id', {
      id: COMPETITION
    });
    expect(competition).toMatchObject({
      id: COMPETITION,
      wave_id: WAVE,
      legacy_wave_id: WAVE,
      execution_mode: 'ACTIVE',
      type: 'RANK',
      title: record.title,
      created_at: T,
      published_at: T
    });
    expect(await rows(COMPETITIONS_TABLE, 'id = :id', { id: OTHER })).toEqual([
      expect.objectContaining({
        legacy_wave_id: null,
        title: 'A second competition'
      })
    ]);
    expect(
      (await rows(COMPETITION_CONFIG_VERSIONS_TABLE)).map((r) => [
        r.competition_id,
        r.version
      ])
    ).toEqual(
      expect.arrayContaining([
        [COMPETITION, 1],
        [OTHER, 1]
      ])
    );
    expect(
      (await rows(COMPETITION_CAPABILITIES_TABLE)).map((r) => [
        r.competition_id,
        r.capability
      ])
    ).toEqual(
      expect.arrayContaining([
        [COMPETITION, 'MAIN_STAGE'],
        [OTHER, 'MAIN_STAGE']
      ])
    );

    // The primary's entries under 6529.io's ids; the second competition's
    // wait (its ids were random on 6529.io).
    const decisionId = legacyCompetitionDecisionId(COMPETITION, RESULT);
    const winner = legacyCompetitionEntryId(COMPETITION, drop(2));
    const entries = await rows(COMPETITION_ENTRIES_TABLE);
    expect(
      entries
        .map((e) => ({
          id: e.id,
          competition_id: e.competition_id,
          drop_id: e.drop_id,
          submitter_id: e.submitter_id,
          status: e.status,
          submitted_at: Number(e.submitted_at),
          won_at: e.won_at === null ? null : Number(e.won_at),
          rank: e.rank,
          decision_id: e.decision_id
        }))
        .sort((a, b) => String(a.drop_id).localeCompare(String(b.drop_id)))
    ).toEqual([
      {
        id: legacyCompetitionEntryId(COMPETITION, drop(1)),
        competition_id: COMPETITION,
        drop_id: drop(1),
        submitter_id: 'profile-1',
        status: 'ACTIVE',
        submitted_at: T + 1000,
        won_at: null,
        rank: null,
        decision_id: null
      },
      {
        id: winner,
        competition_id: COMPETITION,
        drop_id: drop(2),
        submitter_id: 'profile-1',
        status: 'WINNER',
        submitted_at: T + 1000,
        won_at: RESULT,
        rank: 1,
        decision_id: decisionId
      }
    ]);
    expect(rebuilt.last.waiting).toMatchObject({
      imported_entry_id_planned: 1
    });

    // The result and its winner, as 6529.io's runtime wrote them.
    expect(await rows(COMPETITION_DECISIONS_TABLE)).toEqual([
      expect.objectContaining({
        id: decisionId,
        competition_id: COMPETITION,
        scheduled_at: RESULT,
        status: 'COMPLETED',
        execution_key: `native:${COMPETITION}:${RESULT}`
      })
    ]);
    expect(await rows(COMPETITION_DECISION_WINNERS_TABLE)).toEqual([
      expect.objectContaining({
        competition_id: COMPETITION,
        entry_id: winner,
        decision_id: decisionId,
        rank: 1,
        final_rating: 42
      })
    ]);
  });

  it("takes an imported wave's description drop id from the drop archives' import, '' without it", async () => {
    await seedWorld();
    const description = '00000000-0000-4000-8000-0000000001b1';
    const rebuilt = await rebuildWavesChainMirror(
      { sources: { files: FILES, gateway: GATEWAY } },
      () => sqlExecutor,
      { CHAIN_GATEWAY_URL: GATEWAY },
      {
        fetchImpl: filesFetch as unknown as typeof fetch,
        // As the import-files reader's step: the description drop under
        // its original id, and the mapping.
        importDropArchives: async (_sources, db) => {
          await db().execute(
            `insert into ${DROPS_TABLE}
               (id, wave_id, author_id, created_at, updated_at, title,
                parts_count, reply_to_drop_id, reply_to_part_id, drop_type,
                signature, hide_link_preview)
             values (:id, :wave, 'profile-1', :at, null, null, 1, null, null,
                'CHAT', null, false)`,
            { id: description, wave: WAVE, at: T }
          );
          return {
            descriptionDropIds: new Map([[WAVE.toUpperCase(), description]])
          };
        }
      }
    );
    expect(rebuilt.dropArchives?.descriptionDropIds.size).toBe(1);
    expect(
      await sqlExecutor.execute(
        `select description_drop_id from ${WAVES_TABLE} where id = :id`,
        { id: WAVE }
      )
    ).toEqual([{ description_drop_id: description }]);

    // The wave document's own id, when the import carries it and the step
    // wrote that drop in the wave, over the step's mapping; one naming no
    // drop the step wrote, noted, and the mapping's used.
    const own = '00000000-0000-4000-8000-0000000002b1';
    for (const written of [true, false]) {
      await seedWorld({ description_drop_id: own });
      const result = await rebuildWavesChainMirror(
        { sources: { files: FILES, gateway: GATEWAY } },
        () => sqlExecutor,
        { CHAIN_GATEWAY_URL: GATEWAY },
        {
          fetchImpl: filesFetch as unknown as typeof fetch,
          importDropArchives: async (_sources, db) => {
            if (written) {
              await db().execute(
                `insert into ${DROPS_TABLE}
                   (id, wave_id, author_id, created_at, updated_at, title,
                    parts_count, reply_to_drop_id, reply_to_part_id,
                    drop_type, signature, hide_link_preview)
                 values (:id, :wave, 'profile-1', :at, null, null, 1, null,
                    null, 'CHAT', null, false)`,
                { id: own, wave: WAVE, at: T }
              );
            }
            return { descriptionDropIds: new Map([[WAVE, description]]) };
          }
        }
      );
      expect(
        await sqlExecutor.execute(
          `select description_drop_id from ${WAVES_TABLE} where id = :id`,
          { id: WAVE }
        )
      ).toEqual([{ description_drop_id: written ? own : description }]);
      expect(result.runs).toBeGreaterThan(0);
    }

    // Without either: '' (planned), the entry's where selecting the wave.
    await seedWorld();
    await rebuildWavesChainMirror(
      { sources: { files: FILES, gateway: GATEWAY } },
      () => sqlExecutor,
      { CHAIN_GATEWAY_URL: GATEWAY },
      { fetchImpl: filesFetch as unknown as typeof fetch }
    );
    const entry = PLANNED.find(
      (e) =>
        e.table === WAVES_TABLE && e.columns?.includes('description_drop_id')
    )!;
    expect(
      await sqlExecutor.execute(
        `select id, description_drop_id from ${WAVES_TABLE} where ${entry.where}`
      )
    ).toEqual([{ id: WAVE, description_drop_id: '' }]);
  });

  it("selects each planned entry's rows with its where, and none of 6529.io's rows the chain never had", async () => {
    await seedWorld();
    // An imported group the chain never replaced, with 6529.io's row and
    // list.
    const LEGACY_GROUP = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6b';
    const IMPORTED_GROUP = `readers-${groupShortIdOf(LEGACY_GROUP)}`;
    await index.upsert(
      'groups',
      [
        groupRow({
          ...(aChainGroupRow(
            chainWord('0a'),
            {},
            { origin: 'legacy', legacyId: LEGACY_GROUP }
          ).data as ChainObject),
          legacyId: LEGACY_GROUP,
          origin: 'legacy'
        })
      ],
      stamp
    );
    const groups = new UserGroupsDb(() => sqlExecutor);
    const groupOf = (id: string, list: string) =>
      groupRowOf({
        id,
        name: 'A group',
        createdAt: new Date(1_700_000_000_000),
        createdBy: 'profile-1',
        criteria: NO_CRITERIA,
        repUser: null,
        includeListId: list,
        excludeListId: null,
        visible: true,
        isPrivate: false
      });
    await groups.save(groupOf(IMPORTED_GROUP, 'old-list'), undefined as never);
    // An imported group the chain replaced: its row is the mirror's, from
    // the chain, and stays compared.
    const REPLACED_LEGACY = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a7c';
    const REPLACED_GROUP = `writers-${groupShortIdOf(REPLACED_LEGACY)}`;
    await index.upsert(
      'groups',
      [
        groupRow({
          ...(aChainGroupRow(
            chainWord('0e'),
            { includes: [{ kind: 'principal', value: P1 }] },
            { origin: 'legacy', legacyId: REPLACED_LEGACY, version: 2 }
          ).data as ChainObject),
          legacyId: REPLACED_LEGACY,
          origin: 'legacy'
        })
      ],
      stamp
    );
    await groups.save(
      groupOf(REPLACED_GROUP, 'replaced-list'),
      undefined as never
    );
    // A direct-message group whose id ends in an imported group's short id:
    // never matched.
    const DM_LEGACY = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a8d';
    const DM_MATCHING = `dm-${groupShortIdOf(DM_LEGACY)}`;
    await index.upsert(
      'groups',
      [
        groupRow({
          ...(aChainGroupRow(
            chainWord('0f'),
            {},
            { origin: 'legacy', legacyId: DM_LEGACY }
          ).data as ChainObject),
          legacyId: DM_LEGACY,
          origin: 'legacy'
        })
      ],
      stamp
    );
    await groups.save(groupOf(DM_MATCHING, 'dm-list-2'), undefined as never);
    await sqlExecutor.execute(
      `update ${USER_GROUPS_TABLE} set is_direct_message = true where id = :id`,
      { id: DM_MATCHING }
    );
    // 6529.io's rows the chain never had: a direct-message wave, its
    // group, list and metadata.
    const DM_WAVE = '00000000-0000-4000-8000-0000000000dd';
    const DM_GROUP = 'dm-group';
    await groups.save(groupOf(DM_GROUP, 'dm-list'), undefined as never);
    await sqlExecutor.execute(
      `insert into ${PROFILE_GROUPS_TABLE} (profile_group_id, profile_id)
       values ('old-list', 'profile-1'), ('dm-list', 'profile-1')`
    );
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) =>
      new WavesApiDb(() => sqlExecutor).insertWave(
        {
          ...aWave(
            {
              created_by: 'profile-1',
              visibility_group_id: DM_GROUP,
              chat_group_id: DM_GROUP
            },
            { id: DM_WAVE, serial_no: 9, name: 'A direct message' }
          ),
          participation_required_metadata: [],
          participation_required_media: [],
          is_direct_message: true,
          voting_credit_nfts: []
        },
        { connection }
      )
    );
    await sqlExecutor.execute(
      `insert into ${WAVES_METADATA_TABLE} (wave_id, data_key, data_value)
       values (:wave, 'a.key', 'a value')`,
      { wave: DM_WAVE }
    );
    await rebuildWavesChainMirror(
      { sources: { files: FILES, gateway: GATEWAY } },
      () => sqlExecutor,
      { CHAIN_GATEWAY_URL: GATEWAY },
      { fetchImpl: filesFetch as unknown as typeof fetch }
    );
    // As 6529.io held them: a skipped execution of the imported primary,
    // and vote history before and after the switch.
    await sqlExecutor.execute(
      `insert into ${COMPETITION_DECISIONS_TABLE}
         (id, competition_id, scheduled_at, decided_at, status,
          execution_key, created_at)
       values ('00000000-0000-4000-8000-0000000000ca', :c, :t, :t,
          'CANCELLED', :key, :t)`,
      { c: COMPETITION, t: T + 500, key: `native:${COMPETITION}:${T + 500}` }
    );
    for (const at of [SWITCH - 1, SWITCH]) {
      await sqlExecutor.execute(
        `insert into ${COMPETITION_VOTE_HISTORY_TABLE}
           (competition_id, entry_id, drop_id, submitter_id, voter_profile_id,
            value, previous_value, aggregate_value, credit_delta, occurred_at)
         values (:c, 'an-entry', null, null, 'profile-1', 1, 0, 1, 1, :at)`,
        { c: COMPETITION, at }
      );
    }

    const counts = new Map<(typeof PLANNED)[number], number>();
    for (const entry of PLANNED) {
      const [row] = await sqlExecutor.execute<{ n: number }>(
        `select count(*) as n from ${entry.table} where ${entry.where}`
      );
      counts.set(entry, Number(row.n));
    }
    const count = (table: string, columns: string[] | null) =>
      counts.get(
        PLANNED.find(
          (e) =>
            e.table === table &&
            JSON.stringify(e.columns) === JSON.stringify(columns)
        )!
      );
    // The imported wave, competitions, result and winner, and the primary's
    // two entries; nothing of the chain's own.
    expect(count('waves', ['description_drop_id'])).toBe(1);
    expect(count('waves', ['serial_no'])).toBe(2);
    expect(count('competitions', ['updated_at', 'cancelled_at'])).toBe(2);
    expect(
      count('competition_config_versions', [
        'config',
        'created_by',
        'created_at'
      ])
    ).toBe(2);
    expect(count('competition_config_versions', null)).toBe(0);
    expect(
      count('competition_capabilities', [
        'assigned_by',
        'legacy_source_wave_id',
        'assigned_at'
      ])
    ).toBe(2);
    expect(
      count('competition_entries', [
        'config_version',
        'withdrawn_at',
        'disqualified_at'
      ])
    ).toBe(2);
    expect(count('competition_entries', null)).toBe(0);
    // The completed result, and the skipped execution on its own.
    expect(count('competition_decisions', ['decided_at', 'created_at'])).toBe(
      1
    );
    expect(count('competition_decisions', null)).toBe(1);
    expect(count('competition_decision_winners', ['created_at'])).toBe(1);
    // The vote before the switch only.
    expect(count('competition_vote_history', null)).toBe(1);
    // An index that hasn't read the import complete keeps no switch: the
    // history entries then excuse nothing.
    await sqlExecutor.execute(
      `update ${WAVES_CHAIN_INDEX_STATE_TABLE} set import_started_at = null`
    );
    const history = PLANNED.find(
      (e) => e.table === COMPETITION_VOTE_HISTORY_TABLE
    )!;
    expect(
      await sqlExecutor.execute(
        `select count(*) as n from ${history.table} where ${history.where}`
      )
    ).toEqual([{ n: 0 }]);
    // The imported group the chain never replaced (matched by the rebuild)
    // and its list; not the replaced one, which the mirror rewrote, nor the
    // direct-message group.
    expect(count('community_groups', null)).toBe(1);
    expect(count('profile_groups', null)).toBe(1);
    const groupsEntry = PLANNED.find((e) => e.table === USER_GROUPS_TABLE)!;
    expect(
      await sqlExecutor.execute(
        `select id from ${USER_GROUPS_TABLE} where ${groupsEntry.where}`
      )
    ).toEqual([{ id: IMPORTED_GROUP }]);
    expect(
      await sqlExecutor.execute(
        `select profile_group_id from ${USER_GROUPS_TABLE} where id = :id`,
        { id: REPLACED_GROUP }
      )
    ).toEqual([
      { profile_group_id: groupListId(chainWord('0e'), 2, 'include') }
    ]);
    expect(
      await new WavesChainObjectsDb(() => sqlExecutor).importedGroupId(
        DM_LEGACY
      )
    ).toBeNull();

    // None of 6529.io's rows the chain never had.
    const dmKeys: Record<string, string> = {
      [WAVES_TABLE]: `id = '${DM_WAVE}'`,
      [WAVES_METADATA_TABLE]: `wave_id = '${DM_WAVE}'`,
      [USER_GROUPS_TABLE]: `id = '${DM_GROUP}'`,
      [PROFILE_GROUPS_TABLE]: `profile_group_id = 'dm-list'`
    };
    for (const entry of PLANNED) {
      const key = dmKeys[entry.table];
      if (!key || entry.where === 'true') continue;
      const [row] = await sqlExecutor.execute<{ n: number }>(
        `select count(*) as n from ${entry.table} where (${entry.where}) and ${key}`
      );
      expect([entry.table, entry.columns, Number(row.n)]).toEqual([
        entry.table,
        entry.columns,
        0
      ]);
    }
  });

  it('writes none of them live: 6529.io has its own rows', async () => {
    await seedWorld();
    const objects = new WavesChainObjectsMirror(
      new WavesChainObjectsDb(() => sqlExecutor),
      (ids) => db.profilesOfPrincipals(ids),
      defaultObjectEffects,
      { check: jest.fn().mockResolvedValue({ kind: 'allowed' }) },
      () => RESULT + 60_000
    );
    const report = await new WavesChainMirror(
      db,
      index,
      () => ({
        write: true,
        frozen: true,
        keepMainStage: false,
        mainStageWaveId: null
      }),
      () => RESULT + 60_000,
      undefined,
      { check: jest.fn().mockResolvedValue({ kind: 'allowed' }) },
      undefined,
      async () => null,
      { run: (input) => objects.run(input) }
    ).run({ budgetMs: 60_000 });
    expect(report.decisions.skipped).toMatchObject({ no_competition: 2 });
    for (const table of [
      WAVES_TABLE,
      COMPETITIONS_TABLE,
      COMPETITION_ENTRIES_TABLE,
      COMPETITION_DECISIONS_TABLE
    ]) {
      expect(await rows(table)).toEqual([]);
    }
  });
});
