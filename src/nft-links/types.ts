/**
 * Link Resolution types.
 *
 * Designed to be stable and FE-friendly.
 */

export const Platforms = [
  'SUPERRARE',
  'OPENSEA',
  'FOUNDATION',
  'MANIFOLD',
  'TRANSIENT'
] as const;
export type Platform = (typeof Platforms)[number];

export type CanonicalIdentifiers =
  | {
      kind: 'TOKEN';
      chain: string;
      contract: string; // normalized to 0x + lowercase
      tokenId: string; // string digits
    }
  | {
      /**
       * Some marketplaces (notably Foundation) may have contract-level "mint" URLs.
       *
       * In phase 1 we keep this explicit so downstream code can decide whether to:
       * - treat it as collection-level
       * - attempt discovery of a single token
       */
      kind: 'CONTRACT_ONLY';
      chain: string;
      contract: string;
    }
  | {
      kind: 'MANIFOLD_CLAIM';
      instanceId?: string;
      instanceSlug?: string;
      appId?: string;
    }
  | {
      kind: 'URL_ONLY';
    };

export interface CanonicalLink {
  platform: Platform;
  viewUrl: string;
  canonicalId: string;
  identifiers: CanonicalIdentifiers;
  originalUrl: string;
}

export interface NormalizedNftCard {
  identifier: CanonicalLink;

  asset: {
    title?: string;
    description?: string;

    creator?: {
      name?: string;
      address?: string;
      profileUrl?: string;
    };

    collection?: {
      name?: string;
      url?: string;
    };

    contract?: string;
    tokenId?: string;

    media?: {
      kind: 'image' | 'video' | 'animation' | 'html' | 'unknown';
      imageUrl?: string;
      animationUrl?: string;
      mimeType?: string;
      width?: number;
      height?: number;
    };
  };

  market: {
    saleType?: 'FIXED' | 'AUCTION' | 'CLAIM' | 'NOT_FOR_SALE' | 'UNKNOWN';
    availability?: 'LISTED' | 'NOT_LISTED' | 'SOLD';
    price?: {
      amount: string;
      currency: string;
    };
    endsAt?: string;
    cta?: {
      label: string;
      url: string;
    };
  };

  links: {
    viewUrl: string;
    buyOrBidUrl?: string;
    explorerUrl?: string;
  };
}
