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
import { dropsDb } from '@/drops/drops.db';
import { userNotifier } from '@/notifications/user.notifier';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { WaveType } from '@/entities/IWave';
import { Timer } from '@/time';
import { legacyCompetitionEntryId } from './competition-id';

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

describeWithSeed(
  'Native CURATION confirmed transfer retries',
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
      jest.spyOn(userNotifier, 'notifyOfDropVote').mockResolvedValue(undefined);
      for (const id of namespaces) {
        await insert(COMPETITIONS_TABLE, {
          id,
          wave_id: wave.id,
          legacy_wave_id: id === primary ? wave.id : null,
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
      // A final profile merge moved native allocations. The old profile remains,
      // while obsolete physical allocations and history are absent.
      expect(
        await sqlExecutor.execute(
          'select TABLE_NAME from information_schema.TABLES where TABLE_SCHEMA=database() and TABLE_NAME in (:tables)',
          {
            tables: [
              DROP_VOTER_STATE_TABLE,
              DROP_REAL_VOTE_IN_TIME_TABLE,
              DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
            ]
          }
        )
      ).toEqual([]);
      await insert(RATINGS_TABLE, {
        rater_profile_id: 'creditor',
        matter_target_id: voter,
        matter: 'REP',
        matter_category: 'Builder',
        rating: 5,
        last_modified: new Date('2026-01-01T00:00:00Z')
      });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
    });

    it('resolves native curation using current entry history, preserving retries and same-time transfers with triggers off', async () => {
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
        dropsDb
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
        { status: 'CANCELLED' }
      ]);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from ${COMPETITION_ENTRIES_TABLE} where drop_id='raw-orphan'`
        )
      ).toEqual({ count: 0 });
    });
  }
);
