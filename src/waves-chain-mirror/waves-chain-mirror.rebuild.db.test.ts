// The mirror's rebuild against the live mirror: the same chain index, the
// same rows, but for the columns the run's clock or an auto-increment
// stamps; and nothing outside the mirror's rows.
import 'reflect-metadata';
import * as fs from 'fs';
import * as mysql from 'mysql';
import * as os from 'os';
import * as path from 'path';
import {
  ChainGatewayClient,
  cidPath,
  rawCidHexOf
} from '@/chain-gateway/chain-gateway.client';
import {
  ACTIVITY_EVENTS_TABLE,
  ADDRESS_CONSOLIDATION_KEY,
  CHAIN_DOCS_TABLE,
  CHAIN_ENTRY_HOLDS_TABLE,
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
  WAVES_CHAIN_MIRROR_STATE_TABLE,
  WAVES_CHAIN_MIRROR_WAVES_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_METADATA_TABLE,
  WAVES_TABLE
} from '@/constants';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import {
  clearMirrorTables,
  ensurePrincipalMap,
  identityMirrorAt,
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
import { GateVerdict } from './waves-chain-mirror.gate';
import { groupRowOf, NO_CRITERIA } from './waves-chain-mirror.groups';
import {
  groupShortIdOf,
  waveDescriptionDropId
} from './waves-chain-mirror.ids';
import { WavesChainObjectsMirror } from './waves-chain-mirror.objects';
import { WavesChainObjectsDb } from './waves-chain-mirror.objects.db';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
import {
  rebuildWavesChainMirror,
  seedWavesChainMirror
} from './waves-chain-mirror.rebuild';
import { WavesChainMirror } from './waves-chain-mirror.service';

const NOW = 1_765_000_000_000;
const T = 1_764_000_000_000;
const P1 = chainWord('11');
const V1 = chainWord('b1');
const V2 = chainWord('b2');
const UNMAPPED = chainWord('b9');
const G = chainWord('0a');
const W = chainWord('0b');
/** A subwave of W made on the chain by V1 (seedWorld's `subwave`). */
const SUBWAVE = chainWord('5c');
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
/** Made-up legacy ids with a version digit of 0, which uuid v5 refuses. */
const BAD_WAVE = chainWord('0f');
const BAD_DECISION = chainWord('df');
const BAD_LEGACY = '00000000-5662-01f5-4000-8000000001f5';
/** A group's listed address with no profile: 6529.io makes its identity. */
const ADDRESS = `0x${'a2'.repeat(20)}`;

/**
 * The run's files source: the world's documents in a folder, each named by
 * its CID as the files source names it.
 */
const FILES = 'http://files.example/run';
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-mirror-files-'));
const filesFetch = jest.fn(async (url: string | URL | Request) => {
  const file = path.join(filesDir, String(url).slice(FILES.length + 1));
  return fs.existsSync(file)
    ? new Response(fs.readFileSync(file))
    : new Response(null, { status: 404 });
});
/** The run's gateway source, as CHAIN_GATEWAY_URL names it. */
const GATEWAY = 'http://gateway.example/run';
const rebuildCtx = { sources: { files: FILES, gateway: GATEWAY } };
const rebuild = () =>
  rebuildWavesChainMirror(
    rebuildCtx,
    () => sqlExecutor,
    { CHAIN_GATEWAY_URL: GATEWAY },
    {
      fetchImpl: filesFetch as unknown as typeof fetch
    }
  );

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

/**
 * Tables outside the mirror's rows: a rebuild writes none of them (wave
 * metrics are recomputed from drops after it).
 */
const OTHERS = [
  WAVE_METRICS_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
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

  afterAll(() => fs.rmSync(filesDir, { recursive: true, force: true }));

  /**
   * A document of the world: in chain_docs for the live mirror (as the
   * gateway's store gave it), and in the run's files source.
   */
  async function saveDocument(
    cid: string,
    docClass: number,
    bytes: Uint8Array
  ) {
    await db.saveDocument(cid, docClass, bytes);
    fs.writeFileSync(path.join(filesDir, cidPath(cid)), bytes);
  }

  /** The rebuild's start: chain_docs is the mirror's, made again. */
  async function forgetDocuments() {
    await sqlExecutor.execute(`delete from ${CHAIN_DOCS_TABLE}`);
  }

  /** An imported wave and decision with legacy ids uuid v5 refuses. */
  async function seedBadLegacyIds(
    entry: (id: string, drop: string, total: string) => ChainObject
  ) {
    const badWave = aChainWaveRow(BAD_WAVE, {
      origin: 'legacy',
      legacyId: BAD_LEGACY,
      policyVersion: 2
    });
    await index.upsert(
      'waves',
      [
        waveRow({
          ...(badWave.data as ChainObject),
          legacyId: BAD_LEGACY,
          origin: 'legacy',
          status: 'open',
          readGroup: { groupId: ZERO },
          postGroup: { groupId: ZERO },
          adminGroup: { groupId: ZERO }
        })
      ],
      stamp
    );
    await seedChainDecision(
      index,
      {
        decision: {
          decisionId: BAD_DECISION,
          legacyId: BAD_LEGACY,
          waveId: BAD_WAVE,
          status: 'published',
          kind: 'rank',
          origin: 'legacy',
          counted: true,
          nextResultTime: 0
        },
        entries: [entry(chainWord('ef'), DROP1, '1')].map((e) => ({
          ...e,
          decisionId: BAD_DECISION
        }))
      },
      60
    );
  }

  /**
   * A chain-made group, wave and decision, and an imported decision; with
   * `badLegacyIds`, an imported wave and decision whose legacy ids aren't
   * RFC 4122 UUIDs too.
   */
  async function seedWorld({ badLegacyIds = false, subwave = false } = {}) {
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
    // The identity mirror, live and rebuilt, stands past every height here.
    await identityMirrorAt(sqlExecutor, 1_000_000);
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
    await saveDocument(rawCidHexOf(waveDoc), DOC_CLASS.WAVE, waveDoc);
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
    await saveDocument(
      rawCidHexOf(template),
      DOC_CLASS.OUTCOME_TEMPLATE,
      template
    );
    const doc = bytesOf(
      aDecisionDoc({ outcome_template_cid: rawCidHexOf(template) })
    );
    await saveDocument(rawCidHexOf(doc), DOC_CLASS.DECISION, doc);
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
    await saveDocument(
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
    if (badLegacyIds) await seedBadLegacyIds(entry);
    if (subwave) {
      // V1 makes a subwave of W: V1 is neither W's creator nor in a group
      // of 6529.io's, so 6529.io's own eligibility would leave W out.
      const doc = bytesOf(aWaveDoc({ name: 'A subwave', parent_wave: W }));
      await saveDocument(rawCidHexOf(doc), DOC_CLASS.WAVE, doc);
      const child = aChainWaveRow(SUBWAVE, {
        controller: V1,
        metadataCid: rawCidHexOf(doc)
      });
      await index.upsert(
        'waves',
        [
          waveRow({
            ...(child.data as ChainObject),
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
    }
    await index.writeEvents(
      [
        anEvent(18, { kind: 'GROUP_CREATED', groupId: G }),
        anEvent(19, { kind: 'WAVE_CREATED', waveId: W }),
        ...(subwave
          ? [anEvent(20, { kind: 'WAVE_CREATED', waveId: SUBWAVE, actor: V1 })]
          : []),
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

  /** The live mirror; moderation gives the wave's description a verdict. */
  async function liveRun(
    description: GateVerdict = { kind: 'allowed' },
    supplier: () => typeof sqlExecutor = () => sqlExecutor
  ) {
    const objects = new WavesChainObjectsMirror(
      new WavesChainObjectsDb(supplier),
      (ids) => db.profilesOfPrincipals(ids),
      defaultObjectEffects,
      {
        check: jest.fn(
          async ({ dropId }: { dropId: string }): Promise<GateVerdict> =>
            dropId === waveDescriptionDropId(W)
              ? description
              : { kind: 'allowed' }
        )
      },
      () => NOW
    );
    const settings = {
      write: true,
      frozen: true,
      keepMainStage: false,
      mainStageWaveId: null
    };
    const reports = [];
    for (let run = 0; run < 3; run++) {
      const report = await new WavesChainMirror(
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
      reports.push(report);
    }
    return reports;
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
    // The live mirror's drops (the wave's description, the artwork) move
    // 6529.io's wave metrics, as a drop's create does.
    const liveMetrics = await counts([
      WAVE_METRICS_TABLE,
      WAVE_DROPPER_METRICS_TABLE
    ]);
    expect(liveMetrics[WAVE_METRICS_TABLE]).toBeGreaterThan(0);
    expect(liveMetrics[WAVE_DROPPER_METRICS_TABLE]).toBeGreaterThan(0);
    // The group lists the creator and the address's new identity.
    expect(live[PROFILE_GROUPS_TABLE]).toHaveLength(2);

    await seedWorld();
    await restoreRows(identity);
    await forgetDocuments();
    // A metrics row there before the rebuild stays as it is.
    await sqlExecutor.execute(
      `insert into ${WAVE_METRICS_TABLE}
         (wave_id, drops_count, subscribers_count, participatory_drops_count,
          latest_drop_timestamp)
       values (:w, 7, 0, 0, 1)`,
      { w: W }
    );
    const metricsBefore = await sqlExecutor.execute(
      `select * from ${WAVE_METRICS_TABLE}`
    );
    const before = await counts(OTHERS);
    const gatewayDocs = jest.spyOn(ChainGatewayClient.prototype, 'getDocument');
    filesFetch.mockClear();
    const rebuilt = await rebuild();
    // The chain's time: the newest block the index's log holds.
    expect(rebuilt.at).toBe(T + 52 * 1000);
    expect(await dump(VOLATILE)).toEqual(live);
    expect(await counts(OTHERS)).toEqual(before);
    expect(
      await sqlExecutor.execute(`select * from ${WAVE_METRICS_TABLE}`)
    ).toEqual(metricsBefore);
    // Every document from the files source, none from the gateway's store.
    expect(rebuilt.missingDocuments).toBe(0);
    expect(rebuilt.last.invalidLegacyIds).toBe(0);
    expect(filesFetch).toHaveBeenCalledTimes(4);
    expect(gatewayDocs).not.toHaveBeenCalled();
    gatewayDocs.mockRestore();
    const first = await dump({});

    // Twice from the same index: the same rows, times included.
    await seedWorld();
    await restoreRows(identity);
    await forgetDocuments();
    await rebuild();
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

    // The seed is the rebuild's own run: the same rows.
    await seedWorld();
    await restoreRows(identity);
    await forgetDocuments();
    await seedWavesChainMirror(
      rebuildCtx,
      () => sqlExecutor,
      {
        CHAIN_GATEWAY_URL: GATEWAY
      },
      { fetchImpl: filesFetch as unknown as typeof fetch }
    );
    expect(strip(await dump({}))).toEqual(strip(first));
  });

  it('writes no content for a description the live mirror refused, and leaves its hold as it is', async () => {
    await seedWorld();
    await liveRun({ kind: 'refused', code: 'REJECTED' });
    const live = await dump(VOLATILE);
    const holds = await sqlExecutor.execute<Record<string, unknown>>(
      `select * from ${CHAIN_ENTRY_HOLDS_TABLE}`
    );
    expect(holds).toEqual([
      expect.objectContaining({
        entry_id: waveDescriptionDropId(W),
        competition_id: '',
        reason: 'description_moderation',
        retry_at: null
      })
    ]);
    const description = () =>
      sqlExecutor.execute(
        `select content from ${DROPS_PARTS_TABLE} where drop_id = :dropId`,
        { dropId: waveDescriptionDropId(W) }
      );
    expect(await description()).toEqual([{ content: null }]);
    const identity = await addressIdentityRows();

    // The rebuild's world: the index, the identities and the kept holds.
    await seedWorld();
    await restoreRows({ ...identity, [CHAIN_ENTRY_HOLDS_TABLE]: holds });
    await forgetDocuments();
    await rebuild();
    expect(await dump(VOLATILE)).toEqual(live);
    expect(await description()).toEqual([{ content: null }]);
    expect(
      await sqlExecutor.execute(`select * from ${CHAIN_ENTRY_HOLDS_TABLE}`)
    ).toEqual(holds);
  });

  it('leaves an object waiting for a document the files source lacks, counted, and asks no one else', async () => {
    await seedWorld();
    await forgetDocuments();
    const waveDoc = cidPath(rawCidHexOf(bytesOf(aWaveDoc())));
    fs.renameSync(
      path.join(filesDir, waveDoc),
      path.join(filesDir, `${waveDoc}.away`)
    );
    const gatewayDocs = jest.spyOn(ChainGatewayClient.prototype, 'getDocument');
    try {
      const rebuilt = await rebuild();
      expect(rebuilt.missingDocuments).toBe(1);
      expect(rebuilt.last.objects?.waves).toMatchObject({
        mirrored: 0,
        failed: 0
      });
      // The wave waits for its document, and its decision for the wave.
      expect(rebuilt.last.waiting).toMatchObject({
        wave_held_wave_document_missing: 1,
        decision_wave_not_mirrored: 1
      });
      expect(
        await sqlExecutor.execute(
          `select 1 from ${WAVES_TABLE} where id = :w`,
          {
            w: W
          }
        )
      ).toEqual([]);
      expect(gatewayDocs).not.toHaveBeenCalled();
    } finally {
      gatewayDocs.mockRestore();
      fs.renameSync(
        path.join(filesDir, `${waveDoc}.away`),
        path.join(filesDir, waveDoc)
      );
    }
  });

  describe("an imported group's own lists", () => {
    const LEGACY = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6b';
    const ID = `readers-${groupShortIdOf(LEGACY)}`;

    /** 6529.io's imported group listing a profile the chain doesn't. */
    async function seedImported() {
      await seedWorld();
      await forgetDocuments();
      await new UserGroupsDb(() => sqlExecutor).save(
        groupRowOf({
          id: ID,
          name: 'Readers',
          createdAt: new Date(T),
          createdBy: 'profile-1',
          criteria: NO_CRITERIA,
          repUser: null,
          includeListId: 'readers-include',
          excludeListId: null,
          visible: true,
          isPrivate: false
        }),
        undefined as never
      );
      await sqlExecutor.execute(
        `insert into ${PROFILE_GROUPS_TABLE} (profile_group_id, profile_id)
         values ('readers-include', 'profile-only-here')`
      );
      // The chain's version 1 of it lists the world's address.
      const row = aChainGroupRow(
        chainWord('1e'),
        { includes: [{ kind: 'address', value: ADDRESS }] },
        { origin: 'legacy', legacyId: LEGACY, controller: P1 }
      );
      await index.upsert(
        'groups',
        [groupRow({ ...(row.data as ChainObject), legacyId: LEGACY })],
        stamp
      );
    }
    const listed = async () =>
      (
        await sqlExecutor.execute<{ profile_id: string }>(
          `select profile_id from ${PROFILE_GROUPS_TABLE}
            where profile_group_id = 'readers-include'`
        )
      ).map((r) => r.profile_id);
    const rebuildUnder = (cap: string | null) =>
      rebuildWavesChainMirror(
        rebuildCtx,
        () => sqlExecutor,
        {
          CHAIN_GATEWAY_URL: GATEWAY,
          ...(cap === null
            ? {}
            : { WAVES_CHAIN_MIRROR_IMPORTED_REMAP_CAP: cap })
        },
        { fetchImpl: filesFetch as unknown as typeof fetch }
      );

    it("brings them to the chain's members under a cap they fit, naming nothing", async () => {
      await seedImported();
      const rebuilt = await rebuildUnder(null);
      expect(rebuilt.importedListsCapped).toBeNull();
      expect(rebuilt.last.objects?.remap.imported).toMatchObject({
        capped: false,
        pending: 0
      });
      const [address] = await sqlExecutor.execute<{ profile_id: string }>(
        `select i.profile_id from ${IDENTITIES_TABLE} i
           join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = i.consolidation_key
          where a.address = :address`,
        { address: ADDRESS }
      );
      expect(await listed()).toEqual([address.profile_id]);
    });

    it('names the difference when the cap held them, so it is never read as drift', async () => {
      await seedImported();
      const rebuilt = await rebuildUnder('0');
      expect(rebuilt.importedListsCapped).toBe(
        "[IMPORTED GROUP LISTS CAPPED] [GROUPS 1] [CAP 0] imported groups' member lists left as 6529.io holds them (WAVES_CHAIN_MIRROR_IMPORTED_REMAP_CAP): a mirror under a cap they fit holds them rewritten, a difference by the cap, not drift"
      );
      expect(await listed()).toEqual(['profile-only-here']);
    });
  });

  describe('when its groups and waves pass fails', () => {
    const STOPPED =
      "The mirror's rebuild had no groups and waves report in run 1: that pass failed. Its error is logged above ([WAVES CHAIN MIRROR] groups and waves failed); fix that, then run the rebuild again";
    const logs = () => ({
      warn: jest
        .spyOn(Logger.get('WAVES_CHAIN_MIRROR_REBUILD'), 'warn')
        .mockImplementation(() => undefined),
      error: jest
        .spyOn(Logger.get('WAVES_CHAIN_MIRROR_REBUILD'), 'error')
        .mockImplementation(() => undefined)
    });
    const lines = (spy: jest.SpyInstance) =>
      spy.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('groups and waves report'));

    it('stops, not done, at the first run without its report', async () => {
      await seedWorld();
      await forgetDocuments();
      // Only the first pass fails: the rebuild stops there all the same.
      const objects = jest
        .spyOn(WavesChainObjectsMirror.prototype, 'run')
        .mockRejectedValueOnce(new Error('groups and waves down'));
      const log = logs();
      try {
        const failure = await rebuild().then(
          () => null,
          (error: Error) => error.message
        );
        expect(failure).toBe(STOPPED);
        expect(objects).toHaveBeenCalledTimes(1);
        expect(lines(log.error)).toEqual([
          `[REBUILD RUN 1] [STOPPED] ${STOPPED}`
        ]);
        expect(lines(log.warn)).toEqual([]);
      } finally {
        objects.mockRestore();
        log.warn.mockRestore();
        log.error.mockRestore();
      }
    });
  });

  it("fails when its groups' member lists can't be read", async () => {
    await seedWorld();
    await forgetDocuments();
    const lists = jest
      .spyOn(WavesChainObjectsDb.prototype, 'groupListMembers')
      .mockRejectedValue(new Error('lists not read'));
    try {
      const failure = await rebuild().then(
        () => null,
        (error: Error) => error.message
      );
      expect(failure).toMatch(/^The mirror's rebuild left \d+ failure\(s\)/);
      expect(lists).toHaveBeenCalled();
    } finally {
      lists.mockRestore();
    }
  });

  it("rebuilds the rest past objects whose legacy ids aren't RFC 4122 UUIDs, then fails naming them; the live mirror only counts them", async () => {
    await seedWorld({ badLegacyIds: true });
    // Live, each run left them out, counted, and went on.
    const reports = await liveRun();
    expect(reports.map((r) => r.invalidLegacyIds)).toEqual([2, 2, 2]);
    expect(reports.map((r) => r.decisions.failed)).toEqual([0, 0, 0]);
    const live = await dump(VOLATILE);
    expect(live[COMPETITIONS_TABLE]).toHaveLength(2);
    const identity = await addressIdentityRows();

    await seedWorld({ badLegacyIds: true });
    await restoreRows(identity);
    await forgetDocuments();
    const failure = await rebuild().then(
      () => null,
      (error: Error) => error.message
    );
    expect(failure).toContain('left out 2 object(s)');
    expect(failure).toContain(`decision ${BAD_DECISION} (${BAD_LEGACY})`);
    expect(failure).toContain(`wave ${BAD_WAVE} (${BAD_LEGACY})`);
    // The whole pass was done first: the live mirror's rows.
    expect(await dump(VOLATILE)).toEqual(live);
  });

  it('runs the drop archives import first, and keeps its rows', async () => {
    await seedWorld();
    await forgetDocuments();
    const archived = '00000000-0000-4000-8000-0000000000f1';
    const importDropArchives = jest.fn(
      async (
        sources: { files: string; gateway: string },
        db: () => typeof sqlExecutor,
        _height: number | null
      ) => {
        // Nothing of the mirror's is written yet.
        const [state] = await db().execute<{ n: number }>(
          `select count(*) as n from ${WAVES_CHAIN_MIRROR_STATE_TABLE}`
        );
        const [waves] = await db().execute<{ n: number }>(
          `select count(*) as n from ${WAVES_TABLE} where id = :w`,
          { w: W }
        );
        expect([Number(state.n), Number(waves.n)]).toEqual([0, 0]);
        await db().execute(
          `insert into ${DROPS_TABLE}
             (id, wave_id, author_id, created_at, updated_at, title,
              parts_count, reply_to_drop_id, reply_to_part_id, drop_type,
              signature, hide_link_preview)
           values (:id, :wave, 'profile-1', 1, null, null, 1, null, null,
              'CHAT', null, false)`,
          { id: archived, wave: WAVE }
        );
        return { descriptionDropIds: new Map<string, string>() };
      }
    );
    const rebuilt = await rebuildWavesChainMirror(
      { ...rebuildCtx, mark: { chainHeight: 60 } },
      () => sqlExecutor,
      { CHAIN_GATEWAY_URL: GATEWAY },
      {
        fetchImpl: filesFetch as unknown as typeof fetch,
        importDropArchives
      }
    );
    expect(importDropArchives).toHaveBeenCalledTimes(1);
    // The run's sources, and its mark's height to read the import at.
    expect(importDropArchives.mock.calls[0][0]).toEqual({
      files: FILES,
      gateway: GATEWAY
    });
    expect(importDropArchives.mock.calls[0][2]).toBe(60);
    expect(rebuilt.dropArchives).toEqual({ descriptionDropIds: new Map() });
    expect(
      await sqlExecutor.execute(
        `select id from ${DROPS_TABLE} where id = :id`,
        {
          id: archived
        }
      )
    ).toEqual([{ id: archived }]);
  });

  it("keeps a subwave's parent by the chain's rights at the index's height, never 6529.io's eligibility", async () => {
    // The gateway's rights answer (in a run, the recording's at its mark);
    // every other read goes through as it would.
    const original = ChainGatewayClient.prototype.read;
    const rightsReads: string[] = [];
    let isManager: boolean | null = true;
    const read = jest
      .spyOn(ChainGatewayClient.prototype, 'read')
      .mockImplementation(function (
        this: ChainGatewayClient,
        ...args: Parameters<ChainGatewayClient['read']>
      ) {
        if (args[0].includes('/rights/')) {
          rightsReads.push(`${args[0]}@${args[2]?.height}`);
          // null: the node's not_found.
          return Promise.resolve(
            isManager === null ? null : ({ data: { isManager } } as never)
          );
        }
        return original.apply(this, args);
      });
    const eligibility = jest.spyOn(
      userGroupsService,
      'getGroupsUserIsEligibleFor'
    );
    try {
      for (const manager of [true, false]) {
        isManager = manager;
        await seedWorld({ subwave: true });
        await forgetDocuments();
        await rebuildWavesChainMirror(
          rebuildCtx,
          () => sqlExecutor,
          { CHAIN_GATEWAY_URL: GATEWAY },
          { fetchImpl: filesFetch as unknown as typeof fetch }
        );
        // profile-1's identity has TDH 0, and V1's profile has none: the
        // chain's answer alone decides.
        expect(
          await sqlExecutor.execute(
            `select parent_wave_id from ${WAVES_TABLE} where id = :id`,
            { id: SUBWAVE }
          )
        ).toEqual([{ parent_wave_id: manager ? W : null }]);
      }
      // A not_found: the subwave waits, counted, never written without its
      // parent.
      isManager = null;
      await seedWorld({ subwave: true });
      await forgetDocuments();
      const waited = await rebuildWavesChainMirror(
        rebuildCtx,
        () => sqlExecutor,
        { CHAIN_GATEWAY_URL: GATEWAY },
        { fetchImpl: filesFetch as unknown as typeof fetch }
      );
      expect(
        await sqlExecutor.execute(
          `select id from ${WAVES_TABLE} where id = :id`,
          { id: SUBWAVE }
        )
      ).toEqual([]);
      expect(waited.last.waiting).toMatchObject({
        wave_parent_rights_unavailable: 1
      });
      // The parent's chain id and the creator's principal, at the index's
      // read height (feedNext 61: height 60); 6529.io's eligibility never
      // asked.
      expect(new Set(rightsReads)).toEqual(
        new Set([`/v1/waves/${W}/rights/${V1}@60`])
      );
      expect(eligibility).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      eligibility.mockRestore();
    }
  });

  it('reads no wave_metrics in a rebuild, where the live mirror reads the hub with them', async () => {
    // Every statement through the executor a run is given.
    const recording = () => {
      const statements: string[] = [];
      const executor = new Proxy(sqlExecutor, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (typeof args[0] === 'string') statements.push(args[0]);
            return value.apply(target, args);
          };
        }
      });
      return { statements, supplier: () => executor };
    };
    const metrics = (statements: string[]) =>
      statements.filter((sql) => sql.includes(WAVE_METRICS_TABLE));
    await seedWorld();
    const live = recording();
    await liveRun({ kind: 'allowed' }, live.supplier);
    const liveReads = metrics(live.statements).filter((sql) =>
      /^\s*select/i.test(sql)
    );
    expect(liveReads.length).toBeGreaterThan(0);

    await seedWorld();
    await forgetDocuments();
    const rebuilt = recording();
    await rebuildWavesChainMirror(
      rebuildCtx,
      rebuilt.supplier,
      { CHAIN_GATEWAY_URL: GATEWAY },
      { fetchImpl: filesFetch as unknown as typeof fetch }
    );
    expect(rebuilt.statements.length).toBeGreaterThan(0);
    expect(metrics(rebuilt.statements)).toEqual([]);
  });

  it('fails on a document the files source gives wrong, rather than wait for it', async () => {
    await seedWorld();
    await forgetDocuments();
    const file = path.join(filesDir, cidPath(rawCidHexOf(bytesOf(aWaveDoc()))));
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from(' ')]));
    try {
      await expect(rebuild()).rejects.toThrow(
        'The files source failed for 1 document(s)'
      );
    } finally {
      fs.writeFileSync(file, bytes);
    }
  });

  it('needs the gateway source as CHAIN_GATEWAY_URL, and the files source', async () => {
    const step = { stepId: 'waves.mirror' };
    await expect(
      rebuildWavesChainMirror(
        { ...step, sources: { files: FILES } },
        () => sqlExecutor,
        { CHAIN_GATEWAY_URL: GATEWAY }
      )
    ).rejects.toThrow('waves.mirror reads the 6529 chain');
    await expect(
      rebuildWavesChainMirror(
        { ...step, sources: { files: FILES, gateway: GATEWAY } },
        () => sqlExecutor,
        { CHAIN_GATEWAY_URL: 'http://gateway.example/other' }
      )
    ).rejects.toThrow("CHAIN_GATEWAY_URL is not the run's gateway source");
    await expect(
      rebuildWavesChainMirror(
        { ...step, sources: { gateway: GATEWAY } },
        () => sqlExecutor,
        { CHAIN_GATEWAY_URL: `${GATEWAY}/` }
      )
    ).rejects.toThrow(
      "waves.mirror reads the chain's documents from the files source"
    );
  });
});
