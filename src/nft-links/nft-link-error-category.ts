import { FetchError } from 'node-fetch';
import {
  PublicFetchTimeoutError,
  PublicNetworkPolicyError,
  PublicResponseTooLargeError
} from '@/http/public-fetch';
import { HttpError, NftLinkHttpTimeoutError } from '@/nft-links/lib/http';
import { RequiredNftPageNotFoundError } from '@/nft-links/nft-link-page-retry';
import { NftLinkResolverValidationError } from '@/nft-links/nft-link-resolver-validation.error';
import { NftLinkResolutionDeadlineError } from '@/nft-links/resolution-budget';

/**
 * Stored and returned in `last_error_message` instead of upstream error text.
 * Detailed errors stay in logs.
 */
export const NFT_LINK_ERROR_CATEGORIES = [
  'TIMEOUT',
  'FETCH_FAILED',
  'INVALID_METADATA',
  'UNSUPPORTED',
  'RESOLUTION_FAILED'
] as const;

export type NftLinkErrorCategory = (typeof NFT_LINK_ERROR_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(NFT_LINK_ERROR_CATEGORIES);

function isTimeout(error: unknown): boolean {
  if (
    error instanceof NftLinkHttpTimeoutError ||
    error instanceof NftLinkResolutionDeadlineError ||
    error instanceof PublicFetchTimeoutError
  ) {
    return true;
  }
  const record = error as { name?: unknown; code?: unknown } | null;
  return (
    record?.name === 'AbortError' ||
    record?.name === 'TimeoutError' ||
    record?.code === 'TIMEOUT' ||
    record?.code === 'ETIMEDOUT'
  );
}

function isFetchFailure(error: unknown): boolean {
  return (
    error instanceof HttpError ||
    error instanceof RequiredNftPageNotFoundError ||
    error instanceof FetchError ||
    error instanceof PublicNetworkPolicyError ||
    error instanceof PublicResponseTooLargeError
  );
}

export function categorizeNftLinkError(error: unknown): NftLinkErrorCategory {
  if (isTimeout(error)) return 'TIMEOUT';
  if (error instanceof NftLinkResolverValidationError) return 'UNSUPPORTED';
  if (error instanceof SyntaxError) return 'INVALID_METADATA';
  if (isFetchFailure(error)) return 'FETCH_FAILED';
  return 'RESOLUTION_FAILED';
}

/** Rows written before categories were stored still hold free text. */
export function toPublicNftLinkErrorMessage(
  stored: string | null | undefined
): string | null {
  if (stored === null || stored === undefined) return null;
  return CATEGORY_SET.has(stored) ? stored : 'RESOLUTION_FAILED';
}
