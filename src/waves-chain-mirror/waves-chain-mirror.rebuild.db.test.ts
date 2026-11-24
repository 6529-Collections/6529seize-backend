// The mirror's rebuild against the live mirror: the same chain index, the
// same rows, but for the columns the run's clock or an auto-increment
// stamps; and nothing outside the mirror's rows.
import 'reflect-metadata';
import * as mysql from 'mysql';
import { rawCidHexOf } from '@/chain-gateway/chain-gateway.client';
import {
  ACTIVITY_EVENTS_TABLE,
  ADDRESS_CONSOLIDATION_KEY,
  CHAIN_DOCS_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  MEME_COLLABORATION_INVITATIONS_TABLE,
  MEME_COLLABORATIONS_TABLE,
  PROFILE_GROUP_CHANGES,
  PROFILE_GROUPS_TABLE,
  PROFILE_LATEST_LOG_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  PROFILES_TABLE,
  USER_GROUPS_TABLE,
  WAVES_CHAIN_MIRROR_DECISIONS_TABLE,
  WAVES_CHAIN_MIRROR_EVENTS_TABLE,
  WAVES_CHAIN_MIRROR_GROUPS_TABLE,
  WAVES_CHAIN_MIRROR_WAVES_TABLE,
  WAVES_METADATA_TABLE,
  WAVES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  clearMirrorTables,
  ensurePrincipalMap,
  mapPrincipals,
  seedChainDecision,
  seedImportedCompetition
} from '@/tests/fixtures/waves-chain-mirror.db.fixture';
import { entryManifestDoc } from '@/tests/fixtures/waves-chain-mirror.fixture';
import {
  aChainGroupRow,
  aChainWaveRow,
  aDecisionConfig,
  aDecisionDoc,
  aWaveDoc,
  chainWord,
  FIRST_RESULT
} from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import { ChainObject } from '@/waves-chain-index/waves-chain-index.api';
import {
  EMPTY_INDEX_STATE,
  WavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import {
  ChainEvent,
  UNKNOWN_SCAN
} from '@/waves-chain-index/waves-chain-index.events';
import {
  decisionRow,
  groupRow,
  waveRow
} from '@/waves-chain-index/waves-chain-index.rows';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { DOC_CLASS, docCommitment } from './waves-chain-mirror.docs';
import { WavesChainObjectsMirror } from './waves-chain-mirror.objects';
import { WavesChainObjectsDb } from './waves-chain-mirror.objects.db';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
import { rebuildWavesChainMirror } from './waves-chain-mirror.rebuild';
import { WavesChainMirror } from './waves-chain-mirror.service';

const NOW = 1_765_000_000_000;
const T = 1_764_000_000_000;
const P1 = chainWord('11');
const V1 = chainWord('b1');
const V2 = chainWord('b2');
const UNMAPPED = chainWord('b9');
const G = chainWord('0a');
const W = chainWord('0b');
const D = chainWord('d1');
const IMPORTED = chainWord('d2');
const E1 = chainWord('e1');
const E2 = chainWord('e2');
/** An artwork entered on the chain: 6529.io records its collaboration. */
const ART = chainWord('e8');
const ZERO = chainWord('00');
const WAVE = '00000000-0000-4000-8000-0000000000a0';
const DROP1 = '00000000-0000-4000-8000-0000000000c1';
const DROP2 = '00000000-0000-4000-8000-0000000000c2';
const NONCE = `0x${'5a'.repeat(16)}`;
/** A group's listed address with no profile: 6529.io makes its identity. */
const ADDRESS = `0x${'a2'.repeat(20)}`;

/** The rows the mirror owns, compared table by table. */
const MIRRORED = [
  WAVES_TABLE,
  WAVES_METADATA_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  USER_GROUPS_TABLE,
  PROFILE_GROUPS_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  WAVES_CHAIN_MIRROR_GROUPS_TABLE,
  WAVES_CHAIN_MIRROR_WAVES_TABLE,
  WAVES_CHAIN_MIRROR_DECISIONS_TABLE,
  WAVES_CHAIN_MIRROR_EVENTS_TABLE,
  CHAIN_DOCS_TABLE
];

/**
 * Columns the run's clock stamps (the live mirror's wall clock, a
 * rebuild's chain time) or an auto-increment gives: the same in two
 * rebuilds, not between a rebuild and the live mirror.
 */
const VOLATILE: Record<string, readonly string[]> = {
  [WAVES_TABLE]: ['serial_no'],
  [WAVES_METADATA_TABLE]: ['id'],
  [DROPS_TABLE]: ['serial_no'],
  [COMPETITIONS_TABLE]: [
    'updated_at',
    'published_at',
    'ended_at',
    'archived_at'
  ],
  [COMPETITION_CONFIG_VERSIONS_TABLE]: ['created_at'],
  [COMPETITION_OUTCOMES_TABLE]: ['created_at'],
  [COMPETITION_LIFECYCLE_EVENTS_TABLE]: ['created_at'],
  [COMPETITION_VOTES_TABLE]: ['updated_at'],
  [COMPETITION_LEADERBOARD_ENTRIES_TABLE]: ['updated_at', 'published_at'],
  [COMPETITION_ENTRY_RUNTIME_TABLE]: ['updated_at'],
  [COMPETITION_VOTE_HISTORY_TABLE]: ['id', 'sequence'],
  [COMPETITION_SCORE_HISTORY_TABLE]: ['sequence', 'mutation_sequence'],
  [WAVES_CHAIN_MIRROR_GROUPS_TABLE]: ['updated_at'],
  [WAVES_CHAIN_MIRROR_WAVES_TABLE]: ['updated_at'],
  [WAVES_CHAIN_MIRROR_DECISIONS_TABLE]: ['updated_at'],
  [WAVES_CHAIN_MIRROR_EVENTS_TABLE]: ['applied_at'],
  [CHAIN_DOCS_TABLE]: ['first_seen']
};

/** Tables outside the mirror's rows: a rebuild writes none of them. */
const OTHERS = [
  COMPETITION_OUTBOX_TABLE,
  ACTIVITY_EVENTS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_GROUP_CHANGES,
  PROFILES_ACTIVITY_LOGS_TABLE,
  PROFILE_LATEST_LOG_TABLE,
  IDENTITIES_TABLE,
  ADDRESS_CONSOLIDATION_KEY,
  MEME_COLLABORATIONS_TABLE,
  MEME_COLLABORATION_INVITATIONS_TABLE
];

/** The rows the live mirror made for the listed address. */
async function addressIdentityRows() {
  return {
    [IDENTITIES_TABLE]: await sqlExecutor.execute<Record<string, unknown>>(
      `select * from ${IDENTITIES_TABLE} where primary_address = :address`,
      { address: ADDRESS }
    ),
    [ADDRESS_CONSOLIDATION_KEY]: await sqlExecutor.execute<
      Record<string, unknown>
    >(`select * from ${ADDRESS_CONSOLIDATION_KEY} where address = :address`, {
      address: ADDRESS
    })
  };
}

/** Puts them back, as the identity area's rebuild would before the mirror's. */
async function restoreRows(rows: Record<string, Record<string, unknown>[]>) {
  for (const [table, list] of Object.entries(rows)) {
    for (const row of list) {
      const columns = Object.keys(row);
      await sqlExecutor.execute(
        `insert into ${mysql.escapeId(table)}
           (${columns.map((c) => mysql.escapeId(c)).join(', ')})
         values (${columns.map((c) => `:${c}`).join(', ')})`,
        row
      );
    }
  }
}

async function dump(
  volatile: Record<string, readonly string[]>
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of MIRRORED) {
    const rows = await sqlExecutor.execute<Record<string, unknown>>(
      `select * from ${mysql.escapeId(table)}`
    );
    out[table] = rows
      .map((row) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(row)
              .filter(([key]) => !(volatile[table] ?? []).includes(key))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('hex') : v])
          )
        )
      )
      .sort();
  }
  return out;
}

async function counts(tables: readonly string[]) {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await sqlExecutor.execute<{ n: number }>(
      `select count(*) as n from ${mysql.escapeId(table)}`
    );
    out[table] = Number(row.n);
  }
  return out;
}

const bytesOf = (doc: unknown) => Buffer.from(`${JSON.stringify(doc)}\n`);

const anEvent = (
  height: number,
  fields: Partial<ChainEvent> & Pick<ChainEvent, 'kind'>
): ChainEvent => ({
  height,
  seq: 0,
  blockTime: T + height * 1000,
  origin: 'OPERATION',
  waveId: null,
  waveLegacyId: null,
  decisionId: null,
  decisionLegacyId: null,
  entryId: null,
  entryLegacyId: null,
  pollId: null,
  pollLegacyId: null,
  groupId: null,
  groupLegacyId: null,
  actor: P1,
  data: {},
  ...fields
});

describe("the mirror's rebuild", () => {
  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);
  const stamp = { height: 20, generation: 1 };

  /** A chain-made group, wave and decision, and an imported decision. */
  async function seedWorld() {
    await clearMirrorTables(sqlExecutor);
    await sqlExecutor.execute(`delete from ${PROFILES_TABLE}`);
    await sqlExecutor.execute(`delete from ${PROFILE_GROUP_CHANGES}`);
    for (const table of [
      MEME_COLLABORATION_INVITATIONS_TABLE,
      MEME_COLLABORATIONS_TABLE
    ]) {
      await sqlExecutor.execute(`delete from ${table}`);
    }
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, {
      [P1]: 'profile-1',
      [V1]: 'profile-v1',
      [V2]: 'profile-v2'
    });
    const wallet = `0x${'1f'.repeat(20)}`;
    await sqlExecutor.execute(
      `insert into ${IDENTITIES_TABLE}
         (profile_id, consolidation_key, primary_address, handle,
          normalised_handle, tdh, rep, cic, level_raw)
       values ('profile-1', :w, :w, 'creatorone', 'creatorone', 0, 0, 0, 0)`,
      { w: wallet }
    );
    await sqlExecutor.execute(
      `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
       values (:w, :w)`,
      { w: wallet }
    );
    await sqlExecutor.execute(
      `insert into ${PROFILES_TABLE}
         (external_id, handle, normalised_handle, primary_wallet, created_at,
          created_by_wallet, classification)
       values ('profile-1', 'creatorone', 'creatorone', :w, now(), :w,
          'PSEUDONYM')`,
      { w: wallet }
    );

    // Made on the chain: a group, a public wave and a decision in it.
    const group = aChainGroupRow(
      G,
      {
        includes: [
          { kind: 'principal', value: P1 },
          { kind: 'address', value: ADDRESS }
        ]
      },
      { controller: P1 }
    );
    await index.upsert(
      'groups',
      [groupRow({ ...(group.data as ChainObject), legacyId: null })],
      stamp
    );
    const waveDoc = bytesOf(aWaveDoc());
    await db.saveDocument(rawCidHexOf(waveDoc), DOC_CLASS.WAVE, waveDoc);
    const wave = aChainWaveRow(W, { metadataCid: rawCidHexOf(waveDoc) });
    await index.upsert(
      'waves',
      [
        waveRow({
          ...(wave.data as ChainObject),
          legacyId: null,
          origin: 'native',
          status: 'open',
          readGroup: { groupId: ZERO },
          postGroup: { groupId: ZERO },
          adminGroup: { groupId: ZERO }
        })
      ],
      stamp
    );
    const template = bytesOf({
      v: 1,
      kind: 'outcomes',
      decision: null,
      outcomes: [
        {
          type: 'MANUAL',
          description: 'A prize',
          distribution: [{ amount: null, description: 'First place' }]
        }
      ],
      nonce: NONCE
    });
    await db.saveDocument(
      rawCidHexOf(template),
      DOC_CLASS.OUTCOME_TEMPLATE,
      template
    );
    const doc = bytesOf(
      aDecisionDoc({ outcome_template_cid: rawCidHexOf(template) })
    );
    await db.saveDocument(rawCidHexOf(doc), DOC_CLASS.DECISION, doc);
    await index.upsert(
      'decisions',
      [
        decisionRow({
          decisionId: D,
          legacyId: null,
          waveId: W,
          configVersion: 1,
          status: 'published',
          kind: 'rank',
          origin: 'native',
          counted: true,
          nextResultTime: FIRST_RESULT,
          metadataCid: rawCidHexOf(doc),
          submitGroup: { groupId: G, version: 1 },
          voteGroup: { groupId: ZERO, version: 0 },
          config: aDecisionConfig({
            outcomeTemplateHash: docCommitment(
              DOC_CLASS.OUTCOME_TEMPLATE,
              `${NONCE}${'00'.repeat(16)}`,
              template
            )
          })
        })
      ],
      { height: 30, generation: 1 }
    );

    // Imported: a decision with two entries, votes and their history.
    const { competitionId } = await seedImportedCompetition(sqlExecutor, {
      waveId: WAVE,
      authorId: 'profile-author',
      dropIds: [DROP1, DROP2],
      timeLockMs: 3_600_000
    });
    const entry = (id: string, drop: string, total: string) => ({
      entryId: id,
      legacyId: drop,
      decisionId: IMPORTED,
      author: V1,
      status: 'active',
      total,
      origin: 'legacy',
      lastIncrease: { time: T + 50_000, height: 50, index: 0 },
      createdMs: 1
    });
    // The designated Main Stage: an artwork entered in it gets 6529.io's
    // collaboration record.
    await sqlExecutor.execute(
      `insert into ${COMPETITION_CAPABILITIES_TABLE}
         (capability, competition_id, wave_id, assigned_by,
          legacy_source_wave_id, assigned_at)
       values ('MAIN_STAGE', :competitionId, :waveId, null, null, 1)`,
      { competitionId, waveId: WAVE }
    );
    const artwork = entryManifestDoc({
      nonce: `0x${'6c'.repeat(16)}`,
      decision: IMPORTED,
      wave: chainWord('a0'),
      author: P1,
      createdAt: T + 40_000,
      fields: {
        wave_id: WAVE,
        drop_type: 'PARTICIPATORY',
        title: 'A new card',
        parts: [
          {
            content: 'The work',
            media: [
              { url: 'https://media.example/w.png', mime_type: 'image/png' }
            ]
          }
        ],
        metadata: [{ data_key: 'memeName', data_value: 'A new card' }],
        referenced_nfts: [],
        mentioned_users: [],
        mentioned_waves: []
      }
    });
    await db.saveDocument(
      artwork.contentCid,
      DOC_CLASS.ENTRY_MANIFEST,
      artwork.bytes
    );
    await seedChainDecision(
      index,
      {
        decision: {
          decisionId: IMPORTED,
          legacyId: competitionId,
          waveId: chainWord('a0'),
          status: 'published',
          kind: 'rank',
          origin: 'legacy',
          counted: true,
          nextResultTime: 0
        },
        entries: [
          entry(E1, DROP1, '40'),
          entry(E2, DROP2, '9'),
          {
            entryId: ART,
            legacyId: null,
            decisionId: IMPORTED,
            author: P1,
            status: 'active',
            total: '0',
            origin: 'native',
            manifestHash: artwork.manifestHash,
            contentCid: artwork.contentCid,
            createdMs: T + 40_000
          }
        ],
        votes: [
          {
            decisionId: IMPORTED,
            entryId: E1,
            voter: V1,
            value: '40',
            updatedHeight: 50
          },
          {
            decisionId: IMPORTED,
            entryId: E2,
            voter: V2,
            value: '7',
            updatedHeight: 51
          },
          {
            decisionId: IMPORTED,
            entryId: E2,
            voter: UNMAPPED,
            value: '2',
            updatedHeight: 52
          }
        ],
        leaderboard: {
          decisionId: IMPORTED,
          by: 'time_weighted_score',
          scoredAt: T + 60_000,
          rows: [
            {
              rank: 1,
              entryId: E1,
              legacyId: DROP1,
              score: '35',
              total: '40',
              lastIncrease: { time: T + 50_000 }
            },
            {
              rank: 2,
              entryId: E2,
              legacyId: DROP2,
              score: '6',
              total: '9',
              lastIncrease: { time: T + 52_000 }
            }
          ]
        }
      },
      60
    );
    await index.writeEvents(
      [
        anEvent(18, { kind: 'GROUP_CREATED', groupId: G }),
        anEvent(19, { kind: 'WAVE_CREATED', waveId: W }),
        ...[50, 51, 52].map((height) =>
          anEvent(height, {
            kind: 'VOTE',
            decisionId: IMPORTED,
            decisionLegacyId: competitionId,
            entryId: height === 50 ? E1 : E2,
            actor: height === 50 ? V1 : height === 51 ? V2 : UNMAPPED,
            data:
              height === 50
                ? { oldValue: '0', newValue: '40', entryTotalAfter: '40' }
                : height === 51
                  ? { oldValue: '0', newValue: '7', entryTotalAfter: '7' }
                  : { oldValue: '0', newValue: '2', entryTotalAfter: '9' }
          })
        )
      ],
      61,
      UNKNOWN_SCAN
    );
    await index.saveState(
      {
        ...EMPTY_INDEX_STATE,
        generation: 1,
        lastFullAt: 1,
        feedNext: 61,
        network: 'net-1'
      },
      1
    );
  }

  async function liveRun() {
    const objects = new WavesChainObjectsMirror(
      new WavesChainObjectsDb(() => sqlExecutor),
      (ids) => db.profilesOfPrincipals(ids),
      defaultObjectEffects,
      { check: jest.fn().mockResolvedValue({ kind: 'allowed' }) },
      () => NOW
    );
    const settings = {
      write: true,
      frozen: true,
      keepMainStage: false,
      mainStageWaveId: null
    };
    for (let run = 0; run < 3; run++) {
      await new WavesChainMirror(
        db,
        index,
        () => settings,
        () => NOW + run * 60_000,
        undefined,
        { check: jest.fn().mockResolvedValue({ kind: 'allowed' }) },
        undefined,
        async () => null,
        { run: (input) => objects.run(input) }
      ).run({ budgetMs: 60_000 });
    }
  }

  it('gives the rows the live mirror gives, from the same index, and writes nothing else', async () => {
    await seedWorld();
    await liveRun();
    const live = await dump(VOLATILE);
    // The world is mirrored: both decisions, the wave and its group.
    expect(live[COMPETITIONS_TABLE]).toHaveLength(2);
    expect(live[COMPETITION_VOTE_HISTORY_TABLE]).toHaveLength(2);
    expect(live[COMPETITION_SCORE_HISTORY_TABLE].length).toBeGreaterThan(0);
    expect(live[WAVES_CHAIN_MIRROR_WAVES_TABLE]).toHaveLength(1);
    expect(
      (await counts([COMPETITION_OUTBOX_TABLE]))[COMPETITION_OUTBOX_TABLE]
    ).toBeGreaterThan(0);
    // The artwork entered on the chain, with its collaboration record.
    expect(
      live[COMPETITION_ENTRIES_TABLE].filter((row) => row.includes(ART))
    ).toHaveLength(1);
    expect(
      (await counts([MEME_COLLABORATIONS_TABLE]))[MEME_COLLABORATIONS_TABLE]
    ).toBe(1);
    const identity = await addressIdentityRows();
    expect(identity[IDENTITIES_TABLE]).toHaveLength(1);
    // The group lists the creator and the address's new identity.
    expect(live[PROFILE_GROUPS_TABLE]).toHaveLength(2);

    await seedWorld();
    await restoreRows(identity);
    const before = await counts(OTHERS);
    const rebuilt = await rebuildWavesChainMirror({}, () => sqlExecutor, {});
    // The chain's time: the newest block the index's log holds.
    expect(rebuilt.at).toBe(T + 52 * 1000);
    expect(await dump(VOLATILE)).toEqual(live);
    expect(await counts(OTHERS)).toEqual(before);
    const first = await dump({});

    // Twice from the same index: the same rows, times included.
    await seedWorld();
    await restoreRows(identity);
    await rebuildWavesChainMirror({}, () => sqlExecutor, {});
    const autoIncrements: Record<string, readonly string[]> = {
      [WAVES_TABLE]: ['serial_no'],
      [WAVES_METADATA_TABLE]: ['id'],
      [DROPS_TABLE]: ['serial_no'],
      [COMPETITION_VOTE_HISTORY_TABLE]: ['id', 'sequence'],
      [COMPETITION_SCORE_HISTORY_TABLE]: ['sequence', 'mutation_sequence'],
      [CHAIN_DOCS_TABLE]: VOLATILE[CHAIN_DOCS_TABLE]
    };
    const strip = (rows: Record<string, string[]>) =>
      Object.fromEntries(
        Object.entries(rows).map(([table, list]) => [
          table,
          list
            .map((json) =>
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(JSON.parse(json)).filter(
                    ([key]) => !(autoIncrements[table] ?? []).includes(key)
                  )
                )
              )
            )
            .sort()
        ])
      );
    expect(strip(await dump({}))).toEqual(strip(first));
  });
});
