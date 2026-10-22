import {
  historicalCompetitionFixture,
  seedRetainedScoreFixture,
  seedRetainedDistributionFixture,
  seedRetainedPublicationFixture
} from '@/tests/fixtures/retained-competition.fixture';
import * as tables from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import {
  WaveType,
  WaveCreditType,
  ParticipationRequiredMedia,
  WaveRequiredMetadataItemType
} from '@/entities/IWave';
import {
  legacyCompetitionId,
  legacyCompetitionEntryId,
  legacyCompetitionOutcomeId,
  legacyCompetitionDistributionItemId,
  legacyCompetitionDecisionId,
  legacyCompetitionPauseId,
  stableUuid
} from './competition-id';
import {
  FROZEN_NATIVE_GET_TABLES,
  frozenNativeGetView,
  installFrozenNativeGetProjections
} from './contract-fixtures/origin-main-native-get-projections.fixture';
import {
  legacyGetView,
  installLegacyCompetitionGetFacade,
  withLegacyCompetitionGetFacade
} from './legacy-competition-get-facade';
import {
  normalizeDefaultCompetition,
  selectDefaultCompetition
} from './default-competition';
import { competitionRepository } from './competition.repository';
import { DropVotingDb } from '@/api/drops/drop-voting.db';
import { DropsDb, LeaderboardSort } from '@/drops/drops.db';
import { PageSortDirection } from '@/api/page-request';
import { waveHubConfigurationFromWave } from '@/waves/wave-hub-configuration';

const primaryWave = aWave(
  {
    type: WaveType.RANK,
    created_by: 'artist',
    voting_credit_type: WaveCreditType.CARD_SET_TDH,
    participation_group_id: 'participants',
    voting_group_id: 'voters',
    admin_group_id: 'admins',
    participation_signature_required: true,
    voting_signature_required: true,
    participation_required_media: [ParticipationRequiredMedia.IMAGE],
    participation_required_metadata: [
      {
        name: 'nullable metadata value',
        type: WaveRequiredMetadataItemType.STRING
      }
    ],
    participation_period_start: 1000,
    participation_period_end: null,
    voting_period_start: 1000,
    voting_period_end: 9000,
    time_lock_ms: 2000,
    max_winners: 2,
    forbid_negative_votes: false,
    participation_terms: 'Retain original terms',
    next_decision_time: 9000,
    decisions_strategy: {
      first_decision_time: 9000,
      subsequent_decisions: [1000],
      is_rolling: false
    }
  },
  { id: 'rich-contract-primary', name: 'Stale physical title', serial_no: 1 }
);
const chatWave = aWave(
  {
    type: WaveType.CHAT,
    chat_links_disabled: true,
    chat_replies_open: true,
    chat_replies_collapsed: true,
    admin_drop_deletion_enabled: true,
    parent_wave_id: null
  },
  { id: 'rich-contract-chat', name: 'Shared chat', serial_no: 2 }
);
const dmWave = aWave(
  {
    type: WaveType.CHAT,
    is_direct_message: true,
    visibility_group_id: 'dm-group',
    chat_group_id: 'dm-group',
    participation_group_id: 'dm-group',
    admin_group_id: 'dm-group'
  },
  { id: 'rich-contract-dm', name: 'Shared direct message', serial_no: 3 }
);
const id = legacyCompetitionId(primaryWave.id);
const sibling = '80000000-0000-4000-8000-000000000001';
const names = [
  'active',
  'unvoted',
  'zero',
  'negative',
  'winner',
  'withdrawn',
  'disqualified'
];
const drop = (name: string) => `contract-${name}`;
const entry = (name: string) => legacyCompetitionEntryId(id, drop(name));
const completed = legacyCompetitionDecisionId(id, 2000);
const pending = legacyCompetitionDecisionId(id, 4000);
const outcome1 = legacyCompetitionOutcomeId(id, 1),
  outcome2 = legacyCompetitionOutcomeId(id, 2);
const aggregate = [
  { id: 30, timestamp: 1100, vote: 90 },
  { id: 7, timestamp: 1100, vote: 11 },
  { id: 35, timestamp: 2200, vote: -9 }
];
const voter = [
  { id: 3, timestamp: 1100, vote: 4 },
  { id: 9, timestamp: 1100, vote: 71 },
  { id: 12, timestamp: 2200, vote: 0 }
];
async function insert(table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  if (table === tables.DROPS_TABLE)
    rows = rows.map((row) => ({ hide_link_preview: false, ...row }));
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  await sqlExecutor.bulkInsert(
    table,
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value
        ])
      )
    ),
    columns
  );
}
function sorted(rows: unknown[]): unknown[] {
  // These additive live native policy fields did not exist in the frozen
  // schema. Every original projection column remains compared exactly.
  const originalRows = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).filter(
        ([column]) =>
          column !== 'hub_participation_config' &&
          column !== 'hub_voting_config'
      )
    )
  );
  const canonical = (row: unknown) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(row as Record<string, unknown>).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      )
    );
  return originalRows.sort((left, right) =>
    canonical(left).localeCompare(canonical(right))
  );
}

describeWithSeed(
  'rich permanent GET projection parity against frozen origin/main',
  [withWaves([primaryWave, chatWave, dmWave], true)],
  () => {
    afterEach(async () => {
      for (const table of FROZEN_NATIVE_GET_TABLES)
        await sqlExecutor.execute(
          `DROP VIEW IF EXISTS ${frozenNativeGetView(table)}`
        );
    });
    beforeEach(async () => {
      const primary = await seedNativeOriginalPrimaryFixture(primaryWave);
      const columns = Object.keys(primary);
      await sqlExecutor.execute(
        `INSERT INTO ${tables.COMPETITIONS_TABLE} (${columns.map((column) => '`' + column + '`').join(',')})
       SELECT ${columns.map((column) => (column === 'id' ? ':sibling' : column === 'legacy_wave_id' ? 'NULL' : '`' + column + '`')).join(',')}
       FROM ${tables.COMPETITIONS_TABLE} WHERE id=:id`,
        { id, sibling }
      );
      await sqlExecutor.execute(
        `UPDATE ${tables.COMPETITIONS_TABLE} SET title='Native original title',lifecycle='ENDED',ended_at=3000,
       voting_config=JSON_SET(voting_config,'$.credit_nfts',CAST(:nfts AS JSON)) WHERE id=:id`,
        {
          id,
          nfts: JSON.stringify([
            {
              contract: '0x00000000000000000000000000000000000000a1',
              token_id: 7
            },
            {
              contract: '0x0000000000000000000000000000000000000002',
              token_id: 19
            }
          ])
        }
      );
      await sqlExecutor.execute(
        `UPDATE ${tables.COMPETITIONS_TABLE} SET title='Sibling must stay private',participation_starts_at=0,voting_starts_at=0 WHERE id=:sibling`,
        { sibling }
      );
      await insert(tables.DROPS_TABLE, [
        ...names.map((name, index) => ({
          id: drop(name),
          wave_id: primaryWave.id,
          author_id: 'artist',
          created_at: 1000 + index,
          title: index % 2 ? '' : null,
          parts_count: 1,
          drop_type: name === 'winner' ? 'WINNER' : 'PARTICIPATORY',
          signature: name === 'active' ? 'original signature bytes' : null,
          is_additional_action_promised: name === 'active' ? true : null,
          hide_link_preview: name === 'active'
        })),
        {
          id: drop('orphan-part'),
          wave_id: primaryWave.id,
          author_id: 'artist',
          created_at: 1,
          parts_count: 1,
          drop_type: 'PARTICIPATORY'
        },
        {
          id: drop('orphan-win'),
          wave_id: primaryWave.id,
          author_id: 'artist',
          created_at: 2,
          parts_count: 1,
          drop_type: 'WINNER'
        },
        {
          id: drop('sibling'),
          wave_id: primaryWave.id,
          author_id: 'sibling-artist',
          created_at: 3,
          parts_count: 1,
          drop_type: 'COMPETITION'
        },
        {
          id: drop('chat'),
          wave_id: chatWave.id,
          author_id: 'artist',
          created_at: 4,
          parts_count: 1,
          drop_type: 'CHAT'
        },
        {
          id: drop('dm'),
          wave_id: dmWave.id,
          author_id: 'artist',
          created_at: 5,
          parts_count: 1,
          drop_type: 'CHAT'
        }
      ]);
      await insert(tables.COMPETITION_ENTRIES_TABLE, [
        ...names.map((name, index) => ({
          id: entry(name),
          wave_id: primaryWave.id,
          competition_id: id,
          drop_id: drop(name),
          submitter_id: 'artist',
          status:
            name === 'winner'
              ? 'WINNER'
              : name === 'withdrawn'
                ? 'WITHDRAWN'
                : name === 'disqualified'
                  ? 'DISQUALIFIED'
                  : 'ACTIVE',
          config_version: 1,
          submitted_at: 1000 + index,
          rank: name === 'winner' ? 1 : null,
          decision_id: name === 'winner' ? completed : null,
          won_at: name === 'winner' ? 2000 : null
        })),
        {
          id: legacyCompetitionEntryId(sibling, drop('sibling')),
          wave_id: primaryWave.id,
          competition_id: sibling,
          drop_id: drop('sibling'),
          submitter_id: 'sibling-artist',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 1
        }
      ]);
      await insert(tables.COMPETITION_ENTRY_RUNTIME_TABLE, [
        {
          competition_id: id,
          entry_id: entry('active'),
          real_time_rating: 90,
          last_increased_at: 1100,
          over_threshold_since: 1200,
          updated_at: 3000
        },
        {
          competition_id: id,
          entry_id: entry('unvoted'),
          real_time_rating: 0,
          last_increased_at: null,
          over_threshold_since: null,
          updated_at: 1001
        },
        {
          competition_id: id,
          entry_id: entry('zero'),
          real_time_rating: 0,
          last_increased_at: null,
          over_threshold_since: null,
          updated_at: 1002
        },
        {
          competition_id: id,
          entry_id: entry('negative'),
          real_time_rating: -4,
          last_increased_at: null,
          over_threshold_since: null,
          updated_at: 3000
        },
        {
          competition_id: id,
          entry_id: entry('winner'),
          real_time_rating: 33,
          last_increased_at: 1101,
          over_threshold_since: null,
          updated_at: 2000
        },
        {
          competition_id: id,
          entry_id: entry('withdrawn'),
          real_time_rating: 8,
          last_increased_at: 1102,
          over_threshold_since: null,
          updated_at: 2000
        },
        {
          competition_id: id,
          entry_id: entry('disqualified'),
          real_time_rating: 9,
          last_increased_at: 1103,
          over_threshold_since: null,
          updated_at: 2000
        },
        {
          competition_id: sibling,
          entry_id: legacyCompetitionEntryId(sibling, drop('sibling')),
          real_time_rating: 999,
          last_increased_at: 1,
          over_threshold_since: null,
          updated_at: 3000
        }
      ]);
      await insert(
        tables.COMPETITION_VOTES_TABLE,
        ['active', 'zero', 'negative', 'withdrawn', 'disqualified', 'winner']
          .map((name, index) => ({
            id: stableUuid(id, `current:${name}`),
            competition_id: id,
            entry_id: entry(name),
            voter_profile_id: `voter-${index}`,
            value: [71, 0, -4, 8, 9, 0][index],
            credit_spent: Math.abs([71, 0, -4, 8, 9, 0][index]),
            created_at: 1000,
            updated_at: 3000
          }))
          .concat([
            {
              id: stableUuid(sibling, 'current'),
              competition_id: sibling,
              entry_id: legacyCompetitionEntryId(sibling, drop('sibling')),
              voter_profile_id: 'sibling-voter',
              value: 999,
              credit_spent: 999,
              created_at: 1,
              updated_at: 3000
            }
          ])
      );
      await insert(tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE, [
        {
          competition_id: id,
          entry_id: entry('active'),
          drop_id: drop('active'),
          rating: 50,
          real_time_rating: 90,
          rank: 1,
          submitted_at: 1000,
          updated_at: 3000,
          ordering_time: 3000,
          decision_rating: 80,
          published_at: 3000
        },
        {
          competition_id: id,
          entry_id: entry('unvoted'),
          drop_id: drop('unvoted'),
          rating: 0,
          real_time_rating: 0,
          rank: 2,
          submitted_at: 1001,
          updated_at: 1001,
          ordering_time: null,
          decision_rating: null,
          published_at: null
        },
        {
          competition_id: id,
          entry_id: entry('zero'),
          drop_id: drop('zero'),
          rating: 0,
          real_time_rating: 0,
          rank: 2,
          submitted_at: 1002,
          updated_at: 1002,
          ordering_time: null,
          decision_rating: null,
          published_at: 2100
        },
        {
          competition_id: id,
          entry_id: entry('negative'),
          drop_id: drop('negative'),
          rating: -5,
          real_time_rating: -4,
          rank: 3,
          submitted_at: 1003,
          updated_at: 3000,
          ordering_time: null,
          decision_rating: null,
          published_at: 3000
        }
      ]);
      await insert(tables.WAVE_LEADERBOARD_ENTRIES_TABLE, [
        {
          wave_id: primaryWave.id,
          drop_id: drop('zero'),
          timestamp: 2100,
          vote: 100,
          vote_on_decision_time: 200
        }
      ]);
      await insert(tables.COMPETITION_DECISIONS_TABLE, [
        {
          id: completed,
          competition_id: id,
          scheduled_at: 2000,
          status: 'COMPLETED',
          execution_key: `${id}:2000`,
          created_at: 2000
        },
        {
          id: pending,
          competition_id: id,
          scheduled_at: 4000,
          status: 'PROCESSING',
          execution_key: `${id}:4000`,
          created_at: 4000
        }
      ]);
      const orphanWinner = legacyCompetitionEntryId(id, drop('orphan-win'));
      await insert(tables.COMPETITION_DECISION_WINNERS_TABLE, [
        {
          decision_id: completed,
          entry_id: entry('winner'),
          competition_id: id,
          rank: 1,
          final_rating: 33,
          created_at: 2000
        },
        {
          decision_id: completed,
          entry_id: orphanWinner,
          legacy_drop_id: drop('orphan-win'),
          competition_id: id,
          rank: 2,
          final_rating: 7,
          created_at: 2000
        }
      ]);
      await insert(tables.COMPETITION_WINNER_VOTES_TABLE, [
        {
          competition_id: id,
          decision_id: completed,
          entry_id: entry('winner'),
          voter_profile_id: 'frozen-voter',
          value: 33
        },
        {
          competition_id: id,
          decision_id: completed,
          entry_id: entry('winner'),
          voter_profile_id: 'zero-frozen-voter',
          value: 0
        },
        {
          competition_id: id,
          decision_id: pending,
          entry_id: entry('winner'),
          voter_profile_id: 'wrong-decision-voter',
          value: 999
        }
      ]);
      await insert(tables.COMPETITION_OUTCOMES_TABLE, [
        {
          id: outcome1,
          competition_id: id,
          position: 1,
          legacy_index: 1,
          type: 'MANUAL',
          description: 'Native manual',
          amount: null,
          created_at: 0
        },
        {
          id: outcome2,
          competition_id: id,
          position: 2,
          legacy_index: 2,
          type: 'AUTOMATIC',
          subtype: 'CREDIT_DISTRIBUTION',
          description: 'Résumé 二',
          credit: 'REP',
          rep_category: 'Builder',
          amount: 100,
          created_at: 0
        }
      ]);
      await insert(tables.COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE, [
        {
          id: legacyCompetitionDistributionItemId(outcome1, 1),
          competition_id: id,
          outcome_id: outcome1,
          position: 1,
          amount: null,
          description: null
        },
        {
          id: legacyCompetitionDistributionItemId(outcome2, 1),
          competition_id: id,
          outcome_id: outcome2,
          position: 1,
          amount: 60,
          description: 'First'
        },
        {
          id: legacyCompetitionDistributionItemId(outcome2, 2),
          competition_id: id,
          outcome_id: outcome2,
          position: 2,
          amount: 40,
          description: ''
        },
        {
          id: legacyCompetitionDistributionItemId(
            legacyCompetitionOutcomeId(sibling, 7),
            1
          ),
          competition_id: sibling,
          outcome_id: legacyCompetitionOutcomeId(sibling, 7),
          outcome_position: 7,
          position: 1,
          amount: 999,
          description: 'Sibling child'
        }
      ]);
      await insert(tables.WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE, [
        {
          wave_id: primaryWave.id,
          wave_outcome_position: 1,
          wave_outcome_distribution_item_position: 1,
          amount: 999,
          description: 'Stale child'
        },
        {
          wave_id: primaryWave.id,
          wave_outcome_position: 7,
          wave_outcome_distribution_item_position: 4,
          amount: null,
          description: null
        },
        {
          wave_id: primaryWave.id,
          wave_outcome_position: 7,
          wave_outcome_distribution_item_position: 5,
          amount: 0,
          description: 'Retained orphan'
        }
      ]);
      await insert(tables.COMPETITION_OUTCOME_AWARDS_TABLE, [
        ...[
          {
            position: 2,
            award: {
              type: 'AUTOMATIC',
              subtype: 'CREDIT_DISTRIBUTION',
              description: 'Second award',
              credit: 'REP',
              rep_category: 'Builder',
              amount: 100
            }
          },
          {
            position: 1,
            award: {
              type: 'MANUAL',
              subtype: null,
              description: 'First award',
              credit: null,
              rep_category: null,
              amount: null
            }
          }
        ].map(({ position, award }) => ({
          id: stableUuid(id, `award:${position}`),
          competition_id: id,
          decision_id: completed,
          entry_id: entry('winner'),
          outcome_position: position,
          award,
          created_at: 2000
        }))
      ]);
      await insert(tables.COMPETITION_PAUSES_TABLE, [
        {
          id: legacyCompetitionPauseId(id, 5),
          competition_id: id,
          legacy_source_id: 5,
          start_time: 2001,
          end_time: 2500,
          reason: null
        },
        {
          id: legacyCompetitionPauseId(id, 8),
          competition_id: id,
          legacy_source_id: 8,
          start_time: 2600,
          end_time: 2800,
          reason: 'Manual pause'
        },
        {
          id: stableUuid(id, 'unqualified-pause'),
          competition_id: id,
          legacy_source_id: null,
          start_time: 3001,
          end_time: 3500,
          reason: 'No compatibility identity'
        }
      ]);
      await insert(
        tables.DROP_REAL_VOTE_IN_TIME_TABLE,
        aggregate.map((row) => ({
          ...row,
          wave_id: primaryWave.id,
          drop_id: drop('active')
        }))
      );
      await insert(
        tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
        voter.map((row) => ({
          ...row,
          wave_id: primaryWave.id,
          drop_id: drop('active'),
          voter_id: 'historical-voter'
        }))
      );
      await insert(tables.COMPETITION_MIGRATIONS_TABLE, [
        {
          competition_id: id,
          wave_id: primaryWave.id,
          state: 'NATIVE',
          cohort: 'STANDARD',
          owner: 'contract',
          stage: 'COMPLETE',
          completed_stages: [],
          exceptions: [],
          cutover_at: 3000,
          updated_at: 3000
        }
      ]);
      await seedRetainedScoreFixture(sqlExecutor, id);
      await seedRetainedDistributionFixture(sqlExecutor, id);
      await installFrozenNativeGetProjections(sqlExecutor);
    });

    it('preserves published native weighted snapshots without physical mirrors and retains exact publication exclusions', async () => {
      const zeroLockWave = aWave(
        { type: WaveType.RANK, time_lock_ms: 0 },
        {
          id: 'rich-contract-zero-lock',
          name: 'Zero lock original',
          serial_no: 4
        }
      );
      const source = withWaves([zeroLockWave], true);
      await insert(source.table, source.rows);
      const zeroLock = await seedNativeOriginalPrimaryFixture(zeroLockWave);
      const nativeSnapshot = drop('native-snapshot');
      const zeroUnpublished = drop('zero-lock-unpublished');
      const zeroPhysical = drop('zero-lock-physical');
      const fixtures = [
        {
          dropId: nativeSnapshot,
          competitionId: id,
          waveId: primaryWave.id,
          updatedAt: 3000,
          rating: 17,
          decisionRating: 18
        },
        {
          dropId: zeroUnpublished,
          competitionId: zeroLock.id,
          waveId: zeroLockWave.id,
          updatedAt: 5000,
          rating: 5,
          decisionRating: 6
        },
        {
          dropId: zeroPhysical,
          competitionId: zeroLock.id,
          waveId: zeroLockWave.id,
          updatedAt: 1100,
          rating: 7,
          decisionRating: 9
        }
      ];
      await insert(
        tables.DROPS_TABLE,
        fixtures.map((fixture) => ({
          id: fixture.dropId,
          wave_id: fixture.waveId,
          author_id: 'artist',
          created_at: 1100,
          parts_count: 1,
          drop_type: 'PARTICIPATORY'
        }))
      );
      await insert(
        tables.COMPETITION_ENTRIES_TABLE,
        fixtures.map((fixture) => ({
          id: legacyCompetitionEntryId(fixture.competitionId, fixture.dropId),
          competition_id: fixture.competitionId,
          wave_id: fixture.waveId,
          drop_id: fixture.dropId,
          submitter_id: 'artist',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 1100
        }))
      );
      await insert(tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE, [
        ...fixtures.map((fixture) => ({
          competition_id: fixture.competitionId,
          entry_id: legacyCompetitionEntryId(
            fixture.competitionId,
            fixture.dropId
          ),
          // Frozen projections and physical publication ownership use the
          // entry's drop ID even when this denormalized snapshot field drifted.
          drop_id:
            fixture.dropId === zeroPhysical
              ? drop('stale-native-snapshot')
              : fixture.dropId,
          rating: fixture.rating,
          real_time_rating: fixture.rating,
          rank: 4,
          submitted_at: 1100,
          updated_at: fixture.updatedAt,
          ordering_time: 1150,
          decision_rating: fixture.decisionRating,
          published_at: null
        })),
        {
          competition_id: sibling,
          entry_id: legacyCompetitionEntryId(sibling, drop('sibling')),
          drop_id: drop('sibling'),
          rating: 999,
          real_time_rating: 999,
          rank: 1,
          submitted_at: 1,
          updated_at: 3000,
          ordering_time: 3000,
          decision_rating: 999,
          published_at: null
        },
        {
          competition_id: id,
          entry_id: entry('withdrawn'),
          drop_id: drop('withdrawn'),
          rating: 888,
          real_time_rating: 888,
          rank: 1,
          submitted_at: 1005,
          updated_at: 3000,
          ordering_time: 3000,
          decision_rating: 888,
          published_at: null
        }
      ]);
      await insert(tables.WAVE_LEADERBOARD_ENTRIES_TABLE, [
        {
          wave_id: zeroLockWave.id,
          drop_id: zeroPhysical,
          timestamp: 2500,
          vote: 9999,
          vote_on_decision_time: 8888
        }
      ]);
      const relevantDrops = [
        nativeSnapshot,
        zeroUnpublished,
        zeroPhysical,
        drop('sibling'),
        drop('withdrawn'),
        drop('unvoted')
      ];
      const projection = (view: string) =>
        sqlExecutor.execute(
          `SELECT * FROM ${view} WHERE drop_id IN (:drops) ORDER BY wave_id,drop_id`,
          { drops: relevantDrops }
        );
      const expected = await projection(
        frozenNativeGetView(tables.WAVE_LEADERBOARD_ENTRIES_TABLE)
      );
      expect(expected).toHaveLength(2);
      expect(expected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            drop_id: nativeSnapshot,
            wave_id: primaryWave.id,
            vote: 17,
            vote_on_decision_time: 18,
            timestamp: 1150
          }),
          expect.objectContaining({
            drop_id: zeroPhysical,
            wave_id: zeroLockWave.id,
            vote: 7,
            vote_on_decision_time: 9,
            timestamp: 1150
          })
        ])
      );
      expect(
        await projection(legacyGetView(tables.WAVE_LEADERBOARD_ENTRIES_TABLE))
      ).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `SELECT drop_id FROM ${tables.WAVE_LEADERBOARD_ENTRIES_TABLE} WHERE drop_id=:nativeSnapshot`,
          { nativeSnapshot }
        )
      ).toEqual([]);
      await seedRetainedPublicationFixture(sqlExecutor, undefined);
      expect(
        await projection(legacyGetView(tables.WAVE_LEADERBOARD_ENTRIES_TABLE))
      ).toEqual(expected);
      const publications = await sqlExecutor.execute<{
        drop_id: string;
        published_at: number | null;
      }>(
        `SELECT e.drop_id,lb.published_at FROM ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb
         JOIN ${tables.COMPETITION_ENTRIES_TABLE} e ON e.id=lb.entry_id AND e.competition_id=lb.competition_id
         WHERE e.drop_id IN (:drops) ORDER BY e.drop_id`,
        { drops: relevantDrops }
      );
      expect(
        Object.fromEntries(
          publications.map((row) => [row.drop_id, row.published_at])
        )
      ).toEqual({
        [nativeSnapshot]: 3000,
        [zeroPhysical]: 2500,
        [zeroUnpublished]: null,
        [drop('sibling')]: null,
        [drop('withdrawn')]: null,
        [drop('unvoted')]: null
      });
      await seedRetainedPublicationFixture(sqlExecutor, undefined);
      expect(
        await projection(legacyGetView(tables.WAVE_LEADERBOARD_ENTRIES_TABLE))
      ).toEqual(expected);
    });

    it('retains raw orphan weighted snapshots and their public leaderboard behavior without creating entries', async () => {
      const orphans = [drop('orphan-rate-null'), drop('orphan-rate-threshold')];
      await insert(
        tables.DROPS_TABLE,
        orphans.map((dropId) => ({
          id: dropId,
          wave_id: primaryWave.id,
          author_id: 'artist',
          created_at: 600,
          parts_count: 1,
          drop_type: 'PARTICIPATORY'
        }))
      );
      await insert(
        tables.WAVE_LEADERBOARD_ENTRIES_TABLE,
        orphans.map((dropId, index) => ({
          drop_id: dropId,
          wave_id: primaryWave.id,
          timestamp: 700 + index,
          vote: 40,
          vote_on_decision_time: 90,
          over_threshold_since_ms: index ? 650 : null
        }))
      );
      const baseline = new Map<string, unknown[]>();
      for (const table of FROZEN_NATIVE_GET_TABLES)
        baseline.set(
          table,
          await sqlExecutor.execute(
            `SELECT * FROM ${frozenNativeGetView(table)}`
          )
        );
      const voting = new DropVotingDb(() => sqlExecutor);
      const drops = new DropsDb(() => sqlExecutor);
      const weighted = () =>
        drops.findWeightedLeaderboardDrops(
          {
            wave_id: primaryWave.id,
            page: 1,
            page_size: 50,
            sort: LeaderboardSort.REALTIME_VOTE,
            sort_direction: PageSortDirection.DESC,
            curation_id: null,
            unvoted_by_me: false,
            is_additional_action_promised: null,
            price_currency: null,
            min_price: null,
            max_price: null
          },
          {}
        );
      let originalRates: Awaited<
        ReturnType<typeof voting.getWeightedDropRates>
      >;
      let originalOrder: string[];
      // Run the actual unchanged weighted consumers against the exact frozen
      // view, then restore the permanent native projection before transfer.
      try {
        await sqlExecutor.execute(`CREATE OR REPLACE SQL SECURITY INVOKER VIEW ${legacyGetView(tables.WAVE_LEADERBOARD_ENTRIES_TABLE)}
          AS SELECT * FROM ${frozenNativeGetView(tables.WAVE_LEADERBOARD_ENTRIES_TABLE)}`);
        originalRates = await voting.getWeightedDropRates(orphans, {});
        originalOrder = (await weighted()).map((row) => row.id);
      } finally {
        await installLegacyCompetitionGetFacade(sqlExecutor);
      }
      expect(originalRates!).toEqual(
        Object.fromEntries(
          orphans.map((dropId) => [dropId, { current: 40, prediction: 90 }])
        )
      );
      expect(originalOrder!).toEqual(expect.arrayContaining(orphans));
      const membersBefore = await sqlExecutor.execute(
        `SELECT id FROM ${tables.COMPETITION_ENTRIES_TABLE} ORDER BY id`
      );
      await seedRetainedPublicationFixture(sqlExecutor, id);
      for (const table of FROZEN_NATIVE_GET_TABLES)
        expect({
          table,
          rows: sorted(
            await sqlExecutor.execute(`SELECT * FROM ${legacyGetView(table)}`)
          )
        }).toEqual({ table, rows: sorted(baseline.get(table)!) });
      expect(await voting.getWeightedDropRates(orphans, {})).toEqual(
        originalRates!
      );
      expect((await weighted()).map((row) => row.id)).toEqual(originalOrder!);
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${tables.COMPETITION_ENTRIES_TABLE} ORDER BY id`
        )
      ).toEqual(membersBefore);
      const retained = await sqlExecutor.execute(
        `SELECT entry_id,drop_id,rating,decision_rating,ordering_time,published_at,over_threshold_since,\`rank\`
        FROM ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE} WHERE competition_id=:id AND drop_id IN (:orphans) ORDER BY drop_id`,
        { id, orphans }
      );
      expect(retained).toEqual(
        orphans.map((dropId, index) => ({
          entry_id: legacyCompetitionEntryId(id, dropId),
          drop_id: dropId,
          rating: 40,
          decision_rating: 90,
          ordering_time: 700 + index,
          published_at: 700 + index,
          over_threshold_since: index ? 650 : null,
          rank: null
        }))
      );
      await seedRetainedPublicationFixture(sqlExecutor, id);
      expect(await voting.getWeightedDropRates(orphans, {})).toEqual(
        originalRates!
      );
    });

    it('retains the frozen original null-string semantics while preserving literal strings from shared CHAT policies', async () => {
      await sqlExecutor.execute(
        `UPDATE ${tables.COMPETITIONS_TABLE} SET participation_config=JSON_SET(participation_config,'$.terms','null'),
         voting_config=JSON_SET(voting_config,'$.credit_type','REP','$.credit_category','null') WHERE id=:id`,
        { id }
      );
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_participation_config=JSON_OBJECT('terms','divergent hub terms'),
         hub_voting_config=JSON_OBJECT('credit_category','divergent hub category') WHERE id=:waveId`,
        { waveId: primaryWave.id }
      );
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET participation_terms='null',voting_credit_category='null',
         hub_participation_config=JSON_SET(hub_participation_config,'$.terms','null'),
         hub_voting_config=JSON_SET(hub_voting_config,'$.credit_category','null') WHERE id=:waveId`,
        { waveId: chatWave.id }
      );
      const read = (view: string) =>
        sqlExecutor.execute(
          `SELECT id,participation_terms,voting_credit_category FROM ${view}
         WHERE id IN (:waveIds) ORDER BY id`,
          { waveIds: [primaryWave.id, chatWave.id] }
        );
      const original = await read(frozenNativeGetView(tables.WAVES_TABLE));
      expect(original).toEqual([
        {
          id: chatWave.id,
          participation_terms: 'null',
          voting_credit_category: 'null'
        },
        {
          id: primaryWave.id,
          participation_terms: null,
          voting_credit_category: null
        }
      ]);
      expect(await read(legacyGetView(tables.WAVES_TABLE))).toEqual(original);
      await sqlExecutor.execute(
        `UPDATE ${tables.COMPETITIONS_TABLE} SET participation_config=JSON_SET(participation_config,'$.terms',CAST('null' AS JSON)),
         voting_config=JSON_SET(voting_config,'$.credit_category',CAST('null' AS JSON)) WHERE id=:id`,
        { id }
      );
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET participation_terms=NULL,voting_credit_category=NULL,
         hub_participation_config=JSON_SET(hub_participation_config,'$.terms',CAST('null' AS JSON)),
         hub_voting_config=JSON_SET(hub_voting_config,'$.credit_category',CAST('null' AS JSON)) WHERE id=:waveId`,
        { waveId: chatWave.id }
      );
      expect(await read(legacyGetView(tables.WAVES_TABLE))).toEqual(
        await read(frozenNativeGetView(tables.WAVES_TABLE))
      );
    });

    it('projects overlapping original-primary and CHAT credit NFTs once per wave in frozen order without exposing sibling or obsolete source NFTs', async () => {
      const shared = {
        contract: '0x00000000000000000000000000000000000000a1',
        token_id: 7
      };
      const chatOnly = {
        contract: '0x00000000000000000000000000000000000000a0',
        token_id: 3
      };
      const hidden = {
        contract: '0x00000000000000000000000000000000000000ff',
        token_id: 99
      };
      for (const { wave, nfts } of [
        { wave: primaryWave, nfts: [shared, hidden] },
        { wave: chatWave, nfts: [shared, chatOnly] }
      ])
        await sqlExecutor.execute(
          `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=CAST(:policy AS JSON) WHERE id=:waveId`,
          {
            waveId: wave.id,
            policy: JSON.stringify({
              ...waveHubConfigurationFromWave(wave).voting,
              credit_nfts: nfts
            })
          }
        );
      await sqlExecutor.execute(
        `UPDATE ${tables.COMPETITIONS_TABLE} SET voting_config=JSON_SET(voting_config,'$.credit_nfts',CAST(:nfts AS JSON)) WHERE id=:sibling`,
        { sibling, nfts: JSON.stringify([shared, hidden]) }
      );
      await insert(tables.WAVE_VOTING_CREDIT_NFTS_TABLE, [
        { wave_id: primaryWave.id, ...hidden },
        { wave_id: chatWave.id, ...shared },
        { wave_id: chatWave.id, ...chatOnly }
      ]);
      const read = (view: string) =>
        sqlExecutor.execute(
          `SELECT * FROM ${view} ORDER BY wave_id,contract,token_id`
        );
      const expected = await read(
        frozenNativeGetView(tables.WAVE_VOTING_CREDIT_NFTS_TABLE)
      );
      expect(expected).toEqual([
        { wave_id: chatWave.id, ...chatOnly },
        { wave_id: chatWave.id, ...shared },
        {
          wave_id: primaryWave.id,
          contract: '0x0000000000000000000000000000000000000002',
          token_id: 19
        },
        { wave_id: primaryWave.id, ...shared }
      ]);
      const nativeView = legacyGetView(tables.WAVE_VOTING_CREDIT_NFTS_TABLE);
      expect(await read(nativeView)).toEqual(expected);
      await insert(tables.WAVE_VOTING_CREDIT_NFTS_TABLE, [
        { wave_id: chatWave.id, ...hidden }
      ]);
      expect(
        await read(frozenNativeGetView(tables.WAVE_VOTING_CREDIT_NFTS_TABLE))
      ).toHaveLength(expected.length + 1);
      expect(await read(nativeView)).toEqual(expected);
    });

    it('reads only native CHAT NFTs after cutover when physical and JSON sets are disjoint, cleared or absent', async () => {
      const nativeNfts = JSON.stringify([
        {
          contract: '0x00000000000000000000000000000000000000c1',
          token_id: 11
        }
      ]);
      const setNativeNfts = (nfts: string) =>
        sqlExecutor.execute(
          `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=JSON_SET(hub_voting_config,'$.credit_nfts',CAST(:nfts AS JSON)) WHERE id=:waveId`,
          { nfts, waveId: chatWave.id }
        );
      await setNativeNfts(nativeNfts);
      await insert(tables.WAVE_VOTING_CREDIT_NFTS_TABLE, [
        {
          wave_id: chatWave.id,
          contract: '0x00000000000000000000000000000000000000d1',
          token_id: 22
        }
      ]);
      const read = (view: string) =>
        sqlExecutor.execute(
          `SELECT * FROM ${view} WHERE wave_id=:waveId ORDER BY contract,token_id`,
          { waveId: chatWave.id }
        );
      const frozenView = frozenNativeGetView(
        tables.WAVE_VOTING_CREDIT_NFTS_TABLE
      );
      const nativeView = legacyGetView(tables.WAVE_VOTING_CREDIT_NFTS_TABLE);
      expect(await read(frozenView)).toEqual([
        {
          wave_id: chatWave.id,
          contract: '0x00000000000000000000000000000000000000d1',
          token_id: 22
        }
      ]);
      expect(await read(nativeView)).toEqual([
        {
          wave_id: chatWave.id,
          contract: '0x00000000000000000000000000000000000000c1',
          token_id: 11
        }
      ]);
      await setNativeNfts('[]');
      expect(await read(nativeView)).toEqual([]);
      expect(await read(frozenView)).toEqual([
        {
          wave_id: chatWave.id,
          contract: '0x00000000000000000000000000000000000000d1',
          token_id: 22
        }
      ]);
      await setNativeNfts(nativeNfts);
      await sqlExecutor.execute(
        `DELETE FROM ${tables.WAVE_VOTING_CREDIT_NFTS_TABLE} WHERE wave_id=:waveId`,
        { waveId: chatWave.id }
      );
      expect(await read(nativeView)).toEqual([
        {
          wave_id: chatWave.id,
          contract: '0x00000000000000000000000000000000000000c1',
          token_id: 11
        }
      ]);
      expect(await read(frozenView)).toEqual([]);
    });

    it('keeps observable case/accent filtering and ordering on native outcome text and NFT addresses', async () => {
      const textQuery = (view: string) =>
        sqlExecutor.execute(
          `SELECT description,type,subtype FROM ${view} WHERE description='resume 二' OR description='NATIVE MANUAL' ORDER BY description,type`
        );
      const expected = await textQuery(
        frozenNativeGetView(tables.WAVE_OUTCOMES_TABLE)
      );
      expect(expected).toHaveLength(2);
      expect(
        await textQuery(legacyGetView(tables.WAVE_OUTCOMES_TABLE))
      ).toEqual(expected);
      const waveTextQuery = (view: string) =>
        sqlExecutor.execute(
          `SELECT id,participation_terms FROM ${view} WHERE participation_terms='retain original terms' ORDER BY id`
        );
      const expectedWaveText = await waveTextQuery(
        frozenNativeGetView(tables.WAVES_TABLE)
      );
      expect(expectedWaveText).toHaveLength(1);
      expect(await waveTextQuery(legacyGetView(tables.WAVES_TABLE))).toEqual(
        expectedWaveText
      );
      const addressQuery = (view: string) =>
        sqlExecutor.execute(
          `SELECT contract,token_id FROM ${view} WHERE contract=UPPER(:address) ORDER BY contract,token_id`,
          { address: '0x00000000000000000000000000000000000000a1' }
        );
      const expectedAddresses = await addressQuery(
        frozenNativeGetView(tables.WAVE_VOTING_CREDIT_NFTS_TABLE)
      );
      expect(expectedAddresses).toHaveLength(1);
      expect(
        await addressQuery(legacyGetView(tables.WAVE_VOTING_CREDIT_NFTS_TABLE))
      ).toEqual(expectedAddresses);
      const metadata = async (view: string) =>
        sqlExecutor.execute(
          `SELECT COLUMN_NAME,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=database() AND TABLE_NAME=:view AND CHARACTER_SET_NAME IS NOT NULL ORDER BY COLUMN_NAME`,
          { view }
        );
      for (const table of FROZEN_NATIVE_GET_TABLES)
        expect({
          table,
          columns: await metadata(legacyGetView(table))
        }).toEqual({
          table,
          columns: await metadata(frozenNativeGetView(table))
        });
    });

    it('matches all twelve rich frozen projection rows, complete columns, primitive types and nulls while isolating siblings and preserving original ownership', async () => {
      const baseline = await withLegacyCompetitionGetFacade(async () => {
        const result = new Map<string, unknown[]>();
        for (const table of FROZEN_NATIVE_GET_TABLES)
          result.set(
            table,
            await sqlExecutor.execute(
              `SELECT * FROM \`${frozenNativeGetView(table)}\``
            )
          );
        return result;
      });
      for (const table of FROZEN_NATIVE_GET_TABLES) {
        const actual = await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(`SELECT * FROM \`${legacyGetView(table)}\``)
        );
        expect({ table, rows: sorted(actual) }).toEqual({
          table,
          rows: sorted(baseline.get(table)!)
        });
        expect(baseline.get(table)!.length).toBeGreaterThan(0);
      }
      for (const table of [
        tables.DROP_REAL_VOTE_IN_TIME_TABLE,
        tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
      ]) {
        const expected = await sqlExecutor.execute(
          `SELECT * FROM ${table} ORDER BY timestamp,id`
        );
        const actual = await sqlExecutor.execute(
          `SELECT * FROM ${legacyGetView(table)} ORDER BY timestamp,id`
        );
        expect({ table, rows: actual }).toEqual({ table, rows: expected });
      }
      const primaryRecord =
        (await competitionRepository.findCompetitionRecordById(id, {}))!;
      const siblingRecord =
        (await competitionRepository.findCompetitionRecordById(sibling, {}))!;
      const candidates = [primaryRecord, siblingRecord]
        .map((record) => normalizeDefaultCompetition(record, 5000))
        .filter(
          (record): record is NonNullable<typeof record> => record !== null
        );
      expect(selectDefaultCompetition(candidates, 5000).competition_id).toBe(
        sibling
      );
      expect(
        await sqlExecutor.execute(
          `SELECT name,type FROM ${legacyGetView(tables.WAVES_TABLE)} WHERE id=:waveId`,
          { waveId: primaryWave.id }
        )
      ).toEqual([{ name: 'Native original title', type: 'RANK' }]);
    });
  },
  historicalCompetitionFixture
);
