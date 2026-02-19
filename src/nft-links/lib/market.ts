import type { Platform } from '../types';

export type SaleType =
  | 'FIXED'
  | 'AUCTION'
  | 'CLAIM'
  | 'NOT_FOR_SALE'
  | 'UNKNOWN';

export function defaultCtaLabel(
  platform: Platform,
  saleType: SaleType | undefined
): string {
  switch (saleType) {
    case 'FIXED':
      return platform === 'OPENSEA' ? 'Buy' : 'Buy now';
    case 'AUCTION':
      return 'Place bid';
    case 'CLAIM':
      return 'Claim';
    case 'NOT_FOR_SALE':
      return 'View';
    default:
      return `View on ${platformName(platform)}`;
  }
}

export function platformName(platform: Platform): string {
  switch (platform) {
    case 'SUPERRARE':
      return 'SuperRare';
    case 'OPENSEA':
      return 'OpenSea';
    case 'FOUNDATION':
      return 'Foundation';
    case 'MANIFOLD':
      return 'Manifold';
    case 'TRANSIENT':
      return 'Transient';
  }
}

export function buildPrimaryAction(
  platform: Platform,
  saleType: SaleType | undefined,
  viewUrl: string
): { label: string; url: string } {
  return { label: defaultCtaLabel(platform, saleType), url: viewUrl };
}
