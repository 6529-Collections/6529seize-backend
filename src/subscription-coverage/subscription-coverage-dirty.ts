import { Logger } from '@/logging';

const logger = Logger.get('SUBSCRIPTION_COVERAGE_DIRTY');
const DIRTY_MARKER_BATCH_SIZE = 500;

function normalizeUniqueKeys(
  consolidationKeys: readonly string[]
): readonly string[] {
  return Array.from(
    new Set(
      consolidationKeys
        .map((key) => key.trim().toLowerCase())
        .filter((key) => key.length > 0)
    )
  );
}

async function getRepository() {
  const { subscriptionCoverageRepository } =
    await import('./subscription-coverage.repository');
  return subscriptionCoverageRepository;
}

export async function markSubscriptionCoverageDirty(
  consolidationKeys: readonly string[],
  reason: string
): Promise<void> {
  const normalizedKeys = normalizeUniqueKeys(consolidationKeys);
  if (normalizedKeys.length === 0) {
    return;
  }

  let repository: Awaited<ReturnType<typeof getRepository>>;
  try {
    repository = await getRepository();
  } catch (error) {
    logger.error('Failed to persist subscription coverage dirty markers', {
      reason,
      key_count: normalizedKeys.length,
      error
    });
    return;
  }

  for (
    let batchStart = 0;
    batchStart < normalizedKeys.length;
    batchStart += DIRTY_MARKER_BATCH_SIZE
  ) {
    const batch = normalizedKeys.slice(
      batchStart,
      batchStart + DIRTY_MARKER_BATCH_SIZE
    );
    try {
      await repository.markDirty(batch, reason);
    } catch (error) {
      logger.error('Failed to persist subscription coverage dirty markers', {
        reason,
        key_count: batch.length,
        batch_start: batchStart,
        error
      });
    }
  }
}

export async function markSubscriptionCoverageDirtyForDemonstratedIntent(
  consolidationKeys: readonly string[],
  reason: string
): Promise<void> {
  const normalizedKeys = normalizeUniqueKeys(consolidationKeys);
  if (normalizedKeys.length === 0) {
    return;
  }

  let repository: Awaited<ReturnType<typeof getRepository>>;
  try {
    repository = await getRepository();
  } catch (error) {
    logger.error(
      'Failed to persist filtered subscription coverage dirty markers',
      {
        reason,
        candidate_key_count: normalizedKeys.length,
        error
      }
    );
    return;
  }

  for (
    let batchStart = 0;
    batchStart < normalizedKeys.length;
    batchStart += DIRTY_MARKER_BATCH_SIZE
  ) {
    const batch = normalizedKeys.slice(
      batchStart,
      batchStart + DIRTY_MARKER_BATCH_SIZE
    );
    try {
      const intentKeys = await repository.findDemonstratedIntentKeys(batch);
      await repository.markDirty(intentKeys, reason);
    } catch (error) {
      logger.error(
        'Failed to persist filtered subscription coverage dirty markers',
        {
          reason,
          candidate_key_count: batch.length,
          batch_start: batchStart,
          error
        }
      );
    }
  }
}
