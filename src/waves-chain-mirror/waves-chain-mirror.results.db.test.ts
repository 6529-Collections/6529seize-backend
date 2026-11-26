import 'reflect-metadata';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionEventRepository } from '@/competitions/competition-event.repository';
import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITIONS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
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
import { chainId } from '@/tests/fixtures/waves-chain-mirror.fixture';
import {
  EMPTY_INDEX_STATE,
  WavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import {
  ChainEvent,
  UNKNOWN_SCAN
} from '@/waves-chain-index/waves-chain-index.events';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import {
  chainExecutionKey,
  chainExecutionKeyPrefix,
  resultDecisionId
} from './waves-chain-mirror.ids';
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
const WAVE = '00000000-0000-4000-8000-0000000000a0';
const DROP1 = '00000000-0000-4000-8000-0000000000c1';
const DROP2 = '00000000-0000-4000-8000-0000000000c2';
const DROP3 = '00000000-0000-4000-8000-0000000000c3';
const NOW = 1_765_000_000_000;
const T1 = 1_764_000_000_000;
const T2 = T1 + 86_400_000;
const FINAL_AT = T1 + 20_000;

const WRITE: WavesChainMirrorSettings = {
  write: true,
  frozen: true,
  keepMainStage: false,
  mainStageWaveId: null
};

const TABLES = [
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_OUTBOX_TABLE
];

const anEvent = (
  height: number,
  seq: number,
  fields: Partial<ChainEvent>
): ChainEvent => ({
  height,
  seq,
  blockTime: FINAL_AT,
  kind: 'VOTE',
  origin: 'OPERATION',
  waveId: null,
  waveLegacyId: null,
  decisionId: D,
  decisionLegacyId: null,
  entryId: null,
  entryLegacyId: null,
  pollId: null,
  pollLegacyId: null,
  groupId: null,
  groupLegacyId: null,
  actor: null,
  data: {},
  ...fields
});

describe('WavesChainMirror: results in the database', () => {
  beforeEach(() => clearMirrorTables(sqlExecutor));

  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);
  const mirror = (now = NOW) =>
    new WavesChainMirror(
      db,
      index,
      () => WRITE,
      () => now
    );

  it("writes the chain's result as the runtime writes one, names no claim, and writes nothing the second time", async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [V1]: 'p1', [V2]: 'p2' });
    const { competitionId, entryIds } = await seedImportedCompetition(
      sqlExecutor,
      {
        waveId: WAVE,
        authorId: 'profile-author',
        dropIds: [DROP1, DROP2, DROP3],
        nextDecisionTime: T1
      }
    );
    await sqlExecutor.execute(
      `update ${COMPETITIONS_TABLE}
          set outcome_config = :outcomes where id = :id`,
      {
        id: competitionId,
        outcomes: JSON.stringify([
          {
            type: 'NIC',
            description: 'NIC',
            credit: 'NIC',
            amount: 1000,
            distribution: [{ amount: 60 }, { amount: 40 }]
          }
        ])
      }
    );
    await sqlExecutor.execute(
      `insert into ${COMPETITION_CAPABILITIES_TABLE}
         (capability, competition_id, wave_id, assigned_by, assigned_at)
       values ('MAIN_STAGE', :id, :wave, null, 1)`,
      { id: competitionId, wave: WAVE }
    );
    const entry = (
      id: string,
      drop: string,
      status: string,
      total: string
    ) => ({
      entryId: id,
      legacyId: drop,
      decisionId: D,
      author: V1,
      status,
      total,
      origin: 'legacy',
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
          nextResultTime: T2
        },
        entries: [
          entry(E1, DROP1, 'winner', '50'),
          entry(E2, DROP2, 'winner', '20'),
          entry(E3, DROP3, 'active', '3')
        ],
        votes: [
          {
            decisionId: D,
            entryId: E1,
            voter: V1,
            value: '50',
            updatedHeight: 5
          },
          {
            decisionId: D,
            entryId: E3,
            voter: V2,
            value: '3',
            updatedHeight: 6
          }
        ],
        leaderboard: {
          decisionId: D,
          by: 'time_weighted_score',
          scoredAt: NOW,
          rows: [
            { rank: 1, entryId: E3, legacyId: DROP3, score: '3', total: '3' }
          ]
        },
        results: [
          {
            resultTime: T1,
            occurrence: 0,
            status: 'decided',
            stage: 'final',
            origin: 'native',
            settledHeight: 40,
            winners: [
              { entryId: E1, rank: 1, score: '48' },
              { entryId: E2, rank: 2, score: '20' }
            ]
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
    await index.writeEvents(
      [
        anEvent(40, 0, {
          kind: 'RESULT_FINAL',
          data: { resultTime: T1, status: 'decided' }
        }),
        // V2's vote on the runner-up, released after the result.
        anEvent(41, 0, {
          kind: 'VOTE',
          origin: 'RELEASE',
          entryId: E2,
          actor: V2,
          data: { oldValue: '20', newValue: '0' }
        })
      ],
      46,
      UNKNOWN_SCAN
    );

    const report = await mirror().run({ budgetMs: 60_000 });
    expect(report.decisions).toMatchObject({ mirrored: 1, failed: 0 });

    const decisionId = resultDecisionId(competitionId, T1);
    expect(
      await sqlExecutor.execute(
        `select id, scheduled_at, decided_at, status, execution_key, created_at
           from ${COMPETITION_DECISIONS_TABLE}`
      )
    ).toEqual([
      {
        id: decisionId,
        scheduled_at: T1,
        decided_at: FINAL_AT,
        status: 'COMPLETED',
        execution_key: chainExecutionKey('net-1', D, T1),
        created_at: FINAL_AT
      }
    ]);
    const entries = await sqlExecutor.execute<Record<string, unknown>>(
      `select drop_id, status, won_at, \`rank\`, decision_id
         from ${COMPETITION_ENTRIES_TABLE} order by drop_id`
    );
    expect(
      entries.map((e) => ({
        ...e,
        rank: e.rank === null ? null : Number(e.rank)
      }))
    ).toEqual([
      {
        drop_id: DROP1,
        status: 'WINNER',
        won_at: T1,
        rank: 1,
        decision_id: decisionId
      },
      {
        drop_id: DROP2,
        status: 'WINNER',
        won_at: T1,
        rank: 2,
        decision_id: decisionId
      },
      {
        drop_id: DROP3,
        status: 'ACTIVE',
        won_at: null,
        rank: null,
        decision_id: null
      }
    ]);
    // Only the active entry stays on the board.
    expect(
      await sqlExecutor.execute(
        `select entry_id from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE}`
      )
    ).toEqual([{ entry_id: entryIds[DROP3] }]);

    // The legacy GETs: decisions, winners and their voters.
    expect(
      await sqlExecutor.execute(
        `select decision_time from ${legacyGetView(WAVES_DECISIONS_TABLE)}
          where wave_id = :wave`,
        { wave: WAVE }
      )
    ).toEqual([{ decision_time: T1 }]);
    const winners = await sqlExecutor.execute<Record<string, unknown>>(
      `select drop_id, ranking, final_vote, prizes
         from ${legacyGetView(WAVES_DECISION_WINNER_DROPS_TABLE)}
        where wave_id = :wave order by ranking`,
      { wave: WAVE }
    );
    expect(
      winners.map((w) => ({
        drop_id: w.drop_id,
        ranking: w.ranking,
        final_vote: Number(w.final_vote),
        amounts: (typeof w.prizes === 'string'
          ? JSON.parse(w.prizes)
          : (w.prizes as { amount: number }[])
        ).map((p: { amount: number }) => p.amount)
      }))
    ).toEqual([
      { drop_id: DROP1, ranking: 1, final_vote: 48, amounts: [600] },
      { drop_id: DROP2, ranking: 2, final_vote: 20, amounts: [400] }
    ]);
    expect(
      await sqlExecutor.execute(
        `select drop_id, voter_id, votes
           from ${legacyGetView(WINNER_DROP_VOTER_VOTES_TABLE)}
          where wave_id = :wave order by drop_id`,
        { wave: WAVE }
      )
    ).toEqual([
      { drop_id: DROP1, voter_id: 'p1', votes: 50 },
      { drop_id: DROP2, voter_id: 'p2', votes: 20 }
    ]);

    // The v3 routes.
    const decisions = await competitionRepository.listNativeDecisions(
      competitionId,
      { offset: 0, limit: 10, direction: 'DESC' },
      {}
    );
    expect(decisions.data).toEqual([
      {
        id: decisionId,
        competition_id: competitionId,
        scheduled_at: T1,
        decided_at: FINAL_AT,
        status: 'COMPLETED',
        winners: [
          { entry_id: entryIds[DROP1], rank: 1, final_rating: 48 },
          { entry_id: entryIds[DROP2], rank: 2, final_rating: 20 }
        ]
      }
    ]);
    const competition = await sqlExecutor.execute<{ next: unknown }>(
      `select json_extract(decision_config, '$.next_decision_time') as next
         from ${COMPETITIONS_TABLE} where id = :id`,
      { id: competitionId }
    );
    expect(Number(competition[0].next)).toBe(T2);

    // The runtime's socket and notification events for a result, and no
    // claim from 6529.io's own path: the dispatcher's publishClaim and
    // announcement read getPrivilegedWinners, which leaves a chain result
    // out; the chain's claim is the index's (chain_claim_builds).
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
      'COMPETITION_DECISION_COMPLETED',
      'COMPETITION_ENTRY_STATUS_CHANGED',
      'COMPETITION_ENTRY_STATUS_CHANGED',
      'COMPETITION_LEADERBOARD_UPDATED',
      'COMPETITION_OUTCOME_CREATED',
      'COMPETITION_OUTCOME_CREATED'
    ]);
    expect(
      await competitionEventRepository.getPrivilegedWinners(
        competitionId,
        decisionId,
        {}
      )
    ).toEqual([]);

    // Again, a minute later: the same rows.
    const first = await dumpTables(sqlExecutor, TABLES);
    const again = await mirror(NOW + 60_000).run({ budgetMs: 60_000 });
    expect(again.changes).toEqual({});
    expect(await dumpTables(sqlExecutor, TABLES)).toEqual(first);

    // A relaunched chain: the old network's result goes, and the new
    // network's is written in its place.
    await index.saveState(
      {
        ...EMPTY_INDEX_STATE,
        generation: 2,
        lastFullAt: 1,
        feedNext: 46,
        network: 'net-2'
      },
      1
    );
    const relaunched = await mirror(NOW + 120_000).run({ budgetMs: 60_000 });
    expect(relaunched.full.started).toBe('network');
    expect(
      await sqlExecutor.execute(
        `select id, execution_key from ${COMPETITION_DECISIONS_TABLE}`
      )
    ).toEqual([
      { id: decisionId, execution_key: chainExecutionKey('net-2', D, T1) }
    ]);
    expect(
      await db.removeOtherNetworksResults(chainExecutionKeyPrefix('net-3'))
    ).toBe(1);
    for (const table of [
      COMPETITION_DECISIONS_TABLE,
      COMPETITION_DECISION_WINNERS_TABLE,
      COMPETITION_WINNER_VOTES_TABLE,
      COMPETITION_OUTCOME_AWARDS_TABLE
    ]) {
      expect(await sqlExecutor.execute(`select 1 from ${table}`)).toEqual([]);
    }
    expect(
      await sqlExecutor.execute(
        `select distinct status, won_at, decision_id
           from ${COMPETITION_ENTRIES_TABLE}`
      )
    ).toEqual([{ status: 'ACTIVE', won_at: null, decision_id: null }]);
  });
});
