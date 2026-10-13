import {
  RELEASE_DIGEST_ENTRIES_TABLE,
  RELEASE_DIGESTS_TABLE
} from '@/constants';
import { ReleaseDigestStatus } from '@/entities/IReleaseDigest';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { NewReleaseDigestEntry, ReleaseDigestDb } from './release-digest.db';

function anEntry(
  overrides: Partial<NewReleaseDigestEntry> = {}
): NewReleaseDigestEntry {
  return {
    id: 'a'.repeat(64),
    repository: '6529-Collections/6529seize-frontend',
    pull_request_number: 1,
    pull_request_title: 'First change',
    pull_request_url:
      'https://github.com/6529-Collections/6529seize-frontend/pull/1',
    pull_request_body: 'Body',
    summary: 'Summary one.',
    contributors: [
      { github_login: 'alice', handle: 'alice', profile_id: 'p1' }
    ],
    services: [],
    publication_id: 'p'.repeat(64),
    deployed_at: 1_000,
    ...overrides
  };
}

describeWithSeed(
  'ReleaseDigestDb',
  [
    { table: RELEASE_DIGEST_ENTRIES_TABLE, rows: [] },
    { table: RELEASE_DIGESTS_TABLE, rows: [] }
  ],
  () => {
    const repository = new ReleaseDigestDb(() => sqlExecutor);

    it('claims unclaimed entries once per digest key and keeps claims on regeneration', async () => {
      await repository.recordEntries(
        [
          anEntry(),
          anEntry({
            id: 'b'.repeat(64),
            pull_request_number: 2,
            deployed_at: 2_000
          }),
          anEntry({
            id: 'c'.repeat(64),
            pull_request_number: 3,
            deployed_at: 9_000
          })
        ],
        {}
      );

      const digest = await repository.claimDigest(
        {
          digestId: 'digest-1',
          digestKey: '2026-10-12',
          cutoff: 5_000,
          limit: 10,
          now: 6_000
        },
        {}
      );
      expect(digest).toEqual(
        expect.objectContaining({
          id: 'digest-1',
          status: ReleaseDigestStatus.Pending,
          entry_count: 2
        })
      );

      const again = await repository.claimDigest(
        {
          digestId: 'digest-2',
          digestKey: '2026-10-12',
          cutoff: 10_000,
          limit: 10,
          now: 7_000
        },
        {}
      );
      expect(again?.id).toBe('digest-1');

      await repository.recordEntries(
        [anEntry({ summary: 'Regenerated summary.' })],
        {}
      );
      const claimed = await repository.findEntriesForDigest('digest-1', {});
      expect(claimed.map((entry) => entry.pull_request_number)).toEqual([1, 2]);
      expect(claimed[0].summary).toBe('Regenerated summary.');
      expect(JSON.parse(claimed[0].contributors)).toEqual([
        { github_login: 'alice', handle: 'alice', profile_id: 'p1' }
      ]);

      const unclaimed = await repository.findUnclaimedEntries(10_000, 10, {});
      expect(unclaimed.map((entry) => entry.pull_request_number)).toEqual([3]);
    });

    it('returns null when there is nothing to claim', async () => {
      await expect(
        repository.claimDigest(
          {
            digestId: 'digest-1',
            digestKey: '2026-10-12',
            cutoff: 5_000,
            limit: 10,
            now: 6_000
          },
          {}
        )
      ).resolves.toBeNull();
      await expect(
        repository.findDigestByKey('2026-10-12', {})
      ).resolves.toBeNull();
    });

    it('marks digests published and lists only unfinished earlier digests', async () => {
      await repository.recordEntries([anEntry()], {});
      await repository.claimDigest(
        {
          digestId: 'digest-1',
          digestKey: '2026-10-11',
          cutoff: 5_000,
          limit: 10,
          now: 6_000
        },
        {}
      );
      await expect(
        repository.findPendingDigests('2026-10-12', {})
      ).resolves.toEqual([expect.objectContaining({ id: 'digest-1' })]);
      await expect(
        repository.findPendingDigests('2026-10-11', {})
      ).resolves.toEqual([]);

      await repository.markPublished('digest-1', 'drop-1', 7_000, {});

      await expect(
        repository.findDigestByKey('2026-10-11', {})
      ).resolves.toEqual(
        expect.objectContaining({
          status: ReleaseDigestStatus.Published,
          drop_id: 'drop-1'
        })
      );
      await expect(
        repository.findPendingDigests('2026-10-12', {})
      ).resolves.toEqual([]);
    });
  }
);
