import type { CanonicalLink } from '@/nft-links/types';
import type { NftLinkEntity } from '@/entities/INftLink';

/** Opted in only by the SQS refresher; synchronous API callers retain their policy. */
export interface NftRefreshObserver {
  completed(
    canonical: CanonicalLink,
    entity: NftLinkEntity,
    result: { success: true } | { success: false; error: unknown }
  ): void;
  isExpectedFailure(error: unknown, canonical: CanonicalLink): boolean;
}
