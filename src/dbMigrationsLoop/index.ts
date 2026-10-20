import { pushNotificationCancellationsDb } from '@/notifications/push-notification-cancellations.db';
import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import * as Entities from '../entities/entities';
import { doInDbContext } from '../secrets';
import { appFeatures } from '../app-features';
import { contentModerationDb } from '../content-moderation/content-moderation.db';
import { Time } from '../time';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import {
  WalletTransferAnalysisStateEntity,
  WalletTransferPairDailyEntity,
  WalletTransferWalletDailyEntity
} from '@/entities/IWalletTransferAnalysis';
import { moderationRetentionSchemaDb } from './moderation-retention-schema.db';
import { MintingClaimEntity } from '@/entities/IMintingClaim';
import { applyClaimsMediaUploadSchema } from './claims-media-schema';
import { NftLinkEntity } from '@/entities/INftLink';
import { applyNftLinkPageRetrySchema } from './nft-link-page-retry-schema';
import { getDataSource } from '@/db';
import { installLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import { retireLegacyCompetitionRuntime } from '@/competitions/competition-runtime-retirement';
import { dbSupplier } from '@/sql-executor';
import { transferCompetitionRetirementHistory } from '@/competitions/competition-retirement-history';
import {
  assertCompetitionHistoryPreparationAllowed,
  isCompetitionRuntimeRetired
} from '@/competitions/competition-runtime-retirement-state';
import { transferRetainedCompetitionDistributions } from '@/competitions/competition-retirement-distributions';
import { transferRetainedCompetitionLeaderboardPublication } from '@/competitions/competition-retirement-leaderboard';
import { MarketDepthPublicationLockEntity } from '@/entities/IMarketDepthPublicationLock';
import {
  prepareWaveHubConfiguration,
  finalizeWaveHubConfigurationCapture
} from '@/waves/wave-hub-configuration-preparation';

const DBMigrate = require('db-migrate');

const logger = Logger.get('DB_MIGRATIONS_LOOP');
export const CONTENT_MODERATION_RETENTION_BATCH_SIZE = 1000;
export const CONTENT_MODERATION_RETENTION_MAX_BATCHES = 10;

type ContentModerationRetentionDb = Pick<
  typeof contentModerationDb,
  'deleteExpiredPrePublicationChecks'
>;

export async function deleteExpiredContentModerationChecksInBatches(
  olderThan: number,
  moderationDb: ContentModerationRetentionDb = contentModerationDb
): Promise<number> {
  let totalDeleted = 0;
  for (
    let batch = 0;
    batch < CONTENT_MODERATION_RETENTION_MAX_BATCHES;
    batch++
  ) {
    const deleted = await moderationDb.deleteExpiredPrePublicationChecks(
      olderThan,
      CONTENT_MODERATION_RETENTION_BATCH_SIZE
    );
    totalDeleted += deleted;
    if (deleted < CONTENT_MODERATION_RETENTION_BATCH_SIZE) {
      break;
    }
  }
  return totalDeleted;
}

export function isScheduledInvocation(event: unknown): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const record = event as Record<string, unknown>;
  return (
    record.source === 'aws.events' &&
    record['detail-type'] === 'Scheduled Event'
  );
}

function schemaScope(event: unknown, scheduledInvocation: boolean) {
  if (
    !event ||
    typeof event !== 'object' ||
    !Object.prototype.hasOwnProperty.call(event, 'schema_scope')
  ) {
    return 'full';
  }
  const scope = (event as { schema_scope: unknown }).schema_scope;
  if (
    scheduledInvocation ||
    (scope !== 'full' &&
      scope !== 'maintenance' &&
      scope !== 'wallet-transfer-analysis' &&
      scope !== 'claims-media-upload' &&
      scope !== 'nft-link-page-retry' &&
      scope !== 'market-depth-publication-lock' &&
      scope !== 'competition-runtime-schema' &&
      scope !== 'competition-runtime-retirement' &&
      scope !== 'wave-hub-configuration-preparation' &&
      scope !== 'wave-hub-configuration-finalize' &&
      scope !== 'competition-history-preparation')
  ) {
    throw new Error('Unsupported database schema scope for this invocation');
  }
  return scope;
}

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  const scheduledInvocation = isScheduledInvocation(event);
  const scope = schemaScope(event, scheduledInvocation);
  logger.info(`[RUNNING]`);
  if (
    scope === 'wave-hub-configuration-preparation' ||
    scope === 'wave-hub-configuration-finalize'
  ) {
    const result = await doInDbContext(
      async () =>
        scope === 'wave-hub-configuration-preparation'
          ? await prepareWaveHubConfiguration(dbSupplier())
          : await finalizeWaveHubConfigurationCapture(dbSupplier()),
      {
        logger,
        entities: Object.values(Entities),
        syncEntities: false,
        skipRedis: true
      }
    );
    return { schema_scope: scope, ...result };
  }
  if (scope === 'competition-runtime-schema') {
    await doInDbContext(() => Promise.resolve(), {
      logger,
      entities: Object.values(Entities),
      syncEntities: true,
      skipRedis: true
    });
    return { schema_scope: scope };
  }

  if (scope === 'competition-history-preparation') {
    const result = await doInDbContext(
      async () => {
        await assertCompetitionHistoryPreparationAllowed(dbSupplier());
        return {
          history: await transferCompetitionRetirementHistory(dbSupplier()),
          distribution_history:
            await transferRetainedCompetitionDistributions(dbSupplier()),
          leaderboard_publication:
            await transferRetainedCompetitionLeaderboardPublication(
              dbSupplier()
            )
        };
      },
      {
        logger,
        entities: Object.values(Entities),
        syncEntities: false,
        skipRedis: true
      }
    );
    return { schema_scope: scope, ...result };
  }

  if (scope === 'competition-runtime-retirement') {
    const result = await doInDbContext(
      () => retireLegacyCompetitionRuntime(dbSupplier()),
      {
        logger,
        entities: Object.values(Entities),
        syncEntities: false,
        skipRedis: true
      }
    );
    return { schema_scope: scope, ...result };
  }

  if (scope === 'market-depth-publication-lock') {
    await doInDbContext(() => Promise.resolve(undefined), {
      logger,
      entities: [MarketDepthPublicationLockEntity],
      syncEntities: true,
      skipRedis: true
    });
    logger.info('[FINISHED MARKET DEPTH PUBLICATION LOCK SCHEMA]');
    return { schema_scope: scope };
  }
  if (scope === 'nft-link-page-retry') {
    await doInDbContext(
      async () => {
        const added = await applyNftLinkPageRetrySchema();
        logger.info(`[NFT RETRY SCHEMA COLUMNS ADDED] ${added}`);
      },
      {
        logger,
        entities: [NftLinkEntity],
        syncEntities: false,
        skipRedis: true
      }
    );
    return { schema_scope: scope };
  }
  if (scope === 'claims-media-upload') {
    const addedColumns = await doInDbContext(applyClaimsMediaUploadSchema, {
      logger,
      entities: [MintingClaimEntity],
      syncEntities: false,
      skipRedis: true
    });
    logger.info(
      `[FINISHED CLAIM MEDIA UPLOAD SCHEMA] added_columns=${addedColumns}`
    );
    return { schema_scope: scope };
  }
  if (scope === 'wallet-transfer-analysis') {
    await doInDbContext(async () => undefined, {
      logger,
      entities: [
        WalletTransferAnalysisStateEntity,
        WalletTransferPairDailyEntity,
        WalletTransferWalletDailyEntity
      ],
      syncEntities: true,
      skipRedis: true
    });
    logger.info('[FINISHED WALLET TRANSFER ANALYSIS SCHEMA]');
    return { schema_scope: scope };
  }
  await doInDbContext(
    async () => {
      // Synchronization ignores tables outside the current entity registry; retirement is operator-only.
      if (!scheduledInvocation && scope === 'full')
        await getDataSource().synchronize();
      if (
        !scheduledInvocation &&
        scope === 'full' &&
        (await isCompetitionRuntimeRetired(dbSupplier()))
      ) {
        await installLegacyCompetitionGetFacade(dbSupplier());
      }
      if (
        !scheduledInvocation &&
        scope === 'full' &&
        !appFeatures.isDbMigrateDisabled()
      ) {
        const dbmigrate = await DBMigrate.getInstance(true, {
          config: './database.json',
          env: 'main'
        });
        await dbmigrate.up();
      }
      await pushNotificationCancellationsDb.deleteExpired();
      const deletedModerationChecks =
        await deleteExpiredContentModerationChecksInBatches(
          Time.currentMillis() - Time.days(30).toMillis()
        );
      const missingRetentionColumns =
        await moderationRetentionSchemaDb.missingColumns({});
      if (missingRetentionColumns.length) {
        logger.info(
          `[SKIPPED MODERATION REVIEW RETENTION: PENDING SCHEMA] ${missingRetentionColumns.join(', ')}`
        );
      } else {
        await moderationReviewDb.retain({});
      }
      logger.info(
        `Deleted ${deletedModerationChecks} expired content moderation pre-publication checks`
      );
    },
    {
      logger,
      entities: Object.values(Entities),
      syncEntities: false
    }
  );

  logger.info(`[FINISHED]`);
  if (scope === 'maintenance') return { schema_scope: scope };
});
