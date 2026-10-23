import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  DROP_METADATA_TABLE,
  DROPS_TABLE
} from '@/constants';
import { CompetitionEntryRepository } from './competition-entry.repository';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

const first = '10000000-0000-4000-8000-000000000001';
const sibling = '10000000-0000-4000-8000-000000000002';
const entries = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    competition_id: first,
    drop_id: 'original-active',
    status: 'ACTIVE'
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    competition_id: sibling,
    drop_id: 'sibling-active',
    status: 'ACTIVE'
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    competition_id: sibling,
    drop_id: 'sibling-winner',
    status: 'WINNER'
  }
];

describeWithSeed(
  'native nomination scopes during identity consolidation',
  [
    {
      table: COMPETITIONS_TABLE,
      rows: [first, sibling].map((id) => ({
        id,
        wave_id: 'hub',
        legacy_wave_id: id === first ? 'hub' : null,
        execution_mode: 'ACTIVE',
        type: 'RANK',
        lifecycle: 'PUBLISHED',
        title: id,
        participation_config: { submission_type: 'IDENTITY' },
        voting_config: {},
        decision_config: {},
        winner_config: {},
        outcome_config: [],
        created_at: 1,
        updated_at: 1,
        published_at: 1
      }))
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: entries.map((entry) => ({
        ...entry,
        wave_id: 'hub',
        submitter_id: 'author',
        config_version: 1,
        submitted_at: 1
      }))
    },
    {
      table: DROPS_TABLE,
      rows: entries.map((entry, index) => ({
        id: entry.drop_id,
        serial_no: index + 1,
        wave_id: 'hub',
        author_id: 'author',
        created_at: 1,
        parts_count: 1,
        drop_type: 'CHAT'
      }))
    },
    {
      table: DROP_METADATA_TABLE,
      rows: entries.map((entry) => ({
        drop_id: entry.drop_id,
        wave_id: 'hub',
        data_key: 'identity',
        data_value: 'old-profile'
      }))
    },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: entries.slice(0, 2).map((entry, index) => ({
        id: `30000000-0000-4000-8000-00000000000${index + 1}`,
        competition_id: entry.competition_id,
        entry_id: entry.id,
        voter_profile_id: 'voter',
        value: index ? 9 : 100,
        credit_spent: index ? 9 : 100,
        created_at: 1,
        updated_at: 1
      }))
    }
  ],
  () => {
    const repository = new CompetitionEntryRepository(() => sqlExecutor);
    it('discovers identity competitions independently of the hub default and stored drop classification', async () => {
      await expect(
        repository.findNominationCompetitionIds(['old-profile'], {})
      ).resolves.toEqual([first, sibling]);
    });
    it('rewrites active nominees only within the selected competition and preserves winners', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await repository.rewriteNominationProfile(
            sibling,
            'old-profile',
            'new-profile',
            { connection }
          );
          expect(
            (
              await repository.listNominations(sibling, 'new-profile', {
                connection
              })
            ).map((entry) => entry.drop_id)
          ).toEqual(['sibling-active']);
          expect(
            (
              await repository.listNominations(sibling, 'old-profile', {
                connection
              })
            ).map((entry) => [entry.drop_id, entry.has_won])
          ).toEqual([['sibling-winner', true]]);
          expect(
            (
              await repository.listNominations(first, 'old-profile', {
                connection
              })
            ).map((entry) => entry.drop_id)
          ).toEqual(['original-active']);
        }
      );
    });
    it('reads sibling vote tallies from native entry ownership', async () => {
      await expect(
        repository.nominationTallies(
          ['original-active', 'sibling-active', 'sibling-winner'],
          {}
        )
      ).resolves.toEqual({
        'original-active': { tally: 100, total_number_of_voters: 1 },
        'sibling-active': { tally: 9, total_number_of_voters: 1 },
        'sibling-winner': { tally: 0, total_number_of_voters: 0 }
      });
    });
  }
);
