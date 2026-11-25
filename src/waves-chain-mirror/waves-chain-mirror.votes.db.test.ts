import 'reflect-metadata';
import { competitionRepository } from '@/competitions/competition.repository';
import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
import {
  CHAIN_DOCS_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITIONS_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_CHAIN_MIRROR_STATE_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  clearMirrorTables,
  dumpTables,
  ensurePrincipalMap,
  mapPrincipals,
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
import {
  applyHistoryWrites,
  chainScoreSequence
} from './waves-chain-mirror.apply';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { voteRowId } from './waves-chain-mirror.ids';
import {
  WavesChainMirror,
  WavesChainMirrorSettings
} from './waves-chain-mirror.service';

const D = chainId('d1');
const E1 = chainId('e1');
const E2 = chainId('e2');
const E3 = chainId('e3');
const V1 = chainId('b1');
const V2 = chainId('b2');
const V_UNMAPPED = chainId('b9');
const WAVE = '00000000-0000-4000-8000-0000000000a0';
const DROP1 = '00000000-0000-4000-8000-0000000000c1';
const DROP2 = '00000000-0000-4000-8000-0000000000c2';
const DROP3 = '00000000-0000-4000-8000-0000000000c3';
const AUTHOR = 'profile-author';
const NOW = 1_765_000_000_000;
const T = 1_764_000_000_000;

const WRITE: WavesChainMirrorSettings = {
  write: true,
  frozen: true,
  keepMainStage: false,
  mainStageWaveId: null
};

/** The tables a mirror run may write, and the routes' views over them. */
const TABLES = [
  COMPETITIONS_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  WAVES_CHAIN_MIRROR_STATE_TABLE,
  CHAIN_DOCS_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_OUTBOX_TABLE
];

describe('WavesChainMirror: votes and boards in the database', () => {
  beforeEach(() => clearMirrorTables(sqlExecutor));

  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);
  const mirror = (settings: WavesChainMirrorSettings, now = NOW) =>
    new WavesChainMirror(
      db,
      index,
      () => settings,
      () => now
    );
  let competitionId: string;
  let rows: Record<string, string>;

  beforeEach(async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [V1]: 'p1', [V2]: 'p2' });
    const seeded = await seedImportedCompetition(sqlExecutor, {
      waveId: WAVE,
      authorId: AUTHOR,
      dropIds: [DROP1, DROP2, DROP3],
      timeLockMs: 3_600_000
    });
    competitionId = seeded.competitionId;
    rows = seeded.entryIds;
    // 6529.io's votes before the switch: one the chain changed, one it
    // doesn't have, and a zero row the import left out.
    await seedTargetVote(sqlExecutor, {
      id: 'kept-id',
      competitionId,
      entryId: rows[DROP1],
      voterProfileId: 'p1',
      value: 10
    });
    await seedTargetVote(sqlExecutor, {
      id: 'gone',
      competitionId,
      entryId: rows[DROP3],
      voterProfileId: 'p2',
      value: 5
    });
    await seedTargetVote(sqlExecutor, {
      id: 'zero',
      competitionId,
      entryId: rows[DROP2],
      voterProfileId: 'p3',
      value: 0
    });
    const entry = (id: string, drop: string, total: string, time = 0) => ({
      entryId: id,
      legacyId: drop,
      decisionId: D,
      author: V1,
      status: 'active',
      total,
      origin: 'legacy',
      lastIncrease: { time, height: 0, index: 0 },
      createdMs: 1
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
          nextResultTime: 0
        },
        entries: [
          entry(E1, DROP1, '40', T + 50_000),
          entry(E2, DROP2, '7', T + 51_000),
          entry(E3, DROP3, '0')
        ],
        votes: [
          {
            decisionId: D,
            entryId: E1,
            voter: V1,
            value: '40',
            updatedHeight: 50
          },
          {
            decisionId: D,
            entryId: E2,
            voter: V2,
            value: '7',
            updatedHeight: 51
          }
        ],
        leaderboard: {
          decisionId: D,
          by: 'time_weighted_score',
          scoredAt: NOW,
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
              total: '7',
              lastIncrease: { time: T + 51_000 }
            },
            { rank: 3, entryId: E3, legacyId: DROP3, score: '0', total: '0' }
          ]
        }
      },
      60
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
    await index.writeEvents(
      // 52: a voter the identity mirror has not mapped.
      [50, 51, 52].map((height) => ({
        height,
        seq: 0,
        blockTime: T + (height - 50) * 1000 + 50_000,
        kind: 'VOTE' as const,
        origin: 'OPERATION' as const,
        waveId: null,
        waveLegacyId: null,
        decisionId: D,
        decisionLegacyId: competitionId,
        entryId: height === 50 ? E1 : E2,
        entryLegacyId: null,
        pollId: null,
        pollLegacyId: null,
        groupId: null,
        groupLegacyId: null,
        actor: height === 50 ? V1 : height === 51 ? V2 : V_UNMAPPED,
        data:
          height === 50
            ? { oldValue: '10', newValue: '40', entryTotalAfter: '40' }
            : height === 51
              ? { oldValue: '0', newValue: '7', entryTotalAfter: '7' }
              : { oldValue: '0', newValue: '2', entryTotalAfter: '9' }
      })),
      61,
      UNKNOWN_SCAN
    );
  });

  it('reports without writing, then writes the votes and board the routes read, the same rows twice', async () => {
    // Report only: what it would write, and nothing written.
    const before = await dumpTables(sqlExecutor, TABLES);
    const reported = await mirror({ ...WRITE, write: false }).run({
      budgetMs: 60_000
    });
    expect(reported).toMatchObject({
      mode: 'report',
      decisions: { mirrored: 1, failed: 0 },
      changes: {
        competition_votes: { insert: 1, update: 1, delete: 2 },
        competition_entry_runtime: { insert: 3, update: 0, delete: 0 },
        competition_leaderboard_entries: { insert: 3, update: 0, delete: 0 }
      }
    });
    expect(reported.differences).toHaveLength(1);
    expect(await dumpTables(sqlExecutor, TABLES)).toEqual(before);

    // Writing.
    const report = await mirror(WRITE).run({ budgetMs: 60_000 });
    expect(report.decisions).toMatchObject({ mirrored: 1, failed: 0 });

    const votes = await sqlExecutor.execute<Record<string, unknown>>(
      `select id, entry_id, voter_profile_id, value, credit_spent, created_at,
              updated_at
         from ${COMPETITION_VOTES_TABLE} order by voter_profile_id`
    );
    expect(votes.map((v) => ({ ...v, value: Number(v.value) }))).toEqual([
      {
        id: 'kept-id',
        entry_id: rows[DROP1],
        voter_profile_id: 'p1',
        value: 40,
        credit_spent: 40,
        created_at: 1_700_000_000_000,
        updated_at: T + 50_000
      },
      {
        id: voteRowId(competitionId, rows[DROP2], 'p2'),
        entry_id: rows[DROP2],
        voter_profile_id: 'p2',
        value: 7,
        credit_spent: 7,
        created_at: T + 51_000,
        updated_at: T + 51_000
      }
    ]);

    // The legacy GETs (drop objects, /v2/drops/:id/votes, leaderboards).
    const voterStates = await sqlExecutor.execute(
      `select drop_id, voter_id, votes from ${legacyGetView(DROP_VOTER_STATE_TABLE)}
        where wave_id = :wave order by drop_id`,
      { wave: WAVE }
    );
    expect(voterStates).toEqual([
      { drop_id: DROP1, voter_id: 'p1', votes: 40 },
      { drop_id: DROP2, voter_id: 'p2', votes: 7 }
    ]);
    const ranks = await sqlExecutor.execute(
      `select drop_id, vote, last_increased from ${legacyGetView(DROP_RANK_TABLE)}
        where wave_id = :wave order by drop_id`,
      { wave: WAVE }
    );
    expect(ranks).toEqual([
      { drop_id: DROP1, vote: '40', last_increased: T + 50_000 },
      { drop_id: DROP2, vote: '7', last_increased: T + 51_000 }
    ]);
    const board = await sqlExecutor.execute(
      `select drop_id, vote, vote_on_decision_time, timestamp
         from ${legacyGetView(WAVE_LEADERBOARD_ENTRIES_TABLE)}
        where wave_id = :wave order by vote desc`,
      { wave: WAVE }
    );
    expect(board).toEqual([
      {
        drop_id: DROP1,
        vote: 35,
        vote_on_decision_time: 35,
        timestamp: T + 50_000
      },
      {
        drop_id: DROP2,
        vote: 6,
        vote_on_decision_time: 6,
        timestamp: T + 51_000
      },
      {
        drop_id: DROP3,
        vote: 0,
        vote_on_decision_time: 0,
        timestamp: expect.any(Number)
      }
    ]);

    // The v3 routes.
    const page = { offset: 0, limit: 10, direction: 'DESC' as const };
    const leaderboard = await competitionRepository.listNativeLeaderboard(
      competitionId,
      { ...page, sort: 'rating' },
      {}
    );
    expect(
      leaderboard.data.map((r) => [
        r.drop_id,
        r.rank,
        r.rating,
        r.real_time_rating
      ])
    ).toEqual([
      [DROP1, 1, 35, 40],
      [DROP2, 2, 6, 7],
      [DROP3, 3, 0, 0]
    ]);
    const voters = await competitionRepository.listNativeVoters(
      competitionId,
      page,
      {}
    );
    expect(voters.data).toEqual([
      { profile_id: 'p1', votes: 40, credit_spent: 40 },
      { profile_id: 'p2', votes: 7, credit_spent: 7 }
    ]);

    // The log's vote changes, as the runtime's history: the vote history,
    // the score history the "votes over time" views read, and the socket
    // events (the board's too); no event of a claim.
    const history = await sqlExecutor.execute<Record<string, unknown>>(
      `select entry_id, voter_profile_id, value, previous_value,
              aggregate_value, occurred_at
         from ${COMPETITION_VOTE_HISTORY_TABLE} order by occurred_at`
    );
    expect(history.map((h) => Object.values(h).map(String))).toEqual([
      [rows[DROP1], 'p1', '40', '10', '40', String(T + 50_000)],
      [rows[DROP2], 'p2', '7', '0', '7', String(T + 51_000)]
    ]);
    expect(
      await sqlExecutor.execute(
        `select drop_id, vote, timestamp
           from ${legacyGetView(DROP_REAL_VOTE_IN_TIME_TABLE)}
          where wave_id = :wave order by timestamp`,
        { wave: WAVE }
      )
    ).toEqual([
      { drop_id: DROP1, vote: 40, timestamp: T + 50_000 },
      { drop_id: DROP2, vote: 7, timestamp: T + 51_000 },
      // The unmapped voter's change: the entry's total, under its chain place.
      { drop_id: DROP2, vote: 9, timestamp: T + 52_000 }
    ]);
    expect(
      await sqlExecutor.execute(
        `select sequence, mutation_sequence from ${COMPETITION_SCORE_HISTORY_TABLE}
          where value = 9`
      )
    ).toEqual([
      { sequence: chainScoreSequence(52, 0), mutation_sequence: null }
    ]);
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
      'COMPETITION_LEADERBOARD_UPDATED',
      'COMPETITION_VOTE_CHANGED',
      'COMPETITION_VOTE_CHANGED'
    ]);

    // Again, a minute later: nothing changes.
    const first = await dumpTables(
      sqlExecutor,
      TABLES.filter((t) => t !== WAVES_CHAIN_MIRROR_STATE_TABLE)
    );
    const again = await mirror(WRITE, NOW + 60_000).run({ budgetMs: 60_000 });
    expect(again.changes).toEqual({});
    expect(again.decisions).toMatchObject({ mirrored: 0, unchanged: 1 });
    expect(
      await dumpTables(
        sqlExecutor,
        TABLES.filter((t) => t !== WAVES_CHAIN_MIRROR_STATE_TABLE)
      )
    ).toEqual(first);
  });

  it("writes a relaunched chain's unmapped-voter point over an old chain's at the same place", async () => {
    const competitionId = '00000000-0000-4000-8000-0000000000c9';
    const point = (aggregate: number, occurredAt: number) => ({
      height: 50,
      seq: 0,
      entryRowId: '00000000-0000-4000-8000-0000000000e1',
      dropId: '00000000-0000-4000-8000-0000000000d1',
      submitterId: 'profile-author',
      voterProfileId: null,
      value: 10,
      previous: 0,
      aggregate,
      occurredAt,
      reason: null
    });
    const apply = (network: string, aggregate: number, occurredAt: number) =>
      sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        applyHistoryWrites(
          sqlExecutor,
          network,
          { id: competitionId, waveId: WAVE },
          [point(aggregate, occurredAt)],
          1,
          connection,
          { enqueueEvent: jest.fn() } as never
        )
      );
    await apply('net-1', 10, 1_765_000_000_000);
    // The relaunched chain: the same competition, block 50 seq 0 again.
    await apply('net-2', 25, 1_766_000_000_000);
    // The same chain's place again: written once.
    await apply('net-2', 99, 1_767_000_000_000);
    expect(
      await sqlExecutor.execute(
        `select sequence, value, occurred_at from ${COMPETITION_SCORE_HISTORY_TABLE}
          where competition_id = :competitionId`,
        { competitionId }
      )
    ).toEqual([
      {
        sequence: chainScoreSequence(50, 0),
        value: 25,
        occurred_at: 1_766_000_000_000
      }
    ]);
  });
});
