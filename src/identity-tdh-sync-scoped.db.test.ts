import 'reflect-metadata';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_TDH_SYNC_SCOPE_TABLE,
  IDENTITY_TDH_SYNC_STATE_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { identitiesService } from '@/api/identities/identities.service';
import { identityConsolidationEffects, ProfileIdGenerator } from '@/identity';
import { identityMetricsSync } from '@/identity-metrics-sync';
import {
  resumePendingIdentityTdhSync,
  startIdentitySyncBudget,
  syncIdentitiesAfterTdh,
  syncIdentitiesAfterTdhOrLeavePending
} from '@/identity-tdh-sync';
import { identityTdhSyncScopeDb } from '@/identity-tdh-sync-scope.db';
import { identityTdhSyncStateDb } from '@/identity-tdh-sync-state.db';
import { ratingsDb } from '@/rates/ratings.db';
import { sqs } from '@/sqs';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  fixturePrimaryAddress,
  identityMetricsSyncSeeds,
  IdentityRow,
  OLD_ALGORITHM_SQL,
  readIdentities,
  readWaveSubscriberCounts
} from '@/tests/fixtures/identity-metrics-sync.fixture';
import { aProfile } from '@/tests/fixtures/profile.fixture';

const BLOCK = 24_000_002;
const ROLLBACK = new Error('reference run is rolled back');
/** What the fixture's consolidations replace and write in step A. */
const MERGE_KEYS = ['0x1-0x2', '0x3', '0x4', '0x1', '0x2', '0x3-0x4'];
/** The pre-change profile address sync: every profile, every run. */
const OLD_PROFILE_ADDRESS_SQL = `update ${PROFILES_TABLE} p
  join ${IDENTITIES_TABLE} i on i.profile_id = p.external_id
  set p.primary_wallet = i.primary_address
  where p.primary_wallet != i.primary_address`;

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
  profiles: { external_id: string; primary_wallet: string }[];
};

async function readProfileWallets() {
  return sqlExecutor.execute<{ external_id: string; primary_wallet: string }>(
    `select external_id, primary_wallet from ${PROFILES_TABLE} order by external_id`
  );
}

/**
 * The pre-change run: the identities sync with the merge, then the old
 * all-rows metrics SQL and the all-profiles address sync, in one rolled back
 * transaction.
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
      for (const sql of [...OLD_ALGORITHM_SQL, OLD_PROFILE_ADDRESS_SQL]) {
        await sqlExecutor.execute(sql, undefined, {
          wrappedConnection: connection
        });
      }
      result.reference = {
        identities: await readIdentities(connection),
        waves: await readWaveSubscriberCounts(connection),
        profiles: await sqlExecutor.execute(
          `select external_id, primary_wallet from ${PROFILES_TABLE} order by external_id`,
          undefined,
          { wrappedConnection: connection }
        )
      };
      throw ROLLBACK;
    })
  ).rejects.toBe(ROLLBACK);
  expect(await readIdentities()).toEqual(before);
  generatedIds = 0;
  return result.reference!;
}

/**
 * Identities as a finished earlier sync left them: every metric matches its
 * sources, the ratings watermark is set, and the last full walk is recent.
 */
async function afterAFinishedSync({
  fullWalkHoursAgo = 1
}: { fullWalkHoursAgo?: number } = {}) {
  for (const sql of OLD_ALGORITHM_SQL) await sqlExecutor.execute(sql);
  await identityTdhSyncStateDb.ensureRows();
  await sqlExecutor.execute(
    `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
     set ratings_since = unix_timestamp() - 1200 where id = 'synced'`
  );
  await setLastFullWalk(fullWalkHoursAgo);
}

async function setLastFullWalk(hoursAgo: number) {
  await sqlExecutor.execute(
    `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
     set updated_at = :at where id = 'full_walk'`,
    { at: Time.currentMillis() - Time.hours(hoursAgo).toMillis() }
  );
}

/** Step A of a partial write: the marker and the keys it changed. */
async function partialTdhWrite(keys: string[]): Promise<number> {
  await identityTdhSyncStateDb.ensureRows();
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const generation = await identityTdhSyncStateDb.markPending(
      BLOCK,
      connection
    );
    await identityTdhSyncScopeDb.recordTdhWrite(generation, keys, connection);
    return generation;
  });
}

/** Step A of a full rewrite: the marker only. */
async function fullTdhWrite(): Promise<number> {
  await identityTdhSyncStateDb.ensureRows();
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    identityTdhSyncStateDb.markPending(BLOCK, connection, {
      announceFull: true
    })
  );
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

/** The API's rating write: the rating, then the identity delta. */
async function rateRep(rater: string, target: string, rating: number) {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    await sqlExecutor.execute(
      `insert into ${RATINGS_TABLE}
         (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified)
       values (:rater, :target, 'REP', 'during-sync', :rating, current_time)`,
      { rater, target, rating },
      { wrappedConnection: connection }
    );
    await ratingsDb.applyBulkIdentityUpdates(
      [{ profileId: target, repChange: rating }],
      connection
    );
  });
}

/**
 * A rating whose identity delta is lost, stamped `secondsAgo` before now:
 * like a transaction that set `last_modified` before the sync's walk
 * started and committed after the sync read ratings.
 */
async function rateRepWithoutDelta(
  rater: string,
  target: string,
  rating: number,
  secondsAgo: number
) {
  await sqlExecutor.execute(
    `insert into ${RATINGS_TABLE}
       (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified)
     values (:rater, :target, 'REP', 'lost-delta', :rating,
             from_unixtime(unix_timestamp() - :secondsAgo))`,
    { rater, target, rating, secondsAgo }
  );
}

async function scopeGenerations(): Promise<number[]> {
  const rows = await sqlExecutor.execute<{ generation: number | string }>(
    `select distinct generation from ${IDENTITY_TDH_SYNC_SCOPE_TABLE} order by generation`
  );
  return rows.map((row) => Number(row.generation));
}

/** The old algorithm on the synced state: it must find nothing to change. */
async function expectFullWalkChangesNothing() {
  const before = await readIdentities();
  const walk = await identityMetricsSync.syncAll();
  expect(walk.updated).toBe(0);
  expect(await readIdentities()).toEqual(before);
}

describeWithSeed(
  'scoped identities sync after a partial consolidated-TDH write',
  identityMetricsSyncSeeds(),
  () => {
    beforeEach(() => {
      useDeterministicMergeDependencies();
      jest.spyOn(sqs, 'sendToQueueName').mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each([3, 2_000])(
      'ends where the old all-rows algorithm did, merge included, recomputing only the changed identities (chunks of %d)',
      async (chunkRows) => {
        await afterAFinishedSync();
        await partialTdhWrite(MERGE_KEYS);
        const reference = await referenceRun();
        const walkAll = jest.spyOn(identityMetricsSync, 'syncAll');
        const scoped = jest.spyOn(identityMetricsSync, 'syncScoped');

        await expect(syncIdentitiesAfterTdh({ chunkRows })).resolves.toBe(
          'SYNCED'
        );

        expect(walkAll).not.toHaveBeenCalled();
        expect(scoped).toHaveBeenCalledTimes(1);
        const result = await scoped.mock.results[0].value;
        expect(result.rows).toBeLessThan(reference.identities.length / 2);
        expect(result.updated).toBeGreaterThan(0);
        expect(await readIdentities()).toEqual(reference.identities);
        expect(await readWaveSubscriberCounts()).toEqual(reference.waves);
        walkAll.mockRestore();
        await expectFullWalkChangesNothing();
        // Synced, with this walk's watermark, and the scope dropped.
        const progress = await identityTdhSyncStateDb.readProgress();
        expect(progress.syncedGeneration).toBe(1);
        expect(await identityTdhSyncStateDb.readSyncedRatingsSince()).toBe(
          await identityTdhSyncStateDb.readWalkRatingsSince()
        );
        await expect(scopeGenerations()).resolves.toEqual([]);
      }
    );

    it('covers the identities step B wrote even when step A recorded none of their keys', async () => {
      await afterAFinishedSync();
      await partialTdhWrite([]);
      const reference = await referenceRun();

      await expect(syncIdentitiesAfterTdh({ chunkRows: 3 })).resolves.toBe(
        'SYNCED'
      );

      expect(await readIdentities()).toEqual(reference.identities);
      await expectFullWalkChangesNothing();
    });

    it('keeps a rating that lands during a scoped run correct, and rechecks a late one on the next run', async () => {
      await afterAFinishedSync();
      await partialTdhWrite(MERGE_KEYS);
      let landed = false;

      await expect(
        syncIdentitiesAfterTdh({
          chunkRows: 3,
          afterChunk: async () => {
            if (landed) return;
            landed = true;
            // In scope (mary is merged) and out of scope (extra 10).
            await rateRep('p-e01', 'maryPID', 19);
            await rateRep('p-e01', 'p-e10', -23);
            // Committed after this run read ratings, stamped before its walk
            // started: within the margin of the next run's watermark.
            await rateRepWithoutDelta('p-e02', 'p-e11', 37, 300);
          }
        })
      ).resolves.toBe('SYNCED');

      expect(landed).toBe(true);
      expect(await identityRep('maryPID')).toBe(await repSum('maryPID'));
      expect(await identityRep('p-e10')).toBe(await repSum('p-e10'));
      // Its delta was lost and this run had already read ratings.
      expect(await identityRep('p-e11')).toBe((await repSum('p-e11')) - 37);

      // The next partial write, unrelated to extra 11.
      await partialTdhWrite(['0xe20']);
      const scoped = jest.spyOn(identityMetricsSync, 'syncScoped');
      await expect(syncIdentitiesAfterTdh({ chunkRows: 3 })).resolves.toBe(
        'SYNCED'
      );

      expect(scoped).toHaveBeenCalledTimes(1);
      expect(await identityRep('p-e11')).toBe(await repSum('p-e11'));
      await expectFullWalkChangesNothing();
    });

    it('leaves older drift to the daily full walk', async () => {
      await afterAFinishedSync();
      // Drift from before the watermark, on an identity nothing touches.
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set rep = rep + 5, level_raw = level_raw + 5
         where profile_id = 'p-e12'`
      );
      const drifted = await identityRep('p-e12');
      await partialTdhWrite(MERGE_KEYS);

      await expect(syncIdentitiesAfterTdh({ chunkRows: 3 })).resolves.toBe(
        'SYNCED'
      );
      expect(await identityRep('p-e12')).toBe(drifted);

      // A day after the last full walk, the next sync walks every identity.
      await setLastFullWalk(25);
      await partialTdhWrite(['0xe20']);
      const walkAll = jest.spyOn(identityMetricsSync, 'syncAll');
      await expect(syncIdentitiesAfterTdh({ chunkRows: 3 })).resolves.toBe(
        'SYNCED'
      );

      expect(walkAll).toHaveBeenCalledTimes(1);
      expect(await identityRep('p-e12')).toBe(await repSum('p-e12'));
      expect(await identityTdhSyncStateDb.readLastFullWalkAt()).toBeGreaterThan(
        Time.currentMillis() - Time.minutes(1).toMillis()
      );
    });

    it.each([
      [
        'a full TDH rewrite is pending',
        async () => {
          await afterAFinishedSync();
          await partialTdhWrite(MERGE_KEYS);
          await fullTdhWrite();
        }
      ],
      [
        'a pending write recorded no scope (older code)',
        async () => {
          await afterAFinishedSync();
          await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
            identityTdhSyncStateDb.markPending(BLOCK, connection)
          );
        }
      ],
      [
        'no sync has set a ratings watermark yet',
        async () => {
          for (const sql of OLD_ALGORITHM_SQL) await sqlExecutor.execute(sql);
          await partialTdhWrite(MERGE_KEYS);
          await setLastFullWalk(1);
        }
      ]
    ])('walks every identity when %s', async (_, arrange) => {
      await arrange();
      const walkAll = jest.spyOn(identityMetricsSync, 'syncAll');
      const scoped = jest.spyOn(identityMetricsSync, 'syncScoped');

      await expect(syncIdentitiesAfterTdh({ chunkRows: 3 })).resolves.toBe(
        'SYNCED'
      );

      expect(walkAll).toHaveBeenCalledTimes(1);
      // A scoped pass only rechecks the recorded scope after the walk.
      expect(
        scoped.mock.invocationCallOrder.every(
          (order) => order > walkAll.mock.invocationCallOrder[0]
        )
      ).toBe(true);
      await expect(walkAll.mock.results[0].value).resolves.toMatchObject({
        complete: true,
        rows: (await readIdentities()).length
      });
      expect(await identityTdhSyncStateDb.readSyncedRatingsSince()).toBe(
        await identityTdhSyncStateDb.readWalkRatingsSince()
      );
      await expect(scopeGenerations()).resolves.toEqual([]);
    });

    it('leaves a full walk for the loop resume when it would run right after a TDH write', async () => {
      await afterAFinishedSync();
      await fullTdhWrite();
      await partialTdhWrite(MERGE_KEYS);
      const merge = jest.spyOn(
        identityConsolidationEffects,
        'syncIdentitiesWithTdhConsolidations'
      );

      await expect(
        syncIdentitiesAfterTdhOrLeavePending('AFTER_TDH_WRITE')
      ).resolves.toBe('FULL_WALK_DEFERRED');
      expect(merge).not.toHaveBeenCalled();
      expect(
        (await identityTdhSyncStateDb.readProgress()).syncedGeneration
      ).toBe(0);

      await resumePendingIdentityTdhSync();

      expect(merge).toHaveBeenCalledTimes(1);
      expect(
        (await identityTdhSyncStateDb.readProgress()).syncedGeneration
      ).toBe(2);
    });

    it('keeps the scope of a write committed during the sync for its own sync', async () => {
      await afterAFinishedSync();
      await partialTdhWrite(MERGE_KEYS);
      let concurrent = 0;

      await expect(
        syncIdentitiesAfterTdh({
          chunkRows: 3,
          afterChunk: async () => {
            if (!concurrent) concurrent = await partialTdhWrite(['0xe05']);
          }
        })
      ).resolves.toBe('SYNCED');

      expect(concurrent).toBe(2);
      await expect(scopeGenerations()).resolves.toEqual([2]);
      expect(await identityTdhSyncStateDb.readProgress()).toMatchObject({
        pendingGeneration: 2,
        syncedGeneration: 1
      });
      const scoped = jest.spyOn(identityMetricsSync, 'syncScoped');
      await expect(syncIdentitiesAfterTdh()).resolves.toBe('SYNCED');
      expect(scoped.mock.calls[0][0].consolidationKeys).toEqual(['0xe05']);
      await expect(scopeGenerations()).resolves.toEqual([]);
    });

    it('walks every identity, with a checkpoint, after a scoped walk stopped by the budget, without redoing B', async () => {
      await afterAFinishedSync();
      await partialTdhWrite(MERGE_KEYS);
      const reference = await referenceRun();
      const merge = jest.spyOn(
        identityConsolidationEffects,
        'syncIdentitiesWithTdhConsolidations'
      );
      let committedChunks = 0;

      await expect(
        syncIdentitiesAfterTdh({
          chunkRows: 3,
          afterChunk: (chunk) => {
            committedChunks = chunk;
          },
          budgetSpent: () => committedChunks >= 1
        })
      ).resolves.toBe('BUDGET_USED');
      expect(
        (await identityTdhSyncStateDb.readProgress()).syncedGeneration
      ).toBe(0);
      const walkAll = jest.spyOn(identityMetricsSync, 'syncAll');
      const scoped = jest.spyOn(identityMetricsSync, 'syncScoped');

      await resumePendingIdentityTdhSync();

      expect(merge).toHaveBeenCalledTimes(1);
      expect(walkAll).toHaveBeenCalledTimes(1);
      expect(walkAll.mock.calls[0][0]).toMatchObject({ startAfter: '' });
      // Only the recheck of the recorded scope after the walk.
      expect(scoped.mock.calls.map(([call]) => call.chunkRows)).toEqual([
        undefined
      ]);
      expect(await readIdentities()).toEqual(reference.identities);
      expect(
        (await identityTdhSyncStateDb.readProgress()).syncedGeneration
      ).toBe(1);
      await expect(scopeGenerations()).resolves.toEqual([]);
    });

    it('continues a full walk for a newer partial write, and rechecks what that write changed behind the walk', async () => {
      // A full walk (no watermark yet) stops after two chunks.
      for (const sql of OLD_ALGORITHM_SQL) await sqlExecutor.execute(sql);
      await partialTdhWrite(MERGE_KEYS);
      await setLastFullWalk(1);
      let committedChunks = 0;
      await expect(
        syncIdentitiesAfterTdh({
          chunkRows: 3,
          afterChunk: (chunk) => {
            committedChunks = chunk;
          },
          budgetSpent: () => committedChunks >= 2
        })
      ).resolves.toBe('BUDGET_USED');
      const walked = await identityTdhSyncStateDb.readMetricsWalk();
      expect(walked.generation).toBe(1);
      // A newer partial write changes the TDH of a key the walk has passed.
      const behind = (await readIdentities())[0].consolidation_key;
      expect(behind <= walked.after).toBe(true);
      await sqlExecutor.execute(
        `update ${CONSOLIDATED_WALLETS_TDH_TABLE}
         set boosted_tdh = boosted_tdh + 1000 where consolidation_key = :behind`,
        { behind }
      );
      await partialTdhWrite([behind]);
      const walkAll = jest.spyOn(identityMetricsSync, 'syncAll');

      await resumePendingIdentityTdhSync();

      expect(walkAll.mock.calls[0][0]).toMatchObject({
        startAfter: walked.after
      });
      expect(
        (await identityTdhSyncStateDb.readProgress()).syncedGeneration
      ).toBe(2);
      walkAll.mockRestore();
      await expectFullWalkChangesNothing();
    });

    it('gives the loop resume a minimum slice when the invocation budget is spent, but not the sync after a TDH write', async () => {
      await afterAFinishedSync();
      await partialTdhWrite(MERGE_KEYS);
      startIdentitySyncBudget(0);
      try {
        await expect(syncIdentitiesAfterTdh()).resolves.toBe('BUDGET_USED');
        expect(
          (await identityTdhSyncStateDb.readProgress()).syncedGeneration
        ).toBe(0);

        await resumePendingIdentityTdhSync();

        expect(
          (await identityTdhSyncStateDb.readProgress()).syncedGeneration
        ).toBe(1);
      } finally {
        // Generous for the rest of this file's tests.
        startIdentitySyncBudget(Time.hours(1).toMillis());
      }
    });

    it('records a consolidation key of the longest length intact', async () => {
      const longKey = Array.from(
        { length: 10 },
        (_, i) => `0x${String(i).padStart(40, '0')}`
      ).join('-');
      expect(longKey.length).toBeGreaterThan(400);
      const generation = await partialTdhWrite([longKey]);

      await expect(
        identityTdhSyncScopeDb.readScope(generation - 1, generation)
      ).resolves.toEqual({ consolidationKeys: [longKey], profileIds: [] });
    });
  }
);

describeWithSeed(
  'profile addresses in step B',
  identityMetricsSyncSeeds(),
  () => {
    const untouched = aProfile({
      external_id: 'p-e10',
      handle: 'extra10',
      primary_wallet: 'stale-extra-10'
    });

    beforeEach(async () => {
      useDeterministicMergeDependencies();
      jest.spyOn(sqs, 'sendToQueueName').mockResolvedValue(undefined);
      await sqlExecutor.bulkInsert(
        PROFILES_TABLE,
        [untouched],
        Object.keys(untouched)
      );
      // alice's identity is rewritten by the split; her profile is stale.
      await sqlExecutor.execute(
        `update ${PROFILES_TABLE} set primary_wallet = 'stale-alice'
         where external_id = 'alicePID'`
      );
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('heals a profile B did not touch with the all-profiles check after a full walk', async () => {
      await afterAFinishedSync();
      await fullTdhWrite();

      await expect(syncIdentitiesAfterTdh({ chunkRows: 3 })).resolves.toBe(
        'SYNCED'
      );

      const wallets = await readProfileWallets();
      expect(
        wallets.find((p) => p.external_id === untouched.external_id)
      ).toEqual({
        external_id: untouched.external_id,
        primary_wallet: '0xe10'
      });
    });

    it('checks only the profiles it touched: the same result for those, and an untouched profile is never read, locked or changed', async () => {
      await afterAFinishedSync();
      await partialTdhWrite(MERGE_KEYS);
      const reference = await referenceRun();
      const statements: string[] = [];
      let recording = false;
      const execute = sqlExecutor.execute.bind(sqlExecutor);
      jest
        .spyOn(sqlExecutor, 'execute')
        .mockImplementation(async (sql, params, options) => {
          if (recording) statements.push(JSON.stringify({ sql, params }));
          return execute(sql, params, options);
        });
      const stepB =
        identityConsolidationEffects.syncIdentitiesWithTdhConsolidations.bind(
          identityConsolidationEffects
        );
      jest
        .spyOn(
          identityConsolidationEffects,
          'syncIdentitiesWithTdhConsolidations'
        )
        .mockImplementationOnce(async (connection) => {
          recording = true;
          try {
            return await stepB(connection);
          } finally {
            recording = false;
          }
        });
      let lockedWhileOpen = false;
      const record = identityTdhSyncScopeDb.recordIdentitiesWritten.bind(
        identityTdhSyncScopeDb
      );
      jest
        .spyOn(identityTdhSyncScopeDb, 'recordIdentitiesWritten')
        .mockImplementation(async (generation, written, connection) => {
          // B's transaction is still open: the untouched profile is free.
          await sqlExecutor.executeNativeQueriesInTransaction((other) =>
            execute(
              `select external_id from ${PROFILES_TABLE}
               where external_id = :id for update nowait`,
              { id: untouched.external_id },
              { wrappedConnection: other }
            )
          );
          lockedWhileOpen = true;
          return record(generation, written, connection);
        });

      await expect(syncIdentitiesAfterTdh({ chunkRows: 3 })).resolves.toBe(
        'SYNCED'
      );

      expect(lockedWhileOpen).toBe(true);
      expect(statements.length).toBeGreaterThan(0);
      expect(
        statements.filter((statement) =>
          statement.includes(untouched.external_id)
        )
      ).toEqual([]);
      const wallets = await readProfileWallets();
      expect(wallets).toEqual(
        reference.profiles
          .map((profile) =>
            profile.external_id === untouched.external_id ? untouched : profile
          )
          .map(({ external_id, primary_wallet }) => ({
            external_id,
            primary_wallet
          }))
      );
      // The old all-profiles sync fixed alice the same way, and also the
      // untouched profile, which this one leaves alone.
      expect(
        reference.profiles.find((p) => p.external_id === 'alicePID')
      ).toEqual({ external_id: 'alicePID', primary_wallet: '0x1' });
      expect(
        reference.profiles.find((p) => p.external_id === untouched.external_id)
          ?.primary_wallet
      ).toBe('0xe10');
    });
  }
);
