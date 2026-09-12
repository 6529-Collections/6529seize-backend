import { doInDbContext } from '@/secrets';
import { competitionRepository } from '@/competitions/competition.repository';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import * as Entities from '@/entities/entities';
import {
  WalletTransferAnalysisStateEntity,
  WalletTransferPairDailyEntity,
  WalletTransferWalletDailyEntity
} from '@/entities/IWalletTransferAnalysis';
import { handler } from './index';
import { moderationRetentionSchemaDb } from './moderation-retention-schema.db';

jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: (event: unknown) => Promise<unknown>) => fn
}));
jest.mock('@/logging', () => {
  const info = jest.fn();
  return { Logger: { get: () => ({ info }) }, info };
});
jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (fn: () => Promise<unknown>) => fn())
}));
jest.mock('@/app-features', () => ({
  appFeatures: { isDbMigrateDisabled: () => false }
}));
jest.mock('@/competitions/competition.repository', () => ({
  competitionRepository: {
    backfillLegacyMappings: jest.fn().mockResolvedValue(0)
  }
}));
jest.mock('@/content-moderation/content-moderation.db', () => ({
  contentModerationDb: {
    deleteExpiredPrePublicationChecks: jest.fn().mockResolvedValue(0)
  }
}));
jest.mock('@/content-moderation/moderation-review.db', () => ({
  moderationReviewDb: { retain: jest.fn().mockResolvedValue(undefined) }
}));
jest.mock('./moderation-retention-schema.db', () => ({
  moderationRetentionSchemaDb: {
    missingColumns: jest.fn().mockResolvedValue([])
  }
}));
jest.mock('db-migrate', () => {
  const up = jest.fn().mockResolvedValue(undefined);
  return { up, getInstance: jest.fn(() => ({ up })) };
});

const migrations = jest.requireMock('db-migrate') as {
  getInstance: jest.Mock;
  up: jest.Mock;
};
const logInfo = (jest.requireMock('@/logging') as { info: jest.Mock }).info;
const invoke = handler as (event: unknown) => Promise<unknown>;
const scheduledEvent = {
  source: 'aws.events',
  'detail-type': 'Scheduled Event'
};

describe('dbMigrationsLoop explicit schema scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(moderationRetentionSchemaDb.missingColumns)
      .mockResolvedValue([]);
  });

  it('synchronizes only the three wallet-transfer entities and skips all unrelated work', async () => {
    await expect(
      invoke({ schema_scope: 'wallet-transfer-analysis' })
    ).resolves.toEqual({
      schema_scope: 'wallet-transfer-analysis'
    });
    expect(doInDbContext).toHaveBeenCalledTimes(1);
    expect(doInDbContext).toHaveBeenCalledWith(expect.any(Function), {
      logger: expect.anything(),
      entities: [
        WalletTransferAnalysisStateEntity,
        WalletTransferPairDailyEntity,
        WalletTransferWalletDailyEntity
      ],
      syncEntities: true,
      skipRedis: true
    });
    expect(migrations.getInstance).not.toHaveBeenCalled();
    expect(competitionRepository.backfillLegacyMappings).not.toHaveBeenCalled();
    expect(
      contentModerationDb.deleteExpiredPrePublicationChecks
    ).not.toHaveBeenCalled();
    expect(moderationReviewDb.retain).not.toHaveBeenCalled();
    expect(moderationRetentionSchemaDb.missingColumns).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { schema_scope: 'full' }])(
    'preserves full manual migration behavior for %j',
    async (event) => {
      await expect(invoke(event)).resolves.toBeUndefined();
      expect(doInDbContext).toHaveBeenCalledWith(expect.any(Function), {
        logger: expect.anything(),
        entities: Object.values(Entities),
        syncEntities: true
      });
      expect(migrations.getInstance).toHaveBeenCalledWith(true, {
        config: './database.json',
        env: 'main'
      });
      expect(migrations.up).toHaveBeenCalledTimes(1);
      expect(
        competitionRepository.backfillLegacyMappings
      ).toHaveBeenCalledTimes(1);
      expect(
        contentModerationDb.deleteExpiredPrePublicationChecks
      ).toHaveBeenCalledTimes(1);
      expect(moderationReviewDb.retain).toHaveBeenCalledTimes(1);
      expect(moderationRetentionSchemaDb.missingColumns).toHaveBeenCalledTimes(
        1
      );
    }
  );

  it('preserves scheduled retention without migrations or schema synchronization', async () => {
    await invoke(scheduledEvent);
    expect(doInDbContext).toHaveBeenCalledWith(expect.any(Function), {
      logger: expect.anything(),
      entities: Object.values(Entities),
      syncEntities: false
    });
    expect(migrations.getInstance).not.toHaveBeenCalled();
    expect(competitionRepository.backfillLegacyMappings).toHaveBeenCalledTimes(
      1
    );
    expect(
      contentModerationDb.deleteExpiredPrePublicationChecks
    ).toHaveBeenCalledTimes(1);
    expect(moderationReviewDb.retain).toHaveBeenCalledTimes(1);
    expect(moderationRetentionSchemaDb.missingColumns).toHaveBeenCalledTimes(1);
  });

  it('keeps existing scheduled maintenance while explicitly skipping moderation retention pending its schema', async () => {
    jest
      .mocked(moderationRetentionSchemaDb.missingColumns)
      .mockResolvedValue([
        'content_moderation_items.id',
        'content_moderation_audit_log.item_id'
      ]);
    await expect(invoke(scheduledEvent)).resolves.toBeUndefined();
    expect(competitionRepository.backfillLegacyMappings).toHaveBeenCalledTimes(
      1
    );
    expect(
      contentModerationDb.deleteExpiredPrePublicationChecks
    ).toHaveBeenCalledTimes(1);
    expect(moderationReviewDb.retain).not.toHaveBeenCalled();
    expect(moderationRetentionSchemaDb.missingColumns).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(
      '[SKIPPED MODERATION REVIEW RETENTION: PENDING SCHEMA] content_moderation_items.id, content_moderation_audit_log.item_id'
    );
    expect(migrations.getInstance).not.toHaveBeenCalled();
  });

  it('surfaces schema inspection failures instead of treating them as pending schema', async () => {
    const failure = new Error('Synthetic metadata permission failure');
    jest
      .mocked(moderationRetentionSchemaDb.missingColumns)
      .mockRejectedValueOnce(failure);
    await expect(invoke(scheduledEvent)).rejects.toBe(failure);
    expect(moderationReviewDb.retain).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('PENDING SCHEMA')
    );
  });

  it.each(['', 'unknown', null, undefined, {}, 42])(
    'rejects unknown explicit scope %j before opening a database context',
    async (scope) => {
      await expect(invoke({ schema_scope: scope })).rejects.toThrow(
        'Unsupported database schema scope'
      );
      expect(doInDbContext).not.toHaveBeenCalled();
    }
  );

  it.each(['full', 'wallet-transfer-analysis'])(
    'rejects explicit %s scope on scheduled events',
    async (scope) => {
      await expect(
        invoke({ ...scheduledEvent, schema_scope: scope })
      ).rejects.toThrow('Unsupported database schema scope');
      expect(doInDbContext).not.toHaveBeenCalled();
    }
  );

  it('propagates scoped schema synchronization failure without starting maintenance', async () => {
    const failure = new Error('Synthetic schema failure');
    jest.mocked(doInDbContext).mockRejectedValueOnce(failure);
    await expect(
      invoke({ schema_scope: 'wallet-transfer-analysis' })
    ).rejects.toBe(failure);
    expect(migrations.getInstance).not.toHaveBeenCalled();
    expect(competitionRepository.backfillLegacyMappings).not.toHaveBeenCalled();
  });
});
