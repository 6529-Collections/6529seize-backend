import 'reflect-metadata';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_ENTRIES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  clearMirrorTables,
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
import { UNKNOWN_SCAN } from '@/waves-chain-index/waves-chain-index.events';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { StoredDocuments } from './waves-chain-mirror.docs';
import { resultDecisionId } from './waves-chain-mirror.ids';
import { WavesChainMirror } from './waves-chain-mirror.service';

const D = chainId('d1');
const EN = chainId('e8');
const AUTHOR = chainId('a9');
const WAVE = '00000000-0000-4000-8000-0000000000a0';
const DROP1 = '00000000-0000-4000-8000-0000000000c1';
const NOW = 1_765_000_000_000;
const CREATED = 1_764_500_000_000;
const T1 = 1_764_600_000_000;

describe('WavesChainMirror: the claim of a chain-made Main Stage winner', () => {
  beforeEach(() => clearMirrorTables(sqlExecutor));

  const BLOCK_TIME_BASE = 1_760_000_000_000;
  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);
  const mirror = (now: number) =>
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
      (keep) =>
        new StoredDocuments(
          db,
          { getDocument: jest.fn().mockResolvedValue(null) },
          keep
        ),
      { check: jest.fn().mockResolvedValue({ kind: 'allowed' }) },
      undefined,
      // The gateway's time of a block the log has no event at.
      async (height) => BLOCK_TIME_BASE + height
    );

  it("turns the index's skipped claim build pending, once, when the mirror writes the winner's drop", async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [AUTHOR]: 'author-profile' });
    const { competitionId } = await seedImportedCompetition(sqlExecutor, {
      waveId: WAVE,
      authorId: 'profile-old',
      dropIds: [DROP1]
    });
    await sqlExecutor.execute(
      `insert into ${COMPETITION_CAPABILITIES_TABLE}
         (capability, competition_id, wave_id, assigned_by, assigned_at)
       values ('MAIN_STAGE', :id, :wave, null, 1)`,
      { id: competitionId, wave: WAVE }
    );
    const doc = entryManifestDoc({
      nonce: `0x${'5a'.repeat(16)}`,
      decision: D,
      wave: chainId('a0'),
      author: AUTHOR,
      createdAt: CREATED - 5,
      fields: { wave_id: WAVE, parts: [{ content: 'The work', media: [] }] }
    });
    await db.saveDocument(doc.contentCid, 8, doc.bytes);
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
          nextResultTime: T1 + 86_400_000
        },
        entries: [
          {
            entryId: EN,
            legacyId: null,
            decisionId: D,
            author: AUTHOR,
            status: 'winner',
            total: '9',
            origin: 'native',
            manifestHash: doc.manifestHash,
            contentCid: doc.contentCid,
            createdMs: CREATED
          }
        ],
        leaderboard: { decisionId: D, by: 'total', rows: [] },
        results: [
          {
            resultTime: T1,
            occurrence: 3,
            status: 'decided',
            stage: 'final',
            origin: 'native',
            settledHeight: 40,
            winners: [{ entryId: EN, rank: 1, score: '9' }]
          }
        ]
      },
      45
    );
    await index.saveState(
      {
        ...EMPTY_INDEX_STATE,
        generation: 1,
        lastFullAt: 1,
        feedNext: 46,
        network: 'net-1'
      },
      1
    );
    // The index's claim build for the result: skipped, no 6529.io drop then.
    await index.writeEvents([], 46, UNKNOWN_SCAN, [
      {
        network: 'net-1',
        decisionId: D,
        occurrence: 3,
        height: 40,
        entryId: EN,
        dropId: null,
        message: null,
        status: 'skipped',
        reason: 'entry created on the chain: no 6529.io drop'
      }
    ]);

    const report = await mirror(NOW).run({ budgetMs: 60_000 });
    expect(report.changes).toMatchObject({
      drops: { insert: 1 },
      chain_claim_builds: { update: 1 }
    });
    expect(
      await sqlExecutor.execute(
        `select drop_id, status, \`rank\`, decision_id
           from ${COMPETITION_ENTRIES_TABLE} where drop_id = :id`,
        { id: EN }
      )
    ).toEqual([
      {
        drop_id: EN,
        status: 'WINNER',
        rank: 1,
        decision_id: resultDecisionId(competitionId, T1)
      }
    ]);
    const message = {
      drop_id: EN,
      chain: {
        decision_id: D,
        occurrence: 3,
        entry_id: EN,
        height: 40,
        manifest_hash: doc.manifestHash.toLowerCase()
      }
    };
    expect(await index.pendingClaimBuilds(10)).toEqual([
      { network: 'net-1', decisionId: D, occurrence: 3, message, attempts: 0 }
    ]);

    // Again: the row is the index's now; nothing changes.
    const again = await mirror(NOW + 60_000).run({ budgetMs: 60_000 });
    expect(again.changes).toEqual({});
    expect(await index.pendingClaimBuilds(10)).toHaveLength(1);
  });
});
