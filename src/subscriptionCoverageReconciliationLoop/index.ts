import type { Handler } from 'aws-lambda';
import * as sentryContext from '../sentry.context';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';
import { SubscriptionCoverageAlertStateEntity } from '../entities/ISubscriptionCoverageAlertState';
import { SubscriptionCoverageRefreshRequestEntity } from '../entities/ISubscriptionCoverageRefreshRequest';
import { Logger } from '../logging';
import { identityNotificationsDb } from '../notifications/identity-notifications.db';
import { doInDbContext } from '../secrets';
import { dbSupplier } from '../sql-executor';
import {
  SubscriptionCoverageReconciliationService,
  SubscriptionCoverageReconciliationMode,
  SubscriptionCoverageReconciliationOptions,
  SubscriptionCoverageReconciliationResult
} from '../subscription-coverage/subscription-coverage-reconciliation.service';
import { SubscriptionCoverageRepository } from '../subscription-coverage/subscription-coverage.repository';
import { Timer } from '../time';

const logger = Logger.get('SUBSCRIPTION_COVERAGE_RECONCILIATION_LOOP');
const subscriptionCoverageReconciliationService =
  new SubscriptionCoverageReconciliationService(
    new SubscriptionCoverageRepository(dbSupplier, identityNotificationsDb)
  );
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_DIRTY_MAX_BATCHES = 10;
const DEFAULT_FULL_MAX_BATCHES = 100;

interface ReconciliationEvent {
  readonly mode?: SubscriptionCoverageReconciliationMode;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly startAfterConsolidationKey?: string;
}

function parsePositiveInteger(
  value: unknown,
  name: string,
  fallback: number
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(typeof value === 'string' ? value : '', 10);
  if (value !== undefined && (!Number.isInteger(parsed) || parsed <= 0)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMode(value: unknown): SubscriptionCoverageReconciliationMode {
  return typeof value === 'string' && value.toUpperCase() === 'FULL'
    ? 'FULL'
    : 'DIRTY';
}

function flagEnabled(name: string): boolean {
  return process.env[name] === 'true';
}

export function resolveSubscriptionCoverageReconciliationOptions(): SubscriptionCoverageReconciliationOptions {
  return {
    dryRun: flagEnabled('SUBSCRIPTION_COVERAGE_DRY_RUN'),
    notificationsEnabled:
      process.env.FEATURE_SUBSCRIPTION_COVERAGE_NOTIFICATIONS !== 'false',
    baselineOnly: flagEnabled('SUBSCRIPTION_COVERAGE_BASELINE_ONLY'),
    notifyInitialCritical: flagEnabled(
      'SUBSCRIPTION_COVERAGE_NOTIFY_INITIAL_CRITICAL'
    ),
    pushEnabled: process.env.SUBSCRIPTION_COVERAGE_PUSH_ENABLED !== 'false'
  };
}

function addResult(
  aggregate: SubscriptionCoverageReconciliationResult,
  page: SubscriptionCoverageReconciliationResult
): SubscriptionCoverageReconciliationResult {
  const statusCounts = { ...aggregate.statusCounts };
  for (const [status, count] of Object.entries(page.statusCounts)) {
    statusCounts[status] = (statusCounts[status] ?? 0) + count;
  }
  return {
    mode: aggregate.mode,
    scanned: aggregate.scanned + page.scanned,
    succeeded: aggregate.succeeded + page.succeeded,
    failed: aggregate.failed + page.failed,
    baselined: aggregate.baselined + page.baselined,
    notificationsCreated:
      aggregate.notificationsCreated + page.notificationsCreated,
    pushesQueued: aggregate.pushesQueued + page.pushesQueued,
    wouldNotify: aggregate.wouldNotify + page.wouldNotify,
    deduplicatedOrSuppressed:
      aggregate.deduplicatedOrSuppressed + page.deduplicatedOrSuppressed,
    unroutable: aggregate.unroutable + page.unroutable,
    statusCounts,
    hasMore: page.hasMore,
    lastConsolidationKey: page.lastConsolidationKey
  };
}

function emptyResult(
  mode: SubscriptionCoverageReconciliationMode
): SubscriptionCoverageReconciliationResult {
  return {
    mode,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    baselined: 0,
    notificationsCreated: 0,
    pushesQueued: 0,
    wouldNotify: 0,
    deduplicatedOrSuppressed: 0,
    unroutable: 0,
    statusCounts: {},
    hasMore: false,
    lastConsolidationKey: null
  };
}

export function shouldStopSubscriptionCoverageReconciliation(
  page: SubscriptionCoverageReconciliationResult,
  options: SubscriptionCoverageReconciliationOptions
): boolean {
  const dirtyPageMadeNoProgress =
    page.mode === 'DIRTY' &&
    page.succeeded === 0 &&
    page.failed === page.scanned;
  return (
    !page.hasMore ||
    page.scanned === 0 ||
    dirtyPageMadeNoProgress ||
    (page.mode === 'DIRTY' && options.dryRun)
  );
}

async function reconcile(
  event: ReconciliationEvent
): Promise<SubscriptionCoverageReconciliationResult> {
  const mode = parseMode(event.mode);
  const batchSize = parsePositiveInteger(
    event.batchSize ??
      process.env.SUBSCRIPTION_COVERAGE_RECONCILIATION_BATCH_SIZE,
    'batchSize',
    DEFAULT_BATCH_SIZE
  );
  const defaultMaxBatches =
    mode === 'FULL' ? DEFAULT_FULL_MAX_BATCHES : DEFAULT_DIRTY_MAX_BATCHES;
  const maxBatches = parsePositiveInteger(
    event.maxBatches ??
      process.env.SUBSCRIPTION_COVERAGE_RECONCILIATION_MAX_BATCHES,
    'maxBatches',
    defaultMaxBatches
  );
  const options = resolveSubscriptionCoverageReconciliationOptions();
  let result = emptyResult(mode);
  let startAfter = event.startAfterConsolidationKey?.trim().toLowerCase();
  for (let batch = 0; batch < maxBatches; batch++) {
    const page =
      mode === 'FULL'
        ? await subscriptionCoverageReconciliationService.reconcileFullPage(
            startAfter,
            batchSize,
            options
          )
        : await subscriptionCoverageReconciliationService.reconcileDirty(
            batchSize,
            options
          );
    result = addResult(result, page);
    startAfter = page.lastConsolidationKey ?? undefined;
    if (shouldStopSubscriptionCoverageReconciliation(page, options)) {
      break;
    }
  }
  return result;
}

const reconciliationHandler: Handler = async (event) => {
  await doInDbContext(
    async () => {
      const timer = new Timer('SUBSCRIPTION_COVERAGE_RECONCILIATION_LOOP');
      try {
        const result = await reconcile(
          event && typeof event === 'object'
            ? (event as ReconciliationEvent)
            : {}
        );
        logger.info('Subscription coverage reconciliation completed', {
          mode: result.mode,
          scanned: result.scanned,
          succeeded: result.succeeded,
          failed: result.failed,
          baselined: result.baselined,
          notifications_created: result.notificationsCreated,
          pushes_queued: result.pushesQueued,
          would_notify: result.wouldNotify,
          deduplicated_or_suppressed: result.deduplicatedOrSuppressed,
          unroutable: result.unroutable,
          status_counts: result.statusCounts,
          has_more: result.hasMore,
          elapsed_ms: timer.getTotalTimePassed().toMillis(),
          dry_run: process.env.SUBSCRIPTION_COVERAGE_DRY_RUN === 'true',
          baseline_only:
            process.env.SUBSCRIPTION_COVERAGE_BASELINE_ONLY === 'true'
        });
      } finally {
        logger.info(`Finished executing ${timer.getReport()}`);
      }
    },
    {
      logger,
      entities: [
        IdentityNotificationEntity,
        SubscriptionCoverageAlertStateEntity,
        SubscriptionCoverageRefreshRequestEntity
      ]
    }
  );
};

export const handler = sentryContext.wrapLambdaHandler(reconciliationHandler);
