import 'reflect-metadata';
import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_VOTES_TABLE,
  DELETED_DROPS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  clearMirrorTables,
  ensurePrincipalMap,
  seedChainDecision,
  seedImportedCompetition,
  seedTargetVote
} from '@/tests/fixtures/waves-chain-mirror.db.fixture';
import { chainId } from '@/tests/fixtures/waves-chain-mirror.fixture';
import {
  EMPTY_INDEX_STATE,
  WavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import { UNKNOWN_SCAN } from '@/waves-chain-index/waves-chain-index.events';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { WavesChainMirror } from './waves-chain-mirror.service';

const D = chainId('d1');
const E1 = chainId('e1');
const E2 = chainId('e2');
const E3 = chainId('e3');
const WAVE = '00000000-0000-4000-8000-0000000000a0';
const DROP1 = '00000000-0000-4000-8000-0000000000c1';
const DROP2 = '00000000-0000-4000-8000-0000000000c2';
const DROP3 = '00000000-0000-4000-8000-0000000000c3';
const NOW = 1_765_000_000_000;
const RELEASED_AT = 1_764_000_030_000;

describe('WavesChainMirror: entries leaving ACTIVE in the database', () => {
  beforeEach(() => clearMirrorTables(sqlExecutor));

  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);

  it("removes the entries the chain released as 6529.io's own delete does", async () => {
    await ensurePrincipalMap(sqlExecutor);
    const { competitionId, entryIds: rows } = await seedImportedCompetition(
      sqlExecutor,
      {
        waveId: WAVE,
        authorId: 'profile-author',
        dropIds: [DROP1, DROP2, DROP3]
      }
    );
    // 6529.io's vote on the entry the chain withdraws.
    await seedTargetVote(sqlExecutor, {
      id: 'vote-on-withdrawn',
      competitionId,
      entryId: rows[DROP1],
      voterProfileId: 'p1',
      value: 5
    });
    const entry = (id: string, drop: string, status: string) => ({
      entryId: id,
      legacyId: drop,
      decisionId: D,
      author: chainId('a1'),
      status,
      total: '0',
      origin: 'legacy'
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
          origin: 'legacy'
        },
        entries: [
          entry(E1, DROP1, 'withdrawn'),
          entry(E2, DROP2, 'disqualified'),
          entry(E3, DROP3, 'active')
        ],
        leaderboard: {
          decisionId: D,
          by: 'total',
          rows: [
            { rank: 1, entryId: E3, legacyId: DROP3, score: '0', total: '0' }
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
    await index.writeEvents(
      [
        {
          height: 25,
          seq: 0,
          blockTime: RELEASED_AT,
          kind: 'ENTRY_RELEASED',
          origin: 'OPERATION',
          waveId: null,
          waveLegacyId: null,
          decisionId: D,
          decisionLegacyId: competitionId,
          entryId: E1,
          entryLegacyId: DROP1,
          pollId: null,
          pollLegacyId: null,
          groupId: null,
          groupLegacyId: null,
          actor: null,
          data: { status: 'withdrawn' }
        }
      ],
      31,
      UNKNOWN_SCAN
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
      () => NOW
    ).run({ budgetMs: 60_000 });
    expect(report.changes).toMatchObject({
      competition_entries: { insert: 0, update: 0, delete: 2 },
      drops: { insert: 0, update: 0, delete: 2 }
    });

    // Gone as 6529.io's own delete leaves them: the drops (recorded as
    // deleted), the entries and their votes, board and runtime rows.
    expect(
      await sqlExecutor.execute(
        `select drop_id, status from ${COMPETITION_ENTRIES_TABLE} order by drop_id`
      )
    ).toEqual([{ drop_id: DROP3, status: 'ACTIVE' }]);
    expect(
      await sqlExecutor.execute(
        `select id from ${DROPS_TABLE} where wave_id = :wave order by id`,
        { wave: WAVE }
      )
    ).toEqual([{ id: DROP3 }]);
    expect(
      await sqlExecutor.execute(
        `select id from ${DELETED_DROPS_TABLE} order by id`
      )
    ).toEqual([{ id: DROP1 }, { id: DROP2 }]);
    for (const table of [
      COMPETITION_VOTES_TABLE,
      COMPETITION_ENTRY_RUNTIME_TABLE,
      COMPETITION_LEADERBOARD_ENTRIES_TABLE
    ]) {
      expect(
        await sqlExecutor.execute(
          `select entry_id from ${table} where entry_id in (:ids)`,
          { ids: [rows[DROP1], rows[DROP2]] }
        )
      ).toEqual([]);
    }
    expect(
      await sqlExecutor.execute(
        `select id from ${legacyGetView(DROPS_TABLE)} where wave_id = :wave`,
        { wave: WAVE }
      )
    ).toEqual([{ id: DROP3 }]);
    // The delete's own socket events; none that builds a claim.
    const events = await sqlExecutor.execute<{ event: unknown }>(
      `select event from ${COMPETITION_OUTBOX_TABLE}`
    );
    expect(
      events
        .map(
          (r) =>
            (typeof r.event === 'string' ? JSON.parse(r.event) : r.event)
              .event_type
        )
        .sort()
    ).toEqual([
      'COMPETITION_ENTRY_DELETED',
      'COMPETITION_ENTRY_DELETED',
      'COMPETITION_LEADERBOARD_UPDATED'
    ]);

    // Again, in a full pass (a new full read of the index): nothing moves.
    await index.saveState(
      {
        ...EMPTY_INDEX_STATE,
        generation: 2,
        lastFullAt: 1,
        feedNext: 31,
        network: 'net-1'
      },
      1
    );
    const again = await new WavesChainMirror(
      db,
      index,
      () => ({
        write: true,
        frozen: true,
        keepMainStage: false,
        mainStageWaveId: null
      }),
      () => NOW + 60_000
    ).run({ budgetMs: 60_000 });
    expect(again.full.started).toBe('index_full_read');
    expect(again.decisions).toMatchObject({ unchanged: 1, mirrored: 0 });
    expect(again.changes).toEqual({});
  });
});
