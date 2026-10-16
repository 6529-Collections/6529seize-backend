import { createHash } from 'node:crypto';
import { FetchError } from 'node-fetch';
import { Logger } from '@/logging';
import { loggerContext } from '@/logger-context';
import type { NftRefreshObserver } from '@/nft-links/nft-refresh-observer';
import type { CanonicalLink } from '@/nft-links/types';
import {
  nftPageRetryScope,
  RequiredNftPageNotFoundError
} from '@/nft-links/nft-link-page-retry';
import { HttpError, NftLinkHttpTimeoutError } from '@/nft-links/lib/http';
import { NftLinkResolutionDeadlineError } from '@/nft-links/resolution-budget';

const logger = Logger.get('NFT_REFRESH_OUTCOME');
const counters = [
  'Completed',
  'Success',
  'Failure',
  'Unavailable',
  'NewUnavailable',
  'PreviouslyWorkingUnavailable'
] as const;

function missingPage(error: unknown, canonical: CanonicalLink): boolean {
  return (
    ['TRANSIENT', 'MANIFOLD'].includes(canonical.platform) &&
    error instanceof RequiredNftPageNotFoundError &&
    error.scopeHash === nftPageRetryScope(canonical)
  );
}

export function expectedFetchFailure(error: unknown): boolean {
  if (
    error instanceof NftLinkHttpTimeoutError ||
    error instanceof NftLinkResolutionDeadlineError
  )
    return true;
  if (error instanceof HttpError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return (
    error instanceof FetchError &&
    [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED'
    ].includes(error.code ?? '')
  );
}

function category(error: unknown): string {
  if (
    error instanceof NftLinkHttpTimeoutError ||
    error instanceof NftLinkResolutionDeadlineError
  )
    return 'TIMEOUT';
  if (error instanceof FetchError) return 'NETWORK';
  if (
    error instanceof HttpError ||
    error instanceof RequiredNftPageNotFoundError
  )
    return 'HTTP_ERROR';
  return 'UNKNOWN';
}

let reportedInvalidEnvironment = false;
function refreshEnvironment(): 'prod' | 'staging' | undefined {
  const value = process.env.OPS_ENVIRONMENT;
  return value === 'prod' || value === 'staging' ? value : undefined;
}

export const nftRefreshObserver: NftRefreshObserver = {
  isExpectedFailure: (error, canonical) =>
    refreshEnvironment() !== undefined &&
    (missingPage(error, canonical) || expectedFetchFailure(error)),
  completed(canonical, entity, result) {
    const environment = refreshEnvironment();
    if (!environment) {
      if (!reportedInvalidEnvironment) {
        reportedInvalidEnvironment = true;
        logger.error('NFT refresh outcome environment is missing or invalid');
      }
      return;
    }
    const error = result.success ? undefined : result.error;
    const unavailable = missingPage(error, canonical);
    const success = result.success;
    const firstUnavailable = unavailable && entity.failed_since == null;
    let outcome = 'unexpected_failure';
    if (success) outcome = 'success';
    else if (unavailable) outcome = 'unavailable';
    else if (expectedFetchFailure(error)) outcome = 'transient_failure';
    const values = {
      Completed: 1,
      Success: Number(success),
      Failure: Number(!success && !unavailable),
      Unavailable: Number(unavailable),
      NewUnavailable: Number(firstUnavailable),
      PreviouslyWorkingUnavailable: Number(
        firstUnavailable && entity.last_successfully_updated != null
      )
    };
    try {
      process.stdout.write(
        JSON.stringify({
          _type: '6529.nft.refresh.v1',
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              {
                Namespace: '6529/NftLinkRefresher',
                Dimensions: [['Environment', 'Provider']],
                Metrics: counters.map((Name) => ({ Name, Unit: 'Count' }))
              }
            ]
          },
          Environment: environment,
          Provider: canonical.platform,
          linkHash: createHash('sha256')
            .update(canonical.canonicalId)
            .digest('hex'),
          correlationId: loggerContext.get()?.requestId,
          outcome,
          category: success ? undefined : category(error),
          ...values
        }) + '\n'
      );
    } catch {
      // Telemetry must not change persistence, acknowledgements or retry timing.
      logger.error('NFT refresh outcome telemetry could not be emitted');
    }
  }
};
