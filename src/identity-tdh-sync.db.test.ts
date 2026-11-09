import 'reflect-metadata';
import {
  IDENTITY_TDH_SYNC_STATE_TABLE,
  WAVE_READER_METRICS_TABLE
} from '@/constants';
import { identitiesService } from '@/api/identities/identities.service';
import * as waveUnreadCache from '@/api/waves/wave-unread-cache';
import { waveScoreService } from '@/api/waves/wave-score.service';
import * as overvoteRevocation from '@/drops/participation-drops-over-vote-revocation';
import { identityConsolidationEffects, ProfileIdGenerator } from '@/identity';
import { identityMetricsSync } from '@/identity-metrics-sync';
import {
  resumePendingIdentityTdhSync,
  syncIdentitiesAfterTdh,
  syncIdentitiesAfterTdhOrLeavePending
} from '@/identity-tdh-sync';
import * as sentryContext from '@/sentry.context';
import * as notifier from '@/notifier';
import { sqs } from '@/sqs';
import { identityTdhSyncStateDb } from '@/identity-tdh-sync-state.db';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  fixturePrimaryAddress,
  identityMetricsSyncSeeds,
  readIdentities
} from '@/tests/fixtures/identity-metrics-sync.fixture';

const BLOCK = 24_000_001;

async function markPending(block = BLOCK) {
  await identityTdhSyncStateDb.ensureRows();
  await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    identityTdhSyncStateDb.markPending(block, connection)
  );
}

async function setLease(owner: string, until: number) {
  await sqlExecutor.execute(
    `update ${IDENTITY_TDH_SYNC_STATE_TABLE}
     set lease_owner = :owner, lease_until = :until where id = 'lease'`,
    { owner, until }
  );
}

describeWithSeed(
  'identities sync after consolidated TDH: marker, lease and resume',
  identityMetricsSyncSeeds(),
  () => {
    beforeEach(() => {
      jest.spyOn(sqs, 'sendToQueueName').mockResolvedValue(undefined);
      let generated = 0;
      jest
        .spyOn(ProfileIdGenerator.prototype, 'generate')
        .mockImplementation(() => `generated-${++generated}`);
      jest
        .spyOn(identitiesService, 'determinePrimaryAddress')
        .mockImplementation(fixturePrimaryAddress);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('does nothing when no TDH write is pending', async () => {
      await identityTdhSyncStateDb.ensureRows();
      const merge = jest.spyOn(
        identityConsolidationEffects,
        'syncIdentitiesWithTdhConsolidations'
      );
      const before = await readIdentities();

      await expect(syncIdentitiesAfterTdh()).resolves.toBe('UP_TO_DATE');
      await resumePendingIdentityTdhSync();

      expect(merge).not.toHaveBeenCalled();
      expect(await readIdentities()).toEqual(before);
    });

    it('leaves the generation pending while another run holds the lease, and takes over an expired lease', async () => {
      await markPending();
      await setLease('other-invocation', Time.currentMillis() + 60_000);
      const before = await readIdentities();

      await expect(syncIdentitiesAfterTdh()).resolves.toBe('LEASE_HELD');
      expect(await readIdentities()).toEqual(before);
      const held = await identityTdhSyncStateDb.readProgress();
      expect(held.pendingGeneration).toBe(1);
      expect(held.syncedGeneration).toBe(0);

      await setLease('other-invocation', Time.currentMillis() - 1);
      await expect(syncIdentitiesAfterTdh()).resolves.toBe('SYNCED');
      const synced = await identityTdhSyncStateDb.readProgress();
      expect(synced).toEqual({
        pendingGeneration: 1,
        pendingBlock: BLOCK,
        syncedGeneration: 1
      });
      // The lease is released for the next run.
      expect(
        await identityTdhSyncStateDb.acquireLease('next-invocation', 1_000)
      ).toBe(true);
    });

    it('finishes a run that stopped after the TDH commit on the next start, firing the merge effects once', async () => {
      await sqlExecutor.execute(
        `insert into ${WAVE_READER_METRICS_TABLE} (wave_id, reader_id, latest_read_timestamp, muted)
         values ('wave-1', 'bobPID', 100, false), ('wave-2', 'maryPID', 200, false)`
      );
      const invalidate = jest
        .spyOn(waveUnreadCache, 'invalidateWaveUnreadCache')
        .mockResolvedValue();
      const refresh = jest
        .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
        .mockResolvedValue(undefined as never);
      const revoke = jest.spyOn(
        overvoteRevocation,
        'revokeTdhBasedDropWavesOverVotesPerCompetition'
      );
      // Step A committed, then the invocation stopped.
      await markPending();
      // The next run stops part way through the metrics chunks.
      const crash = new Error('crash in the metrics chunks');
      await expect(
        syncIdentitiesAfterTdh({
          chunkRows: 3,
          afterChunk: (chunk) => {
            if (chunk === 2) throw crash;
          }
        })
      ).rejects.toBe(crash);
      expect(revoke).not.toHaveBeenCalled();
      const merged = invalidate.mock.calls.filter(
        ([invalidations]) => invalidations.readerWaves.length > 0
      );
      expect(merged).toHaveLength(1);
      expect(merged[0][0].readerWaves).toEqual(
        expect.arrayContaining([
          { identityId: 'bobPID', waveId: 'wave-1' },
          { identityId: 'maryPID', waveId: 'wave-2' }
        ])
      );
      const refreshesAfterCrash = refresh.mock.calls.length;
      const stopped = await identityTdhSyncStateDb.readProgress();
      expect(stopped.syncedGeneration).toBe(0);

      const syncAll = jest.spyOn(identityMetricsSync, 'syncAll');
      await resumePendingIdentityTdhSync();

      // B found the merge done; C and D ran; E marked the generation synced.
      expect(
        invalidate.mock.calls.filter(
          ([invalidations]) => invalidations.readerWaves.length > 0
        )
      ).toHaveLength(1);
      expect(refresh.mock.calls.length).toBe(refreshesAfterCrash);
      expect(syncAll).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke.mock.invocationCallOrder[0]).toBeGreaterThan(
        syncAll.mock.invocationCallOrder[0]
      );
      const done = await identityTdhSyncStateDb.readProgress();
      expect(done.syncedGeneration).toBe(done.pendingGeneration);

      // Nothing is pending any more.
      await resumePendingIdentityTdhSync();
      expect(syncAll).toHaveBeenCalledTimes(1);
    });

    it('stops before revoking or marking synced when another run took its lease over', async () => {
      await markPending();
      const revoke = jest.spyOn(
        overvoteRevocation,
        'revokeTdhBasedDropWavesOverVotesPerCompetition'
      );

      await expect(
        syncIdentitiesAfterTdh({
          chunkRows: 3,
          afterChunk: async (chunk) => {
            if (chunk === 1)
              await setLease('other-invocation', Time.currentMillis() + 60_000);
          }
        })
      ).rejects.toThrow('lease was taken over');

      expect(revoke).not.toHaveBeenCalled();
      expect(
        (await identityTdhSyncStateDb.readProgress()).syncedGeneration
      ).toBe(0);
      // The stopped run leaves the new holder's lease alone.
      const [lease] = await sqlExecutor.execute<{ lease_owner: string }>(
        `select lease_owner from ${IDENTITY_TDH_SYNC_STATE_TABLE} where id = 'lease'`
      );
      expect(lease.lease_owner).toBe('other-invocation');
    });

    it('leaves a failed sync pending without failing the loop, and reports it', async () => {
      await markPending();
      const failure = new Error('metrics chunk kept failing');
      jest.spyOn(identityMetricsSync, 'syncAll').mockRejectedValue(failure);
      const capture = jest
        .spyOn(sentryContext, 'captureException')
        .mockImplementation(() => undefined);

      await expect(
        syncIdentitiesAfterTdhOrLeavePending('AFTER_TDH_WRITE')
      ).resolves.toBe('FAILED');
      await expect(resumePendingIdentityTdhSync()).resolves.toBeUndefined();

      expect(capture).toHaveBeenCalledTimes(2);
      expect(capture).toHaveBeenCalledWith(failure);
      const progress = await identityTdhSyncStateDb.readProgress();
      expect(progress.pendingGeneration).toBe(1);
      expect(progress.syncedGeneration).toBe(0);
      // The lease was released for the next attempt.
      expect(
        await identityTdhSyncStateDb.acquireLease('next-invocation', 1_000)
      ).toBe(true);
    });

    it('reports a lease takeover as a warning, not a failure', async () => {
      await markPending();
      const capture = jest
        .spyOn(sentryContext, 'captureException')
        .mockImplementation(() => undefined);

      await expect(
        syncIdentitiesAfterTdhOrLeavePending('AFTER_TDH_WRITE', {
          chunkRows: 3,
          afterChunk: async (chunk) => {
            if (chunk === 1)
              await setLease('other-invocation', Time.currentMillis() + 60_000);
          }
        })
      ).resolves.toBe('LEASE_LOST');

      expect(capture).not.toHaveBeenCalled();
      const progress = await identityTdhSyncStateDb.readProgress();
      expect(progress.syncedGeneration).toBe(0);
    });

    it('stops at its time budget and resumes next invocation without redoing B or chunks', async () => {
      await markPending();
      const merge = jest.spyOn(
        identityConsolidationEffects,
        'syncIdentitiesWithTdhConsolidations'
      );
      const revoke = jest.spyOn(
        overvoteRevocation,
        'revokeTdhBasedDropWavesOverVotesPerCompetition'
      );
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

      expect(merge).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
      expect(sqs.sendToQueueName).not.toHaveBeenCalled();
      const stopped = await identityTdhSyncStateDb.readProgress();
      expect(stopped.syncedGeneration).toBe(0);
      const keys = (await readIdentities()).map((row) => row.consolidation_key);
      await expect(identityTdhSyncStateDb.readMetricsWalk()).resolves.toEqual({
        generation: 1,
        after: keys[5]
      });

      const syncAll = jest.spyOn(identityMetricsSync, 'syncAll');
      await resumePendingIdentityTdhSync();

      // B already committed for this generation; the walk continues.
      expect(merge).toHaveBeenCalledTimes(1);
      expect(syncAll.mock.calls[0][0]).toMatchObject({ startAfter: keys[5] });
      await expect(syncAll.mock.results[0].value).resolves.toMatchObject({
        complete: true,
        rows: keys.length - 6
      });
      expect(revoke).toHaveBeenCalledTimes(1);
      // xTDH is triggered once, after the identities are synced.
      expect(sqs.sendToQueueName).toHaveBeenCalledTimes(1);
      expect(
        jest.mocked(sqs.sendToQueueName).mock.invocationCallOrder[0]
      ).toBeGreaterThan(revoke.mock.invocationCallOrder[0]);
      const synced = await identityTdhSyncStateDb.readProgress();
      expect(synced.syncedGeneration).toBe(1);
    });

    it('announces a full TDH write once, only after its identities sync', async () => {
      await identityTdhSyncStateDb.ensureRows();
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        identityTdhSyncStateDb.markPending(BLOCK, connection, {
          announceFull: true
        })
      );
      const announce = jest
        .spyOn(notifier, 'notifyTdhCalculationsDone')
        .mockResolvedValue(undefined);
      expect(await identityTdhSyncStateDb.hasPendingFullAnnouncement()).toBe(
        true
      );

      await expect(
        syncIdentitiesAfterTdh({ chunkRows: 3, budgetSpent: () => true })
      ).resolves.toBe('BUDGET_USED');
      expect(announce).not.toHaveBeenCalled();

      await expect(syncIdentitiesAfterTdh()).resolves.toBe('SYNCED');
      expect(announce).toHaveBeenCalledTimes(1);
      // The full event reaches xTDH itself; no separate partial trigger.
      expect(sqs.sendToQueueName).not.toHaveBeenCalled();
      expect(await identityTdhSyncStateDb.hasPendingFullAnnouncement()).toBe(
        false
      );

      // A later partial write triggers xTDH and does not announce again.
      await markPending(BLOCK + 1);
      await expect(syncIdentitiesAfterTdh()).resolves.toBe('SYNCED');
      expect(announce).toHaveBeenCalledTimes(1);
      expect(sqs.sendToQueueName).toHaveBeenCalledTimes(1);
    });

    it('keeps a full TDH announcement armed when publishing it fails', async () => {
      await identityTdhSyncStateDb.ensureRows();
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        identityTdhSyncStateDb.markPending(BLOCK, connection, {
          announceFull: true
        })
      );
      const announce = jest
        .spyOn(notifier, 'notifyTdhCalculationsDone')
        .mockRejectedValueOnce(new Error('SNS unavailable'))
        .mockResolvedValue(undefined);

      await expect(syncIdentitiesAfterTdh()).rejects.toThrow('SNS unavailable');
      expect(await identityTdhSyncStateDb.hasPendingFullAnnouncement()).toBe(
        true
      );
      expect(
        (await identityTdhSyncStateDb.readProgress()).syncedGeneration
      ).toBe(0);

      await resumePendingIdentityTdhSync();
      expect(announce).toHaveBeenCalledTimes(2);
      expect(await identityTdhSyncStateDb.hasPendingFullAnnouncement()).toBe(
        false
      );
      expect(
        (await identityTdhSyncStateDb.readProgress()).syncedGeneration
      ).toBe(1);
    });

    it('marks only the generation it read as synced', async () => {
      await markPending(BLOCK);
      const original = identityMetricsSync.syncAll.bind(identityMetricsSync);
      jest
        .spyOn(identityMetricsSync, 'syncAll')
        .mockImplementationOnce(async (options) => {
          // Another TDH write commits while this run is in its chunks.
          await markPending(BLOCK + 1);
          return original(options);
        });

      await expect(syncIdentitiesAfterTdh()).resolves.toBe('SYNCED');

      const progress = await identityTdhSyncStateDb.readProgress();
      expect(progress).toEqual({
        pendingGeneration: 2,
        pendingBlock: BLOCK + 1,
        syncedGeneration: 1
      });
      // The next start picks the newer write up.
      await resumePendingIdentityTdhSync();
      const resumed = await identityTdhSyncStateDb.readProgress();
      expect(resumed.syncedGeneration).toBe(2);
    });
  }
);
