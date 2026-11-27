import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import {
  clearMirrorTables,
  ensurePrincipalMap,
  mapPrincipals,
  seedChainDecision,
  seedImportedCompetition
} from '@/tests/fixtures/waves-chain-mirror.db.fixture';
import {
  canonicalDocBytes,
  chainId
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import {
  EMPTY_INDEX_STATE,
  WavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import {
  ChainEvent,
  UNKNOWN_SCAN
} from '@/waves-chain-index/waves-chain-index.events';
import { docCid } from './waves-chain-mirror.docs';
import {
  EMPTY_MIRROR_STATE,
  WavesChainMirrorDb
} from './waves-chain-mirror.db';

const D1 = chainId('d1');
const D2 = chainId('d2');
const E1 = chainId('e1');
const E2 = chainId('e2');
const V1 = chainId('b1');
const V2 = chainId('b2');
const WAVE = '00000000-0000-4000-8000-0000000000a0';
const DROP1 = '00000000-0000-4000-8000-0000000000c1';
const DROP2 = '00000000-0000-4000-8000-0000000000c2';

const event = (
  height: number,
  seq: number,
  fields: Partial<ChainEvent>
): ChainEvent => ({
  height,
  seq,
  blockTime: height * 1000,
  kind: 'VOTE',
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
  actor: null,
  data: {},
  ...fields
});

describe('WavesChainMirrorDb', () => {
  beforeEach(() => clearMirrorTables(sqlExecutor));

  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);

  beforeEach(async () => {
    await ensurePrincipalMap(sqlExecutor);
    await index.saveState({ ...EMPTY_INDEX_STATE, feedNext: 1 }, 1);
  });

  it('keeps its state, reads the index, the event log, the principal map, a competition and documents', async () => {
    // Its state.
    expect(await db.loadState()).toEqual(EMPTY_MIRROR_STATE);
    const state = {
      network: 'net-1',
      eventsCursor: '12:3@net-1',
      indexGeneration: 4,
      indexHeight: 120,
      fullRunning: true,
      fullAfter: D1,
      lastFullAt: 1_764_000_000_000,
      retryIds: [D1, D2],
      replayFrom: { [D1]: null, [D2]: '10:0@net-1' },
      lastError: '1 decision(s) failed; see the log'
    };
    await db.saveState(state, 5);
    expect(await db.loadState()).toEqual(state);
    await db.saveState(
      {
        ...state,
        fullRunning: false,
        fullAfter: null,
        retryIds: [],
        replayFrom: {}
      },
      6
    );
    expect(await db.loadState()).toMatchObject({
      fullRunning: false,
      fullAfter: null,
      retryIds: [],
      replayFrom: {}
    });
    // A report-only pass keeps its place in a row of its own.
    expect(await db.loadReportPlace()).toBeNull();
    await db.saveReportPlace(D1, 7);
    expect(await db.loadReportPlace()).toBe(D1);
    expect(await db.loadState()).toMatchObject({ fullAfter: null });
    await db.saveReportPlace(null, 8);
    expect(await db.loadReportPlace()).toBeNull();

    // It reads a decision and everything under it as the index wrote them.
    await seedChainDecision(
      index,
      {
        decision: {
          decisionId: D1,
          legacyId: '00000000-0000-4000-8000-0000000000f1',
          waveId: chainId('a0'),
          status: 'published',
          kind: 'rank',
          nextResultTime: 1_765_000_000_000,
          origin: 'legacy',
          counted: true
        },
        entries: [
          {
            entryId: E1,
            legacyId: DROP1,
            decisionId: D1,
            author: V1,
            status: 'active',
            total: '300',
            origin: 'legacy',
            lastIncrease: { time: 5, height: 1, index: 0 }
          },
          {
            entryId: E2,
            legacyId: null,
            decisionId: D1,
            author: V2,
            status: 'withdrawn',
            total: '0',
            origin: 'native'
          }
        ],
        votes: [
          {
            decisionId: D1,
            entryId: E1,
            voter: V1,
            value: '-12345678901',
            updatedHeight: 7
          }
        ],
        leaderboard: {
          decisionId: D1,
          by: 'time_weighted_score',
          scoredAt: 9,
          rows: [
            {
              rank: 1,
              entryId: E1,
              legacyId: DROP1,
              author: V1,
              score: '150',
              total: '300'
            }
          ]
        },
        results: [
          {
            resultTime: 1_764_000_000_000,
            status: 'decided',
            stage: 'final',
            origin: 'native',
            winners: []
          }
        ]
      },
      30
    );
    const read = await db.chainDecision(D1);
    expect(read).toMatchObject({
      decision: {
        decisionId: D1,
        status: 'published',
        nextResultTime: 1_765_000_000_000,
        origin: 'legacy',
        height: 30,
        data: { counted: true }
      },
      entries: [
        { entryId: E1, legacyId: DROP1, total: '300', status: 'active' },
        { entryId: E2, legacyId: null, status: 'withdrawn', origin: 'native' }
      ],
      votes: [
        { entryId: E1, voter: V1, value: '-12345678901', updatedHeight: 7 }
      ],
      board: [{ entryId: E1, rank: 1, score: '150', total: '300' }],
      results: [
        {
          resultTime: 1_764_000_000_000,
          status: 'decided',
          stage: 'final',
          origin: 'native'
        }
      ]
    });
    expect(await db.chainDecision(D2)).toBeNull();

    // A decision with no board (not published) reads null for it.
    await seedChainDecision(
      index,
      {
        decision: {
          decisionId: D2,
          waveId: chainId('a0'),
          status: 'ended',
          kind: 'rank',
          origin: 'native'
        }
      },
      40
    );
    expect((await db.chainDecision(D2))?.board).toBeNull();
    expect(await db.decisionIdsAfter(null, 10)).toEqual([D1, D2]);
    expect(await db.decisionIdsAfter(D1, 10)).toEqual([D2]);
    expect(await db.decisionIdsChangedAbove(35)).toEqual([D2]);
    expect(await db.decisionIdsChangedAbove(10)).toEqual([D1, D2]);
    expect(await db.liveDecisionIds()).toEqual([D1]);

    // It looks up times and released votes in the event log.
    await index.writeEvents(
      [
        event(20, 0, { kind: 'ENTRY_RELEASED', entryId: E1, decisionId: D1 }),
        event(20, 1, {
          kind: 'VOTE',
          origin: 'RELEASE',
          entryId: E1,
          decisionId: D1,
          actor: V1,
          data: { oldValue: '40', newValue: '0' }
        }),
        event(21, 0, {
          kind: 'RESULT_FINAL',
          decisionId: D1,
          data: { resultTime: 1_764_000_000_000 }
        })
      ],
      22,
      UNKNOWN_SCAN
    );
    expect(await db.blockTimes([20, 21, 99])).toEqual(
      new Map([
        [20, 20_000],
        [21, 21_000]
      ])
    );
    expect(await db.resultFinalTimes(D1)).toEqual(
      new Map([[1_764_000_000_000, 21_000]])
    );
    expect(await db.releasedVotes([E1])).toEqual(
      new Map([[E1, new Map([[V1, '40']])]])
    );
    // A failed decision's VOTE events, read again by its entries, between
    // two places of the log.
    await index.writeEvents(
      [
        event(23, 0, {
          entryId: E1,
          decisionId: D1,
          actor: V1,
          data: { oldValue: '0', newValue: '5', entryTotalAfter: '305' }
        }),
        event(23, 1, { entryId: E2, decisionId: D2, actor: V1 }),
        event(23, 2, { kind: 'ENTRY_CREATED', entryId: E1, decisionId: D1 }),
        event(24, 0, { entryId: E1, decisionId: D1, actor: V2 }),
        event(25, 0, { entryId: E1, decisionId: D1, actor: V1 })
      ],
      26,
      UNKNOWN_SCAN
    );
    expect(
      await db.decisionVoteEvents(
        D1,
        [E1],
        { height: 20, seq: 1 },
        { height: 24, seq: 0 },
        10
      )
    ).toEqual([
      {
        height: 23,
        seq: 0,
        blockTime: 23_000,
        kind: 'VOTE',
        origin: 'OPERATION',
        entryId: E1,
        actor: V1,
        data: { oldValue: '0', newValue: '5', entryTotalAfter: '305' }
      },
      expect.objectContaining({ height: 24, seq: 0, actor: V2 })
    ]);
    expect(
      (
        await db.decisionVoteEvents(
          D1,
          [E1, E2],
          null,
          { height: 99, seq: 0 },
          2
        )
      ).map((e) => `${e.height}:${e.seq}`)
    ).toEqual(['20:1', '23:0']);

    // It maps principals to profiles through the identity mirror's table.
    expect(await db.hasPrincipalMap()).toBe(true);
    await mapPrincipals(sqlExecutor, { [V1]: 'profile-1' });
    expect(await db.profilesOfPrincipals([V1, V2])).toEqual(
      new Map([[V1, 'profile-1']])
    );
    expect(await db.profilesWithPrincipal(['profile-1', 'profile-2'])).toEqual(
      new Set(['profile-1'])
    );

    // It reads a competition and its rows, locking it in a transaction.
    const { competitionId, entryIds } = await seedImportedCompetition(
      sqlExecutor,
      { waveId: WAVE, authorId: 'profile-a', dropIds: [DROP1, DROP2] }
    );
    const competition = await db.executeNativeQueriesInTransaction(
      (connection) => db.targetCompetition(competitionId, [], null, connection)
    );
    expect(competition).toMatchObject({
      competition: {
        id: competitionId,
        waveId: WAVE,
        legacyWaveId: WAVE,
        type: 'RANK',
        lifecycle: 'PUBLISHED',
        capabilities: []
      },
      entries: expect.arrayContaining([
        expect.objectContaining({
          id: entryIds[DROP1],
          dropId: DROP1,
          status: 'ACTIVE'
        })
      ]),
      votes: [],
      board: [],
      decisions: [],
      winners: []
    });
    expect(await db.targetCompetition(DROP1, [], null)).toBeNull();

    // It keeps documents by CID.
    const bytes = canonicalDocBytes({ a: 1 });
    const cid = docCid(bytes);
    expect(await db.findDocument(cid)).toBeNull();
    await db.saveDocument(cid, 8, bytes);
    await db.saveDocument(cid, 8, bytes);
    expect(await db.findDocument(cid)).toEqual(bytes);
    // A document larger than a statement's share is written in parts.
    const large = canonicalDocBytes({ text: 'x'.repeat(23_456) });
    const largeCid = docCid(large);
    await db.saveDocument(largeCid, 8, large);
    expect(await db.findDocument(largeCid)).toEqual(large);
  });
});
