import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import * as Entities from '../entities/entities';
import { doInDbContext } from '../secrets';
import { appFeatures } from '../app-features';
import { competitionRepository } from '../competitions/competition.repository';
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
import {
  applyMembershipSchema,
  membershipSchemaEntities
} from './membership-schema';
import {
  applyMembershipEvaluatorSchema,
  membershipEvaluatorSchemaEntities
} from './membership-evaluator-schema';
import { applyFullSchemaWithMembershipGuard } from './membership-controlled-schema';
import {
  applyMembershipRuntimeSchema,
  membershipRuntimeSchemaEntities
} from './membership-runtime-schema';
import {
  applyMembershipBackfillIndexSchema,
  membershipBackfillIndexEntities
} from './membership-backfill-index-schema';

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
      scope !== 'wallet-transfer-analysis' &&
      scope !== 'claims-media-upload' &&
      scope !== 'nft-link-page-retry' &&
      scope !== 'membership-refresh' &&
      scope !== 'membership-evaluator-index' &&
      scope !== 'membership-runtime-control' &&
      scope !== 'membership-backfill-probes')
  ) {
    throw new Error('Unsupported database schema scope for this invocation');
  }
  return scope;
}

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  const scheduledInvocation = isScheduledInvocation(event);
  const scope = schemaScope(event, scheduledInvocation);
  logger.info(`[RUNNING]`);
  if (scope === 'membership-backfill-probes') {
    const verification = await doInDbContext(
      applyMembershipBackfillIndexSchema,
      {
        logger,
        entities: membershipBackfillIndexEntities,
        syncEntities: false,
        skipRedis: true
      }
    );
    return { schema_scope: scope, ...verification };
  }
  if (scope === 'membership-runtime-control') {
    const verification = await doInDbContext(applyMembershipRuntimeSchema, {
      logger,
      entities: membershipRuntimeSchemaEntities,
      syncEntities: false,
      skipRedis: true
    });
    return { schema_scope: scope, ...verification };
  }
  if (scope === 'membership-evaluator-index') {
    const verification = await doInDbContext(applyMembershipEvaluatorSchema, {
      logger,
      entities: membershipEvaluatorSchemaEntities,
      syncEntities: false,
      skipRedis: true
    });
    return { schema_scope: scope, ...verification };
  }
  if (scope === 'membership-refresh') {
    const verification = await doInDbContext(() => applyMembershipSchema(), {
      logger,
      entities: membershipSchemaEntities,
      syncEntities: false,
      skipRedis: true
    });
    logger.info(`[FINISHED MEMBERSHIP SCHEMA] ${JSON.stringify(verification)}`);
    return { schema_scope: scope, ...verification };
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
      if (!scheduledInvocation) await applyFullSchemaWithMembershipGuard();
      if (!scheduledInvocation && !appFeatures.isDbMigrateDisabled()) {
        const dbmigrate = await DBMigrate.getInstance(true, {
          config: './database.json',
          env: 'main'
        });
        await dbmigrate.up();
      }
      const insertedLegacyCompetitions =
        await competitionRepository.backfillLegacyMappings({});
      logger.info(
        `Ensured immutable legacy competition mappings; inserted ${insertedLegacyCompetitions}`
      );
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
});
