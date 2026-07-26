import { Logger } from '@/logging';
import type { ConnectionWrapper } from '@/sql-executor';

const logger = Logger.get('SUBSCRIPTION_COVERAGE_DIRTY');

function uniqueKeyCount(consolidationKeys: readonly string[]): number {
  return new Set(
    consolidationKeys
      .map((key) => key.trim().toLowerCase())
      .filter((key) => key.length > 0)
  ).size;
}

async function getRepository() {
  const { subscriptionCoverageRepository } =
    await import('./subscription-coverage.repository');
  return subscriptionCoverageRepository;
}

export async function markSubscriptionCoverageDirty(
  consolidationKeys: readonly string[],
  reason: string,
  connection?: ConnectionWrapper<unknown>
): Promise<void> {
  try {
    const repository = await getRepository();
    await repository.markDirty(consolidationKeys, reason, { connection });
  } catch (error) {
    logger.error('Failed to persist subscription coverage dirty markers', {
      reason,
      key_count: uniqueKeyCount(consolidationKeys),
      error
    });
  }
}

export async function markSubscriptionCoverageDirtyForDemonstratedIntent(
  consolidationKeys: readonly string[],
  reason: string,
  connection?: ConnectionWrapper<unknown>
): Promise<void> {
  try {
    const repository = await getRepository();
    const ctx = { connection };
    const intentKeys = await repository.findDemonstratedIntentKeys(
      consolidationKeys,
      ctx
    );
    await repository.markDirty(intentKeys, reason, ctx);
  } catch (error) {
    logger.error(
      'Failed to persist filtered subscription coverage dirty markers',
      {
        reason,
        candidate_key_count: uniqueKeyCount(consolidationKeys),
        error
      }
    );
  }
}
