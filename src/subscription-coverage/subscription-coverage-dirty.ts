import {
  SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE,
  SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import {
  subscriptionKeyWidths,
  SubscriptionKeyWidthsUnknownError
} from '@/subscription-key-width/subscription-key-width';

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

const COVERAGE_KEY_TABLES = [
  SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE,
  SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE
];

/**
 * Drops keys the coverage tables can't hold yet (see subscription-key-width),
 * or can't be judged yet (the widths were never read in this process), so
 * one long key never fails a batch. Markers are best effort and run after
 * the caller's write has committed; coverage is recomputed from the
 * subscription tables, so nothing is queued.
 */
async function keysThatFit(
  keys: readonly string[],
  reason: string
): Promise<string[]> {
  const fitting: string[] = [];
  for (const key of keys) {
    let fits: boolean;
    try {
      fits = await subscriptionKeyWidths.fits(key, COVERAGE_KEY_TABLES);
    } catch (error) {
      if (!(error instanceof SubscriptionKeyWidthsUnknownError)) {
        throw error;
      }
      fits = false;
    }
    if (fits) {
      fitting.push(key);
    } else {
      logger.warn(
        `[COVERAGE MARKER SKIPPED] [${reason}] key of ${key.length} characters does not fit the coverage tables yet`
      );
    }
  }
  return fitting;
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
  const normalizedKeys = await keysThatFit(
    normalizeUniqueKeys(consolidationKeys),
    reason
  );
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
  const normalizedKeys = await keysThatFit(
    normalizeUniqueKeys(consolidationKeys),
    reason
  );
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
