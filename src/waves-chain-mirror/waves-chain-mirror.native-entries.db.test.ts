import 'reflect-metadata';
import { competitionRepository } from '@/competitions/competition.repository';
import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
import {
  CHAIN_ENTRIES_TABLE,
  CHAIN_ENTRY_HOLDS_TABLE,
  DELETED_DROPS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  clearMirrorTables,
  dumpTables,
  ensurePrincipalMap,
  mapPrincipals,
  seedChainDecision,
  seedImportedCompetition
} from '@/tests/fixtures/waves-chain-mirror.db.fixture';
import {
  chainId,
  entryManifestDoc
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import {
  EMPTY_INDEX_STATE,
  WavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { StoredDocuments } from './waves-chain-mirror.docs';
import { nativeEntryRowId } from './waves-chain-mirror.ids';
import { WavesChainMirror } from './waves-chain-mirror.service';

const D = chainId('d1');
const E1 = chainId('e1');
const EN = chainId('e8');
const EB = chainId('e9');
const AUTHOR = chainId('a9');
const V1 = chainId('b1');
const WAVE = '00000000-0000-4000-8000-0000000000a0';
const DROP1 = '00000000-0000-4000-8000-0000000000c1';
const NOW = 1_765_000_000_000;
const CREATED = 1_764_500_000_000;

describe('WavesChainMirror: entries made on the chain, in the database', () => {
  beforeEach(() => clearMirrorTables(sqlExecutor));

  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);
  const gateway = { getDocument: jest.fn().mockResolvedValue(null) };
  const gate = { check: jest.fn().mockResolvedValue({ kind: 'allowed' }) };
  const mirror = (now = NOW) =>
    new WavesChainMirror(
      db,
      index,
      () => ({
        write: true,
        frozen: true,
        keepMainStage: false,
        mainStageWaveId: null
      }),
      () => now,
      (keep) => new StoredDocuments(db, gateway, keep),
      gate,
      undefined,
      // The gateway's time of a block the log has no event at.
      async (height) => 1_760_000_000_000 + height
    );

  it('writes a checked entry as a drop and an entry the routes read, holds back one that fails, and writes nothing the second time', async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, {
      [AUTHOR]: 'author-profile',
      [V1]: 'p1'
    });
    const { competitionId } = await seedImportedCompetition(sqlExecutor, {
      waveId: WAVE,
      authorId: 'profile-old',
      dropIds: [DROP1]
    });
    const good = entryManifestDoc({
      nonce: `0x${'5a'.repeat(16)}`,
      decision: D,
      wave: chainId('a0'),
      author: AUTHOR,
      createdAt: CREATED - 5,
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
        metadata: [{ data_key: 'title', data_value: 'A new card' }],
        referenced_nfts: [],
        mentioned_users: [],
        mentioned_waves: []
      }
    });
    const other = entryManifestDoc({
      nonce: `0x${'6b'.repeat(16)}`,
      decision: D,
      wave: chainId('a0'),
      author: AUTHOR,
      createdAt: CREATED,
      fields: { wave_id: WAVE, parts: [{ content: 'x', media: [] }] }
    });
    // The gateway's store holds the good manifest (a rebuild reads chain_docs).
    gateway.getDocument.mockImplementation(async (cid: string) =>
      cid === good.contentCid ? Buffer.from(good.bytes) : null
    );
    await db.saveDocument(other.contentCid, 8, other.bytes);
    const native = (
      entryId: string,
      doc: typeof good,
      manifestHash: string
    ) => ({
      entryId,
      legacyId: null,
      decisionId: D,
      author: AUTHOR,
      status: 'active',
      total: '9',
      origin: 'native',
      manifestHash,
      contentCid: doc.contentCid,
      createdMs: CREATED
    });
    await seedChainDecision(
      index,
      {
        decision: {
          decisionId: D,
          legacyId: competitionId,
          waveId: chainId('a0'),
          status: 'published',
          kind: 'rank',
          origin: 'legacy',
          counted: true,
          configVersion: 2
        },
        entries: [
          {
            entryId: E1,
            legacyId: DROP1,
            decisionId: D,
            author: V1,
            status: 'active',
            total: '0',
            origin: 'legacy'
          },
          native(EN, good, good.manifestHash),
          // Its commitment is not the manifest's: held back.
          native(EB, other, good.manifestHash)
        ],
        votes: [
          {
            decisionId: D,
            entryId: EN,
            voter: V1,
            value: '9',
            updatedHeight: 20
          }
        ],
        leaderboard: {
          decisionId: D,
          by: 'time_weighted_score',
          scoredAt: NOW,
          rows: [
            { rank: 1, entryId: EN, score: '9', total: '9' },
            { rank: 2, entryId: EB, score: '9', total: '9' },
            { rank: 3, entryId: E1, legacyId: DROP1, score: '0', total: '0' }
          ]
        }
      },
      30
    );
    await index.saveState(
      {
        ...EMPTY_INDEX_STATE,
        generation: 1,
        lastFullAt: 1,
        feedNext: 31,
        network: 'net-1'
      },
      1
    );

    const report = await mirror().run({ budgetMs: 60_000 });
    expect(report.decisions).toMatchObject({ mirrored: 1, failed: 0 });
    expect(report.waiting).toMatchObject({
      native_entry_held_commitment_mismatch: 1
    });
    expect(gate.check).toHaveBeenCalledTimes(1);

    expect(
      await sqlExecutor.execute(
        `select id, author_id, drop_type, wave_id, created_at, title, parts_count
           from ${DROPS_TABLE} where id = :id`,
        { id: EN }
      )
    ).toEqual([
      {
        id: EN,
        author_id: 'author-profile',
        drop_type: 'COMPETITION',
        wave_id: WAVE,
        created_at: CREATED,
        title: 'A new card',
        parts_count: 1
      }
    ]);
    expect(
      await sqlExecutor.execute(
        `select drop_part_id, content from ${DROPS_PARTS_TABLE} where drop_id = :id`,
        { id: EN }
      )
    ).toEqual([{ drop_part_id: 1, content: 'The work' }]);
    expect(
      await sqlExecutor.execute(
        `select url, mime_type from ${DROP_MEDIA_TABLE} where drop_id = :id`,
        { id: EN }
      )
    ).toEqual([{ url: 'https://media.example/w.png', mime_type: 'image/png' }]);
    expect(
      await sqlExecutor.execute(
        `select data_key, data_value from ${DROP_METADATA_TABLE} where drop_id = :id`,
        { id: EN }
      )
    ).toEqual([{ data_key: 'title', data_value: 'A new card' }]);
    const rowId = nativeEntryRowId(competitionId, EN);
    expect(
      await sqlExecutor.execute(
        `select id, drop_id, submitter_id, status, config_version, submitted_at
           from ${COMPETITION_ENTRIES_TABLE} where drop_id = :id`,
        { id: EN }
      )
    ).toEqual([
      {
        id: rowId,
        drop_id: EN,
        submitter_id: 'author-profile',
        status: 'ACTIVE',
        config_version: 2,
        submitted_at: CREATED
      }
    ]);
    // Its vote and rank, in the same run.
    expect(
      await sqlExecutor.execute(
        `select entry_id, voter_profile_id, value from ${COMPETITION_VOTES_TABLE}`
      )
    ).toEqual([{ entry_id: rowId, voter_profile_id: 'p1', value: 9 }]);
    // The legacy drops view reads it as a participatory drop.
    expect(
      await sqlExecutor.execute(
        `select id, drop_type from ${legacyGetView(DROPS_TABLE)}
          where wave_id = :wave order by id`,
        { wave: WAVE }
      )
    ).toEqual([
      { id: DROP1, drop_type: 'PARTICIPATORY' },
      { id: EN, drop_type: 'PARTICIPATORY' }
    ]);
    const leaderboard = await competitionRepository.listNativeLeaderboard(
      competitionId,
      { offset: 0, limit: 10, direction: 'DESC', sort: 'rating' },
      {}
    );
    expect(leaderboard.data.map((r) => [r.drop_id, r.rank])).toEqual([
      [EN, 1],
      [DROP1, 3]
    ]);
    // The good manifest is kept for a rebuild.
    expect(await db.findDocument(good.contentCid)).toEqual(good.bytes);

    // Again: nothing written, the moderation not asked again.
    const tables = [
      DROPS_TABLE,
      DROPS_PARTS_TABLE,
      DROP_MEDIA_TABLE,
      DROP_METADATA_TABLE,
      COMPETITION_ENTRIES_TABLE,
      COMPETITION_VOTES_TABLE,
      CHAIN_ENTRY_HOLDS_TABLE
    ];
    const first = await dumpTables(sqlExecutor, tables);
    const again = await mirror(NOW + 60_000).run({ budgetMs: 60_000 });
    expect(again.changes).toEqual({});
    expect(gate.check).toHaveBeenCalledTimes(1);
    expect(await dumpTables(sqlExecutor, tables)).toEqual(first);

    // A relaunched chain: the old chain's entry made on it is released as
    // a withdrawn one (6529.io's backend delete), with its vote; the
    // imported entry stays.
    await index.saveState(
      {
        ...EMPTY_INDEX_STATE,
        generation: 2,
        lastFullAt: 1,
        feedNext: 31,
        network: 'net-2'
      },
      1
    );
    await sqlExecutor.execute(`delete from ${CHAIN_ENTRIES_TABLE}`);
    const relaunched = await mirror(NOW + 120_000).run({ budgetMs: 60_000 });
    expect(relaunched.full.started).toBe('network');
    expect(
      await sqlExecutor.execute(
        `select drop_id, status from ${COMPETITION_ENTRIES_TABLE} order by drop_id`
      )
    ).toEqual([{ drop_id: DROP1, status: 'ACTIVE' }]);
    expect(
      await sqlExecutor.execute(
        `select id from ${DROPS_TABLE} where id = :id`,
        {
          id: EN
        }
      )
    ).toEqual([]);
    expect(
      await sqlExecutor.execute(
        `select id from ${DELETED_DROPS_TABLE} where id = :id`,
        { id: EN }
      )
    ).toEqual([{ id: EN }]);
    expect(
      await sqlExecutor.execute(`select 1 from ${COMPETITION_VOTES_TABLE}`)
    ).toEqual([]);
  });
});
