import { appFeatures } from '@/app-features';
import {
  ART_CURATION_TOKEN_WATCH_DROPS_TABLE,
  ART_CURATION_TOKEN_WATCHES_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  DROPS_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  DROP_VOTER_STATE_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { ArtCurationTokenWatchService } from '@/art-curation/art-curation-token-watch.service';
import { artCurationTokenWatchDb } from '@/art-curation/art-curation-token-watch.db';
import { artCurationTokenWatchOnchainService } from '@/art-curation/art-curation-token-watch.onchain';
import { dropVotingDb } from '@/api/drops/drop-voting.db';
import { dropsDb } from '@/drops/drops.db';
import { waveDecisionsDb } from '@/waves/wave-decisions.db';
import { waveLeaderboardCalculationService } from '@/waves/wave-leaderboard-calculation.service';
import {
  revokeRepBasedDropOverVotes,
  revokeTdhBasedDropWavesOverVotes
} from '@/drops/participation-drops-over-vote-revocation';
import { userNotifier } from '@/notifications/user.notifier';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { WaveType, WaveCreditScope } from '@/entities/IWave';
import { Timer } from '@/time';
import { legacyCompetitionEntryId } from './competition-id';
import { legacyGetView } from './legacy-competition-get-facade';
import {
  installMigrationCapture,
  migrationCaptureHealthy,
  migrationTriggerName,
  MIGRATION_SOURCE_TABLES
} from './competition-migration-capture';

const primary = '11000000-0000-4000-8000-000000000001';
const tdhSibling = '11000000-0000-4000-8000-000000000003';
const repSibling = '11000000-0000-4000-8000-000000000002';
const voter = 'retained-merged-voter';
const sourceVoter = 'old-physical-voter';
const wave = aWave(
  { type: WaveType.RANK },
  { id: 'prepared-hub', name: 'Prepared hub' }
);
const namespaces = [primary, tdhSibling, repSibling];
const entryId = (id: string) => legacyCompetitionEntryId(id, `drop-${id}`);
let restoreCapture = false;

async function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await sqlExecutor.execute(
    `insert into ${table} (${columns.map((column) => `\`${column}\``).join(',')}) values (${columns.map((column) => `:${column}`).join(',')})`,
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value !== null && typeof value === 'object' && !(value instanceof Date)
          ? JSON.stringify(value)
          : value
      ])
    )
  );
}

async function addEntry(id: string, dropId = `drop-${id}`, value = 10) {
  const entry = legacyCompetitionEntryId(id, dropId);
  await insert(DROPS_TABLE, {
    id: dropId,
    wave_id: wave.id,
    author_id: 'author',
    created_at: 1,
    parts_count: 1,
    drop_type: 'WINNER'
  });
  await insert(COMPETITION_ENTRIES_TABLE, {
    id: entry,
    competition_id: id,
    wave_id: wave.id,
    drop_id: dropId,
    submitter_id: 'author',
    status: 'ACTIVE',
    config_version: 1,
    submitted_at: 1
  });
  await insert(COMPETITION_VOTES_TABLE, {
    id: legacyCompetitionEntryId(id, `vote:${dropId}`),
    competition_id: id,
    entry_id: entry,
    voter_profile_id: voter,
    value,
    credit_spent: value,
    created_at: 1,
    updated_at: 10
  });
  await insert(COMPETITION_ENTRY_RUNTIME_TABLE, {
    competition_id: id,
    entry_id: entry,
    real_time_rating: value,
    last_increased_at: 10,
    over_threshold_since: null,
    updated_at: 10
  });
  for (const kind of ['AGGREGATE', 'VOTER']) {
    await insert(COMPETITION_SCORE_HISTORY_TABLE, {
      competition_id: id,
      kind,
      sequence: dropId.endsWith('second') ? 2 : 1,
      entry_id: entry,
      drop_id: dropId,
      voter_profile_id: kind === 'VOTER' ? voter : '',
      value,
      occurred_at: 10
    });
  }
  return entry;
}

async function installHistoryViews(native: boolean) {
  for (const [table, kind] of [
    [DROP_REAL_VOTE_IN_TIME_TABLE, 'AGGREGATE'],
    [DROP_REAL_VOTER_VOTE_IN_TIME_TABLE, 'VOTER']
  ] as const) {
    const definition = native
      ? `select h.sequence as id,h.drop_id,c.wave_id,h.occurred_at as timestamp,h.value as vote${kind === 'VOTER' ? ',h.voter_profile_id as voter_id' : ''}
         from ${COMPETITION_SCORE_HISTORY_TABLE} h join ${COMPETITIONS_TABLE} c on c.id=h.competition_id
         where h.kind='${kind}' and c.legacy_wave_id=c.wave_id and c.storage_mode='NATIVE'`
      : `select * from ${table}`;
    await sqlExecutor.execute(
      `create or replace view ${legacyGetView(table)} as ${definition}`
    );
  }
}

describeWithSeed(
  'Preparation workers during final writer overlap',
  [
    withWaves([wave]),
    withIdentities([
      anIdentity(
        { tdh: 5 },
        {
          profile_id: voter,
          handle: voter,
          consolidation_key: voter,
          primary_address: `0x${'a'.repeat(40)}`
        }
      ),
      anIdentity(
        { tdh: 0 },
        {
          profile_id: sourceVoter,
          handle: sourceVoter,
          consolidation_key: sourceVoter,
          primary_address: `0x${'b'.repeat(40)}`
        }
      )
    ])
  ],
  () => {
    beforeEach(async () => {
      jest
        .spyOn(appFeatures, 'isNativeCompetitionExecutionEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionWritesEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isDropOvervoteRevocationEnabled')
        .mockReturnValue(true);
      jest.spyOn(userNotifier, 'notifyOfDropVote').mockResolvedValue(undefined);
      for (const id of namespaces) {
        await insert(COMPETITIONS_TABLE, {
          id,
          wave_id: wave.id,
          legacy_wave_id: id === primary ? wave.id : null,
          storage_mode: 'NATIVE',
          execution_mode: 'ACTIVE',
          type: 'RANK',
          lifecycle: 'PUBLISHED',
          title: id,
          participation_config: {
            group_id: null,
            required_metadata: [],
            required_media: []
          },
          voting_config: {
            credit_type: id === repSibling ? 'REP' : 'TDH',
            credit_scope: 'WAVE',
            credit_category: id === repSibling ? 'Builder' : null,
            credit_creditor: id === repSibling ? 'creditor' : null,
            credit_nfts: [],
            group_id: null,
            max_votes_per_identity_to_entry: null
          },
          decision_config: {
            strategy: null,
            next_decision_time: null,
            time_lock_ms: 0,
            winning_min_threshold: null,
            winning_threshold_min_duration_ms: 0,
            max_winners: null
          },
          winner_config: {},
          outcome_config: [],
          config_version: 1,
          published_at: 1,
          created_at: 1,
          updated_at: 1
        });
        await addEntry(id);
      }
      await insert(COMPETITION_CAPABILITIES_TABLE, {
        competition_id: primary,
        wave_id: wave.id,
        capability: 'CURATION',
        assigned_at: 1
      });
      // A final profile merge moved native allocations; the retired physical profile stays stale.
      await insert(DROP_VOTER_STATE_TABLE, {
        voter_id: sourceVoter,
        drop_id: `drop-${primary}`,
        wave_id: wave.id,
        votes: 999
      });
      await insert(DROP_REAL_VOTE_IN_TIME_TABLE, {
        drop_id: `drop-${primary}`,
        wave_id: wave.id,
        timestamp: 1,
        vote: 999
      });
      await insert(DROP_REAL_VOTER_VOTE_IN_TIME_TABLE, {
        drop_id: `drop-${primary}`,
        wave_id: wave.id,
        voter_id: sourceVoter,
        timestamp: 1,
        vote: 999
      });
      await insert(RATINGS_TABLE, {
        rater_profile_id: 'creditor',
        matter_target_id: voter,
        matter: 'REP',
        matter_category: 'Builder',
        rating: 5,
        last_modified: new Date('2026-01-01T00:00:00Z')
      });
      await installHistoryViews(true);
    });
    afterEach(async () => {
      await installHistoryViews(false);
      if (restoreCapture) {
        await installMigrationCapture(sqlExecutor);
        restoreCapture = false;
      }
      jest.restoreAllMocks();
    });

    it('reconciles merged native TDH allocations and siblings despite missing physical target votes', async () => {
      const rawRead = jest.spyOn(dropsDb, 'findDropVotesForWaves');
      jest
        .spyOn(
          dropsDb,
          'findTdhBasedSubmissionDropOvervotersWithOvervoteAmounts'
        )
        .mockResolvedValue([
          {
            profile_id: voter,
            wave_id: wave.id,
            drop_id: `drop-${primary}`,
            credit_scope: WaveCreditScope.WAVE,
            credit_limit: 0,
            total_given_votes: 999
          }
        ]);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        revokeTdhBasedDropWavesOverVotes(connection)
      );
      expect(
        await sqlExecutor.execute<{ competition_id: string; value: number }>(
          `select competition_id,value from ${COMPETITION_VOTES_TABLE} where voter_profile_id=:voter order by competition_id`,
          { voter }
        )
      ).toEqual([
        { competition_id: primary, value: 5 },
        { competition_id: repSibling, value: 10 },
        { competition_id: tdhSibling, value: 5 }
      ]);
      expect(rawRead).not.toHaveBeenCalled();
      expect(userNotifier.notifyOfDropVote).toHaveBeenCalledTimes(2);
      expect(userNotifier.notifyOfDropVote).toHaveBeenCalledWith(
        expect.objectContaining({
          voter_id: voter,
          vote: 5,
          vote_change: -5,
          total_vote: 5
        }),
        null,
        expect.anything()
      );
      expect(
        await sqlExecutor.oneOrNull(
          `select votes from ${DROP_VOTER_STATE_TABLE} where voter_id=:voter and drop_id=:dropId`,
          { voter, dropId: `drop-${primary}` }
        )
      ).toEqual({ votes: 5 });
      expect(
        await sqlExecutor.oneOrNull<{ count: number }>(
          `select count(*) as count from ${COMPETITION_VOTE_HISTORY_TABLE} where voter_profile_id=:voter`,
          { voter }
        )
      ).toEqual({ count: 2 });
    });

    it('reconciles REP sibling votes even when the old physical REP probe finds no votes', async () => {
      expect(
        await dropsDb.hasProfileVotedInAnyOpenRepBasedWave(voter, {})
      ).toBe(false);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        revokeRepBasedDropOverVotes(
          {
            rep_recipient_id: voter,
            rep_giver_id: 'creditor',
            credit_category: 'Builder'
          },
          connection
        )
      );
      expect(
        await sqlExecutor.oneOrNull(
          `select value from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id: repSibling }
        )
      ).toEqual({ value: 5 });
      expect(userNotifier.notifyOfDropVote).toHaveBeenCalledTimes(1);
      expect(
        await sqlExecutor.oneOrNull(
          `select votes from ${DROP_VOTER_STATE_TABLE} where voter_id=:source`,
          { source: sourceVoter }
        )
      ).toEqual({ votes: 999 });
    });

    it('resolves native curation using current entry history, preserving retries and same-time transfers with triggers off', async () => {
      // Other suites can install capture in this reused disposable worker DB.
      // Exercise the cutover state explicitly and restore its prior baseline.
      restoreCapture = await migrationCaptureHealthy(sqlExecutor, {});
      await installMigrationCapture(sqlExecutor);
      for (const table of MIGRATION_SOURCE_TABLES) {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
          await sqlExecutor.execute(
            `drop trigger if exists \`${migrationTriggerName(table, operation)}\``
          );
        }
      }
      const secondDrop = 'drop-second';
      const secondEntry = await addEntry(primary, secondDrop, 20);
      for (const [index, dropId] of Array.from(
        [`drop-${primary}`, secondDrop, 'raw-orphan'].entries()
      )) {
        if (dropId === 'raw-orphan')
          await insert(DROPS_TABLE, {
            id: dropId,
            wave_id: wave.id,
            author_id: 'author',
            drop_type: 'PARTICIPATORY',
            created_at: 1,
            parts_count: 1
          });
        const watch = {
          id: `watch-${index}`,
          wave_id: wave.id,
          canonical_id: `nft-${index}`,
          chain: 'eth',
          contract: `0x${'c'.repeat(40)}`,
          token_id: String(index),
          owner_at_submission: `0x${'a'.repeat(40)}`,
          status: 'ACTIVE',
          start_block: 1,
          start_time: 1,
          last_checked_block: 1,
          created_at: 1,
          updated_at: 1
        };
        await insert(ART_CURATION_TOKEN_WATCHES_TABLE, watch);
        await insert(ART_CURATION_TOKEN_WATCH_DROPS_TABLE, {
          watch_id: watch.id,
          drop_id: dropId,
          canonical_id: watch.canonical_id,
          url_in_text: 'https://example.com/nft',
          owner_at_submission: watch.owner_at_submission,
          created_at: 1,
          updated_at: 1
        });
      }
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from information_schema.triggers where trigger_schema=database() and trigger_name like 'competition_capture_%'`
        )
      ).toEqual({ count: 0 });
      jest
        .spyOn(artCurationTokenWatchOnchainService, 'findFirstTransfer')
        .mockImplementation(async ({ tokenId }) => ({
          checkedThroughBlock: 2,
          event: {
            from: `0x${'a'.repeat(40)}`,
            to: `0x${'b'.repeat(40)}`,
            txHash: `0xtx${tokenId}`,
            blockNumber: 2,
            logIndex: Number(tokenId),
            timestampMs: 1000
          }
        }));
      jest
        .spyOn(artCurationTokenWatchOnchainService, 'findTransferPrice')
        .mockResolvedValue({ amountRaw: null, amount: null, currency: null });
      const service = new ArtCurationTokenWatchService(
        artCurationTokenWatchDb,
        artCurationTokenWatchOnchainService,
        dropVotingDb,
        dropsDb,
        waveDecisionsDb,
        waveLeaderboardCalculationService
      );
      await service.processCycle(new Timer('curation-overlap'));
      await service.processCycle(new Timer('curation-retry'));
      expect(
        await sqlExecutor.execute(
          `select entry_id,final_rating from ${COMPETITION_DECISION_WINNERS_TABLE} order by final_rating`
        )
      ).toEqual([
        { entry_id: entryId(primary), final_rating: 10 },
        { entry_id: secondEntry, final_rating: 20 }
      ]);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from ${COMPETITION_DECISIONS_TABLE}`
        )
      ).toEqual({ count: 1 });
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from ${COMPETITION_OUTBOX_TABLE} where json_unquote(json_extract(event,'$.event_type'))='COMPETITION_DECISION_COMPLETED'`
        )
      ).toEqual({ count: 2 });
      expect(
        await sqlExecutor.oneOrNull(
          `select sum(value) as value from ${COMPETITION_WINNER_VOTES_TABLE} where competition_id=:id`,
          { id: primary }
        )
      ).toEqual({ value: 30 });
      expect(
        await sqlExecutor.execute(
          `select status from ${ART_CURATION_TOKEN_WATCHES_TABLE} order by id`
        )
      ).toEqual([
        { status: 'RESOLVED' },
        { status: 'RESOLVED' },
        { status: 'ACTIVE' }
      ]);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from ${COMPETITION_ENTRIES_TABLE} where drop_id='raw-orphan'`
        )
      ).toEqual({ count: 0 });
    });
  }
);
