import { PROFILE_CMS_POINTER_EVENTS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  latestSiteWrites,
  writesAfterFreeze
} from './profile-site-export.handler';

const T = Date.UTC(2026, 10, 24);

function pointerEvent(id: string, packageDbId: string, createdAt: number) {
  return {
    id,
    event_type: 'PUBLISH',
    profile_id: 'profile-a',
    profile_handle: 'alice',
    package_db_id: packageDbId,
    package_id: 'site',
    package_version: 1,
    package_hash: 'package-hash',
    payload_hash: 'payload-hash',
    actor_profile_id: 'profile-a',
    event_sequence: 1,
    created_at: createdAt
  };
}

/** The job's own queries, run on MySQL as written: they must parse and read. */
describeWithSeed(
  'the profile site export queries on MySQL',
  [
    {
      table: PROFILE_CMS_POINTER_EVENTS_TABLE,
      rows: [
        pointerEvent('event-1', 'pkg-1', T - 1_000),
        pointerEvent('event-2', 'pkg-2', T + 5)
      ]
    }
  ],
  () => {
    it('reads the latest publication, archive and pointer change', async () => {
      await expect(latestSiteWrites(sqlExecutor)).resolves.toEqual({
        packages: null,
        archivedPackages: null,
        legacyPackages: null,
        pointerEvents: T + 5
      });
    });

    it('reads the writes after the freeze, by package', async () => {
      await expect(writesAfterFreeze(sqlExecutor, T)).resolves.toEqual([
        {
          source: 'pointer_events',
          packageId: 'pkg-2',
          at: '2026-11-24T00:00:00.005Z',
          token: 'pointer_events:pkg-2@2026-11-24T00:00:00.005Z'
        }
      ]);
      await expect(writesAfterFreeze(sqlExecutor, T + 5)).resolves.toEqual([]);
    });
  }
);
