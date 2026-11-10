import { COMPETITION_ENTRIES_TABLE } from '@/constants';
import { CompetitionEntryRepository } from '@/competitions/competition-entry.repository';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

const first = '10000000-0000-4000-8000-000000000001';
const sibling = '10000000-0000-4000-8000-000000000002';
const entries = [
  { competition_id: first, submitter_id: 'artist', status: 'ACTIVE' },
  { competition_id: first, submitter_id: 'artist', status: 'ACTIVE' },
  { competition_id: first, submitter_id: 'artist', status: 'ACTIVE' },
  { competition_id: first, submitter_id: 'artist', status: 'WINNER' },
  { competition_id: first, submitter_id: 'artist', status: 'WITHDRAWN' },
  { competition_id: first, submitter_id: 'artist', status: 'DISQUALIFIED' },
  { competition_id: first, submitter_id: 'someone-else', status: 'ACTIVE' },
  { competition_id: sibling, submitter_id: 'artist', status: 'ACTIVE' }
];

describeWithSeed(
  'competition active entry counts',
  [
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: entries.map((entry, index) => ({
        ...entry,
        id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        drop_id: `count-drop-${index}`,
        wave_id: 'shared-hub',
        config_version: 1,
        submitted_at: 1
      }))
    }
  ],
  () => {
    const repository = new CompetitionEntryRepository(() => sqlExecutor);

    it('matches the write limit count, excluding other profiles and inactive entries', async () => {
      const counts = await repository.countActiveByCompetitionIds(
        [first, sibling],
        'artist',
        {}
      );
      expect(counts).toEqual({ [first]: 3, [sibling]: 1 });
      expect(await repository.countActive(first, 'artist', {})).toBe(
        counts[first]
      );
    });

    it('returns no counts for an empty selection or a profile without entries', async () => {
      expect(
        await repository.countActiveByCompetitionIds([], 'artist', {})
      ).toEqual({});
      expect(
        await repository.countActiveByCompetitionIds([first], 'absent', {})
      ).toEqual({});
    });
  }
);
