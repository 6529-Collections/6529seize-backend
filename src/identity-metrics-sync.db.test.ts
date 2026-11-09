import 'reflect-metadata';
import {
  IDENTITIES_TABLE,
  IDENTITY_TDH_SYNC_STATE_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { identitiesService } from '@/api/identities/identities.service';
import { ProfileIdGenerator, identityConsolidationEffects } from '@/identity';
import { identityMetricsSync } from '@/identity-metrics-sync';
import {
  resumePendingIdentityTdhSync,
  syncIdentitiesAfterTdh
} from '@/identity-tdh-sync';
import { identityTdhSyncStateDb } from '@/identity-tdh-sync-state.db';
import { ratingsDb } from '@/rates/ratings.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  fixturePrimaryAddress,
  identityMetricsSyncSeeds,
  IdentityRow,
  METRIC_COLUMNS,
  OLD_ALGORITHM_SQL,
  readIdentities,
  readWaveSubscriberCounts
} from '@/tests/fixtures/identity-metrics-sync.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';

const BLOCK = 24_000_000;
const ROLLBACK = new Error('reference run is rolled back');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let generatedIds = 0;

function useDeterministicMergeDependencies() {
  generatedIds = 0;
  jest
    .spyOn(ProfileIdGenerator.prototype, 'generate')
    .mockImplementation(() => `generated-${++generatedIds}`);
  jest
    .spyOn(identitiesService, 'determinePrimaryAddress')
    .mockImplementation(fixturePrimaryAddress);
}

type Reference = {
  identities: IdentityRow[];
  waves: { wave_id: string; subscribers_count: number }[];
};

/**
 * The pre-change run on the seeded database: the identities sync with the
 * merge, then the old all-rows metrics SQL, in one transaction as before.
 * Its result is read inside the transaction, which is then rolled back.
 */
async function referenceRun(): Promise<Reference> {
  const before = await readIdentities();
  const result: { reference?: Reference } = {};
  generatedIds = 0;
  await expect(
    sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await identityConsolidationEffects.syncIdentitiesWithTdhConsolidations(
        connection
      );
      for (const sql of OLD_ALGORITHM_SQL) {
        await sqlExecutor.execute(sql, undefined, {
          wrappedConnection: connection
        });
      }
      result.reference = {
        identities: await readIdentities(connection),
        waves: await readWaveSubscriberCounts(connection)
      };
      throw ROLLBACK;
    })
  ).rejects.toBe(ROLLBACK);
  // The new run starts from the same state, with the same generated ids.
  expect(await readIdentities()).toEqual(before);
  generatedIds = 0;
  return result.reference!;
}

async function metricsWalk() {
  const [row] = await sqlExecutor.execute<{
    generation: number | string;
    walk_after: string | null;
  }>(
    `select generation, walk_after from ${IDENTITY_TDH_SYNC_STATE_TABLE} where id = 'metrics_walk'`
  );
  return { generation: Number(row.generation), walk_after: row.walk_after };
}

async function markPending() {
  await identityTdhSyncStateDb.ensureRows();
  await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    identityTdhSyncStateDb.markPending(BLOCK, connection)
  );
}

const metrics = (row: IdentityRow) =>
  METRIC_COLUMNS.map((column) => Number(row[column]));

/** Rows whose metric tuple is neither its old nor its final one. */
function rowsNeitherOldNorFinal(
  rows: IdentityRow[],
  old: IdentityRow[],
  final: IdentityRow[]
): string[] {
  const byKey = (list: IdentityRow[]) =>
    new Map(list.map((row) => [row.consolidation_key, metrics(row)]));
  const oldByKey = byKey(old);
  const finalByKey = byKey(final);
  return rows
    .filter((row) => {
      const values = JSON.stringify(metrics(row));
      return (
        values !== JSON.stringify(oldByKey.get(row.consolidation_key)) &&
        values !== JSON.stringify(finalByKey.get(row.consolidation_key))
      );
    })
    .map((row) => `${row.consolidation_key}: ${metrics(row).join(',')}`);
}

/** Captures identities after the merge, right before the metrics chunks. */
function capturePostMerge(onCaptured?: (rows: IdentityRow[]) => void) {
  const original = identityMetricsSync.syncAll.bind(identityMetricsSync);
  const captured: { rows: IdentityRow[] } = { rows: [] };
  jest
    .spyOn(identityMetricsSync, 'syncAll')
    .mockImplementationOnce(async (options) => {
      captured.rows = await readIdentities();
      onCaptured?.(captured.rows);
      return original(options);
    });
  return captured;
}

async function repSum(profileId: string): Promise<number> {
  const [row] = await sqlExecutor.execute<{ total: number | null }>(
    `select sum(rating) as total from ${RATINGS_TABLE}
     where matter = 'REP' and matter_target_id = :profileId`,
    { profileId }
  );
  return Number(row?.total ?? 0);
}

async function identityRep(profileId: string): Promise<number> {
  const [row] = await sqlExecutor.execute<{ rep: number }>(
    `select rep from ${IDENTITIES_TABLE} where profile_id = :profileId`,
    { profileId }
  );
  return Number(row.rep);
}

/** The API's rating write order: ratings first, then the identity delta. */
async function rateRep(
  raterProfileId: string,
  targetProfileId: string,
  rating: number,
  afterRatingWrite?: () => Promise<void>
) {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    await sqlExecutor.execute(
      `insert into ${RATINGS_TABLE}
         (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified)
       values (:raterProfileId, :targetProfileId, 'REP', 'concurrent', :rating, now())`,
      { raterProfileId, targetProfileId, rating },
      { wrappedConnection: connection }
    );
    await afterRatingWrite?.();
    await ratingsDb.applyBulkIdentityUpdates(
      [{ profileId: targetProfileId, repChange: rating }],
      connection
    );
  });
}

describeWithSeed(
  'chunked identities metrics sync after consolidated TDH',
  identityMetricsSyncSeeds(),
  () => {
    beforeEach(() => {
      useDeterministicMergeDependencies();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each([3, 2_000])(
      'ends exactly where the old all-rows algorithm did, including a profile merge (chunks of %d)',
      async (chunkRows) => {
        const reference = await referenceRun();
        // The fixture exercises every column: none of them stays as seeded.
        const seeded = await readIdentities();
        for (const column of METRIC_COLUMNS) {
          expect(
            reference.identities.some((row) => {
              const before = seeded.find(
                (it) => it.consolidation_key === row.consolidation_key
              );
              return before && Number(before[column]) !== Number(row[column]);
            })
          ).toBe(true);
        }
        await markPending();

        await expect(syncIdentitiesAfterTdh({ chunkRows })).resolves.toBe(
          'SYNCED'
        );

        expect(await readIdentities()).toEqual(reference.identities);
        expect(await readWaveSubscriberCounts()).toEqual(reference.waves);
      }
    );

    it('splits chunks by the inlined profile id budget', async () => {
      const result = await identityMetricsSync.syncAll({
        chunkRows: 2_000,
        profileIdBytes: 20
      });
      // Two quoted ids fit in 20 bytes; rows without ids ride along.
      expect(result.chunks).toBeGreaterThanOrEqual(10);
      expect(result.rows).toBe((await readIdentities()).length);
    });

    it('leaves each row at its old or its final values when interrupted, and the next run converges', async () => {
      const reference = await referenceRun();
      await markPending();
      const postMerge = capturePostMerge();
      const crash = new Error('crash after chunk 3');

      await expect(
        syncIdentitiesAfterTdh({
          chunkRows: 3,
          afterChunk: (chunk) => {
            if (chunk === 3) throw crash;
          }
        })
      ).rejects.toBe(crash);

      const interrupted = await readIdentities();
      expect(
        rowsNeitherOldNorFinal(
          interrupted,
          postMerge.rows,
          reference.identities
        )
      ).toEqual([]);
      // Part way: some rows are final, some still differ from final.
      const finalCount = interrupted.filter(
        (row, i) =>
          JSON.stringify(metrics(row)) ===
          JSON.stringify(metrics(reference.identities[i]))
      ).length;
      expect(finalCount).toBeGreaterThanOrEqual(9);
      expect(finalCount).toBeLessThan(interrupted.length);
      const pending = await identityTdhSyncStateDb.readProgress();
      expect(pending.pendingGeneration).toBeGreaterThan(
        pending.syncedGeneration
      );

      await resumePendingIdentityTdhSync();

      expect(await readIdentities()).toEqual(reference.identities);
      expect(await readWaveSubscriberCounts()).toEqual(reference.waves);
      const synced = await identityTdhSyncStateDb.readProgress();
      expect(synced.syncedGeneration).toBe(synced.pendingGeneration);
    });

    it('resumes the walk after the last committed chunk, redoing none, and ends where the old algorithm did', async () => {
      const reference = await referenceRun();
      await markPending();
      const killed = new Error('killed after chunk 3');
      await expect(
        syncIdentitiesAfterTdh({
          chunkRows: 3,
          afterChunk: (chunk) => {
            if (chunk === 3) throw killed;
          }
        })
      ).rejects.toBe(killed);

      // The position committed with chunk 3: its last key, the ninth identity.
      const keys = (await readIdentities()).map((row) => row.consolidation_key);
      await expect(metricsWalk()).resolves.toEqual({
        generation: 1,
        walk_after: keys[8]
      });

      const syncAll = jest.spyOn(identityMetricsSync, 'syncAll');
      await resumePendingIdentityTdhSync();

      expect(syncAll).toHaveBeenCalledTimes(1);
      expect(syncAll.mock.calls[0][0]).toMatchObject({ startAfter: keys[8] });
      const resumed = await syncAll.mock.results[0].value;
      expect(resumed.rows).toBe(keys.length - 9);
      expect(await readIdentities()).toEqual(reference.identities);
      await expect(metricsWalk()).resolves.toEqual({
        generation: 1,
        walk_after: keys[keys.length - 1]
      });
    });

    it('walks a newer generation from the first identity', async () => {
      await markPending();
      const killed = new Error('killed after chunk 2');
      await expect(
        syncIdentitiesAfterTdh({
          chunkRows: 3,
          afterChunk: (chunk) => {
            if (chunk === 2) throw killed;
          }
        })
      ).rejects.toBe(killed);
      // Another TDH write commits before the next start.
      await markPending();

      const syncAll = jest.spyOn(identityMetricsSync, 'syncAll');
      await resumePendingIdentityTdhSync();

      expect(syncAll.mock.calls[0][0]).toMatchObject({ startAfter: '' });
      const resumed = await syncAll.mock.results[0].value;
      expect(resumed.rows).toBe((await readIdentities()).length);
      const progress = await identityTdhSyncStateDb.readProgress();
      expect(progress.syncedGeneration).toBe(2);
    });

    it('never shows a concurrent reader a reset or partial row', async () => {
      const reference = await referenceRun();
      await markPending();
      const violations: string[] = [];
      let polls = 0;
      let stop = false;
      let poller: Promise<void> = Promise.resolve();
      const postMerge = capturePostMerge((old) => {
        poller = (async () => {
          while (!stop) {
            violations.push(
              ...rowsNeitherOldNorFinal(
                await readIdentities(),
                old,
                reference.identities
              )
            );
            polls++;
          }
        })();
      });

      await syncIdentitiesAfterTdh({
        chunkRows: 3,
        afterChunk: async () => {
          violations.push(
            ...rowsNeitherOldNorFinal(
              await readIdentities(),
              postMerge.rows,
              reference.identities
            )
          );
        }
      });
      stop = true;
      await poller;

      expect(violations).toEqual([]);
      expect(polls).toBeGreaterThan(0);
      expect(await readIdentities()).toEqual(reference.identities);
    });

    it('waits for a rating in flight, then sums it, without a deadlock', async () => {
      const ratingWritten = deferred();
      const releaseRating = deferred();
      const rating = rateRep('p-e11', 'p-e05', 31, async () => {
        ratingWritten.resolve();
        await releaseRating.promise;
      });
      await ratingWritten.promise;
      let syncDone = false;
      const sync = identityMetricsSync
        .syncAll({ chunkRows: 3 })
        .then((result) => {
          syncDone = true;
          return result;
        });

      await sleep(1_000);
      expect(syncDone).toBe(false);
      releaseRating.resolve();
      const [, result] = await Promise.all([rating, sync]);

      expect(result.retries).toBe(0);
      expect(await identityRep('p-e05')).toBe(await repSum('p-e05'));
      expect(await identityRep('p-e05')).not.toBe(0);
    });

    it('holds a rating that arrives while its chunk has the sources locked, then adds its delta, without a deadlock', async () => {
      // Seeded key order puts mary (0x4) in the first chunk of three.
      const sourcesLocked = deferred();
      const releaseChunk = deferred();
      const sync = identityMetricsSync.syncAll({
        chunkRows: 3,
        afterSourcesLocked: async (chunk) => {
          if (chunk !== 1) return;
          sourcesLocked.resolve();
          await releaseChunk.promise;
        }
      });
      await sourcesLocked.promise;
      let ratingDone = false;
      const rating = rateRep('p-e12', 'maryPID', -13).then(() => {
        ratingDone = true;
      });

      await sleep(1_000);
      expect(ratingDone).toBe(false);
      releaseChunk.resolve();
      const [result] = await Promise.all([sync, rating]);

      expect(result.retries).toBe(0);
      expect(await identityRep('maryPID')).toBe(await repSum('maryPID'));
    });

    it('loses no rating committed between chunks', async () => {
      const result = await identityMetricsSync.syncAll({
        chunkRows: 3,
        afterChunk: async (chunk) => {
          if (chunk !== 1) return;
          // bob is in the synced first chunk; extra 14 comes later.
          await rateRep('p-e15', 'bobPID', 44);
          await rateRep('p-e15', 'p-e14', -27);
        }
      });

      expect(result.retries).toBe(0);
      expect(await identityRep('bobPID')).toBe(await repSum('bobPID'));
      expect(await identityRep('p-e14')).toBe(await repSum('p-e14'));
    });
  }
);

describeWithSeed(
  'chunked identities metrics sync when a chunk changes under it',
  [
    ...identityMetricsSyncSeeds(),
    withRatings([
      aRepRating({
        rater_profile_id: 'p-e01',
        matter_target_id: 'p-new',
        matter_category: 'art',
        rating: 77
      })
    ])
  ],
  () => {
    it('redoes a chunk whose rows changed after they were read', async () => {
      let inserted = false;
      const result = await identityMetricsSync.syncAll({
        chunkRows: 3,
        afterSourcesLocked: async (chunk) => {
          if (chunk !== 1 || inserted) return;
          inserted = true;
          // Lands inside the first chunk's key range (0x1-0x2 .. 0x4).
          await sqlExecutor.execute(
            `insert into ${IDENTITIES_TABLE}
               (consolidation_key, profile_id, primary_address, handle, normalised_handle,
                tdh, rep, cic, level_raw, xtdh, produced_xtdh, granted_xtdh, xtdh_rate, basetdh_rate)
             values ('0x35', 'p-new', '0x35', 'new', 'new', 0, 0, 0, 0, 0, 0, 0, 0, 0)`
          );
        }
      });

      expect(inserted).toBe(true);
      expect(result.retries).toBe(1);
      expect(await identityRep('p-new')).toBe(77);
    });
  }
);
