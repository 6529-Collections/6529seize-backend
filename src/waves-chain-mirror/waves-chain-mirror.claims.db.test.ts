import 'reflect-metadata';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_ENTRIES_TABLE,
  DROPS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  ChainDecisionObjects,
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
  ChainObject,
  WavesChainApi
} from '@/waves-chain-index/waves-chain-index.api';
import {
  ClaimBuild,
  ClaimBuildMessage,
  ClaimBuildPort,
  claimBuildsOf
} from '@/waves-chain-index/waves-chain-index.claims';
import {
  EMPTY_INDEX_STATE,
  WavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import {
  ChainEvent,
  UNKNOWN_SCAN
} from '@/waves-chain-index/waves-chain-index.events';
import { WavesChainIndex } from '@/waves-chain-index/waves-chain-index.service';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { StoredDocuments } from './waves-chain-mirror.docs';
import { resultDecisionId } from './waves-chain-mirror.ids';
import { WavesChainMirror } from './waves-chain-mirror.service';

const D = chainId('d1');
const EN = chainId('e8');
const EL = chainId('e1');
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
    expect(await db.skippedClaimBuilds(D)).toHaveLength(1);
    // A rebuild writes no claim builds, so it reads none.
    expect(
      await new WavesChainMirrorDb(
        () => sqlExecutor,
        'rebuild'
      ).skippedClaimBuilds(D)
    ).toEqual([]);

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

  // ------------------------------------- from the index's log to its send

  const MAIN_STAGE: ReadonlySet<string> = new Set([D]);
  const RESULT_HEIGHT = 40;

  /**
   * The Main Stage decision D, imported (its wave, competition and one drop
   * on 6529.io), as the index holds it at 45: its occurrence 3, decided at
   * T1 and final at RESULT_HEIGHT, won by `winner`. The feed has reached 46
   * (logResultFinal takes the log there).
   */
  async function seedMainStageResult(
    winner: ChainObject
  ): Promise<ChainDecisionObjects> {
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
    const chain: ChainDecisionObjects = {
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
      entries: [winner],
      leaderboard: { decisionId: D, by: 'total', rows: [] },
      results: [
        {
          resultTime: T1,
          occurrence: 3,
          status: 'decided',
          stage: 'final',
          origin: 'native',
          settledHeight: RESULT_HEIGHT,
          winners: [{ entryId: winner.entryId, rank: 1, score: '9' }]
        }
      ]
    };
    await seedChainDecision(index, chain, 45);
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
    return chain;
  }

  /**
   * Logs the result as the index's log does (WavesChainIndex.logEvents):
   * the RESULT_FINAL event it derives (waves-chain-index.events.ts), each
   * winner with the legacy id and manifest hash the index holds for its
   * entry, written with the claim builds claimBuildsOf calls for in one
   * writeEvents call. Its block's time is the one the mirror's gateway
   * gives for that height.
   */
  async function logResultFinal(winnerId: string): Promise<ClaimBuild[]> {
    const held = await index.eventObjects({
      entries: [winnerId],
      decisions: [D]
    });
    const decision = held.decisions.get(D);
    const winner = held.entries.get(winnerId);
    const event: ChainEvent = {
      height: RESULT_HEIGHT,
      seq: 0,
      blockTime: BLOCK_TIME_BASE + RESULT_HEIGHT,
      kind: 'RESULT_FINAL',
      origin: 'OPERATION',
      waveId: decision?.waveId ?? null,
      waveLegacyId: null,
      decisionId: D,
      decisionLegacyId: decision?.legacyId ?? null,
      entryId: null,
      entryLegacyId: null,
      pollId: null,
      pollLegacyId: null,
      groupId: null,
      groupLegacyId: null,
      actor: null,
      data: {
        resultTime: T1,
        occurrence: 3,
        status: 'decided',
        winnerCount: 1,
        winners: [
          {
            entryId: winnerId,
            rank: 1,
            score: '9',
            legacyId: winner?.legacyId ?? null,
            manifestHash: winner?.manifestHash ?? null
          }
        ],
        pauseId: null,
        settledHeight: RESULT_HEIGHT
      }
    };
    const builds = claimBuildsOf([event], MAIN_STAGE, 'net-1');
    await index.writeEvents([event], 46, UNKNOWN_SCAN, builds);
    return builds;
  }

  /**
   * The chain as the index reads it on these runs, at the height its feed
   * and log have reached: the head, the import done, and the decision and
   * its board as seeded (a live counted decision is read again each run).
   * Any other read fails the run.
   */
  function chainAt(chain: ChainDecisionObjects): WavesChainApi {
    const unexpected = (read: string) => () =>
      Promise.reject(new Error(`unexpected chain read: ${read}`));
    return {
      head: async () => ({
        finalizedHeight: 45,
        finalizedTime: BLOCK_TIME_BASE + 45,
        network: 'net-1'
      }),
      importState: async () => ({ completed: true, startedAt: 1 }),
      decision: async (id) => (id === D ? chain.decision : null),
      decisionLeaderboard: async (id) =>
        id === D ? (chain.leaderboard ?? null) : null,
      listGroups: unexpected('listGroups'),
      listWaves: unexpected('listWaves'),
      listDecisions: unexpected('listDecisions'),
      group: unexpected('group'),
      wave: unexpected('wave'),
      entry: unexpected('entry'),
      poll: unexpected('poll'),
      result: unexpected('result'),
      waveRoles: unexpected('waveRoles'),
      wavePolls: unexpected('wavePolls'),
      waveRep: unexpected('waveRep'),
      decisionEntries: unexpected('decisionEntries'),
      decisionResults: unexpected('decisionResults'),
      entryVotes: unexpected('entryVotes'),
      feed: unexpected('feed')
    };
  }

  /** The index's claim build port, recording its freezes and sends in order. */
  function recordedClaimBuilds() {
    const calls: string[] = [];
    const sent: ClaimBuildMessage[] = [];
    const port: ClaimBuildPort = {
      enabled: () => true,
      mainStage: () => MAIN_STAGE,
      freezeCollaboration: async (dropId) => {
        calls.push(`freeze ${dropId}`);
      },
      send: async (message) => {
        calls.push(`send ${message.drop_id}`);
        sent.push(JSON.parse(JSON.stringify(message)));
        return `m-${sent.length}`;
      }
    };
    return { port, calls, sent };
  }

  /** The index over the seeded chain; no full read falls due on its runs. */
  const indexOver = (chain: ChainDecisionObjects, claims: ClaimBuildPort) =>
    new WavesChainIndex(
      chainAt(chain),
      index,
      () => NOW,
      Number.MAX_SAFE_INTEGER,
      claims
    );

  async function claimBuildRows() {
    return (await index.claimBuildRows()).map((row) => ({
      decision_id: row.decision_id,
      occurrence: Number(row.occurrence),
      entry_id: row.entry_id,
      drop_id: row.drop_id,
      status: row.status,
      reason: row.reason,
      attempts: Number(row.attempts),
      message_id: row.message_id
    }));
  }

  it("sends a chain-made winner's claim build once the mirror has written its drop: named by the entry id, frozen first, sent once", async () => {
    // An entry made on the chain: no legacy id. Its drop's id is the entry
    // id, 66 characters: no 6529.io drop UUID.
    expect(EN).toMatch(/^0x[0-9a-f]{64}$/);
    const doc = entryManifestDoc({
      nonce: `0x${'5a'.repeat(16)}`,
      decision: D,
      wave: chainId('a0'),
      author: AUTHOR,
      createdAt: CREATED - 5,
      fields: { wave_id: WAVE, parts: [{ content: 'The work', media: [] }] }
    });
    await db.saveDocument(doc.contentCid, 8, doc.bytes);
    const chain = await seedMainStageResult({
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
    });
    const claims = recordedClaimBuilds();
    const indexer = indexOver(chain, claims.port);

    // The log's build for the result: skipped, no 6529.io drop yet.
    expect(await logResultFinal(EN)).toEqual([
      {
        network: 'net-1',
        decisionId: D,
        occurrence: 3,
        height: RESULT_HEIGHT,
        entryId: EN,
        dropId: null,
        message: null,
        status: 'skipped',
        reason: 'entry created on the chain: no 6529.io drop'
      }
    ]);
    // The index's run sends nothing for it.
    const before = await indexer.run({ budgetMs: 60_000 });
    expect(before.mode).toBe('indexed');
    expect(before.claimBuilds).toEqual({ queued: 0, sent: 0, failed: 0 });
    expect(claims.calls).toEqual([]);

    // The mirror writes the winner's drop, and turns the build pending.
    const mirrored = await mirror(NOW).run({ budgetMs: 60_000 });
    expect(mirrored.changes).toMatchObject({
      drops: { insert: 1 },
      chain_claim_builds: { update: 1 }
    });
    expect(
      await sqlExecutor.execute(
        `select id from ${DROPS_TABLE} where id = :id`,
        { id: EN }
      )
    ).toEqual([{ id: EN }]);
    expect(await claimBuildRows()).toEqual([
      expect.objectContaining({ status: 'pending', drop_id: null })
    ]);

    // The index's next run freezes that drop's collaboration for the mint,
    // then sends the build with the result's chain context.
    const after = await indexer.run({ budgetMs: 60_000 });
    expect(after.mode).toBe('indexed');
    expect(after.claimBuilds).toEqual({ queued: 0, sent: 1, failed: 0 });
    expect(claims.calls).toEqual([`freeze ${EN}`, `send ${EN}`]);
    expect(claims.sent).toEqual([
      {
        drop_id: EN,
        chain: {
          decision_id: D,
          occurrence: 3,
          entry_id: EN,
          height: RESULT_HEIGHT,
          manifest_hash: doc.manifestHash.toLowerCase()
        }
      }
    ]);
    // Sent. Its drop_id column (varchar(36), a 6529.io drop's UUID) stays
    // empty: the message names the drop.
    expect(await claimBuildRows()).toEqual([
      {
        decision_id: D,
        occurrence: 3,
        entry_id: EN,
        drop_id: null,
        status: 'sent',
        reason: null,
        attempts: 1,
        message_id: 'm-1'
      }
    ]);

    // Never again.
    await indexer.run({ budgetMs: 60_000 });
    expect(claims.calls).toHaveLength(2);
  });

  it("never turns a 'no manifest hash' skipped build pending, nor sends it", async () => {
    // An imported entry (its drop DROP1) whose manifest hash the index
    // doesn't hold: the log's build for its win is skipped with that reason.
    const chain = await seedMainStageResult({
      entryId: EL,
      legacyId: DROP1,
      decisionId: D,
      author: AUTHOR,
      status: 'winner',
      total: '9',
      origin: 'legacy',
      createdMs: 1
    });
    const claims = recordedClaimBuilds();
    const indexer = indexOver(chain, claims.port);
    expect(await logResultFinal(EL)).toEqual([
      {
        network: 'net-1',
        decisionId: D,
        occurrence: 3,
        height: RESULT_HEIGHT,
        entryId: EL,
        dropId: DROP1,
        message: null,
        status: 'skipped',
        reason: 'no manifest hash'
      }
    ]);
    const skipped = {
      decision_id: D,
      occurrence: 3,
      entry_id: EL,
      drop_id: DROP1,
      status: 'skipped',
      reason: 'no manifest hash',
      attempts: 0,
      message_id: null
    };
    await indexer.run({ budgetMs: 60_000 });

    // The mirror writes the result, and leaves the build as it is.
    const mirrored = await mirror(NOW).run({ budgetMs: 60_000 });
    expect(mirrored.decisions).toMatchObject({ mirrored: 1, failed: 0 });
    expect(mirrored.changes).not.toHaveProperty('chain_claim_builds');
    expect(
      await sqlExecutor.execute(
        `select drop_id, status, \`rank\`
           from ${COMPETITION_ENTRIES_TABLE} where drop_id = :id`,
        { id: DROP1 }
      )
    ).toEqual([{ drop_id: DROP1, status: 'WINNER', rank: 1 }]);
    expect(await claimBuildRows()).toEqual([skipped]);

    // The index's next run freezes and sends nothing.
    const after = await indexer.run({ budgetMs: 60_000 });
    expect(after.mode).toBe('indexed');
    expect(after.claimBuilds).toEqual({ queued: 0, sent: 0, failed: 0 });
    expect(claims.calls).toEqual([]);
    expect(await index.pendingClaimBuilds(10)).toEqual([]);
    expect(await claimBuildRows()).toEqual([skipped]);
  });
});
