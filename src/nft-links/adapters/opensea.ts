import type { AdapterResult, PlatformAdapter } from './types';
import { fetchJsonWithTimeout } from '../lib/http';
import { buildPrimaryAction } from '../lib/market';
import { formatTokenAmount } from '@/nft-links/lib/onchain';
import { CanonicalLink } from '@/nft-links/types';
import { env } from '@/env';

const DEFAULT_API_BASE = 'https://api.opensea.io';

const ETH_DEFAULT_DECIMALS = 18;

function toOpenSeaApiChain(chain: string): string {
  const k = (chain ?? '').toLowerCase();
  if (k === 'eth' || k === 'ethereum' || k === 'mainnet') return 'ethereum';
  if (k === 'polygon' || k === 'matic') return 'matic';
  if (k === 'arbitrum' || k === 'arbitrumone') return 'arbitrum';
  if (k === 'optimism' || k === 'op') return 'optimism';
  return k;
}

type AnyObj = Record<string, any>;
type ParsedListingPrice = {
  amount: string;
  currency: string;
  rawAmount?: bigint;
  decimals?: number;
};
type ParsedListingPriceWithRawAmount = ParsedListingPrice & {
  rawAmount: bigint;
};

function getApiKeyHeader(): Record<string, string> {
  const key = env.getStringOrNull('OPENSEA_API_KEY');
  if (!key) return {};
  return { 'x-api-key': key };
}

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function parseMetadata(meta: AnyObj): {
  title?: string;
  description?: string;
  imageUrl?: string;
  animationUrl?: string;
  creatorName?: string;
  collectionName?: string;
  collectionSlug?: string;
} {
  const nft = meta.nft ?? meta;

  const title = pick<string>(nft.name, meta.name);
  const description = pick<string>(nft.description, meta.description);

  const imageUrl = pick<string>(
    nft.image_url,
    nft.imageUrl,
    nft.display_image_url,
    nft.image,
    meta.image_url,
    meta.image
  );

  const animationUrl = pick<string>(
    nft.animation_url,
    nft.animationUrl,
    meta.animation_url,
    meta.animation
  );

  const creatorName = pick<string>(
    nft.creator?.username,
    nft.creator?.name,
    nft.creator?.address,
    meta.creator?.username
  );

  const collection = nft.collection ?? meta.collection;
  const collectionName =
    collection && typeof collection === 'object'
      ? pick<string>(collection.name, meta.collection?.name)
      : undefined;
  const collectionSlug = pick<string>(
    typeof collection === 'string' ? collection : undefined,
    collection?.slug,
    nft.collection_slug,
    meta.collection_slug
  );

  return {
    title,
    description,
    imageUrl,
    animationUrl,
    creatorName,
    collectionName,
    collectionSlug
  };
}

function parseCollectionSlug(res: AnyObj): string | undefined {
  // Docs: /collection may return { collection: "slug" } or { collection: { slug } }
  const c = res.collection;
  if (typeof c === 'string') return c;
  if (c && typeof c.slug === 'string') return c.slug;
  return undefined;
}

function parseIntegerLike(value: any): bigint | undefined {
  if (value == null) return undefined;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) return undefined;
    return BigInt(value);
  }
  const asString = String(value).trim();
  const match = /^(\d+)(?:\.0+)?$/.exec(asString);
  if (!match) return undefined;
  return BigInt(match[1]);
}

function parseDecimals(value: any): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    return undefined;
  }
  return parsed;
}

function getListingQuantity(listing: AnyObj): bigint | undefined {
  const quantity = parseIntegerLike(
    pick<any>(
      listing?.remaining_quantity,
      listing?.quantity,
      listing?.protocol_data?.parameters?.offer?.[0]?.startAmount
    )
  );
  if (!quantity || quantity <= BigInt(1)) {
    return undefined;
  }
  return quantity;
}

function normalizeAggregateRawAmount(
  rawAmount: bigint | undefined,
  listing: AnyObj
): bigint | undefined {
  if (rawAmount == null) {
    return undefined;
  }
  const quantity = getListingQuantity(listing);
  if (quantity && quantity > BigInt(1)) {
    return rawAmount / quantity;
  }
  return rawAmount;
}

function formatRawTokenAmount(amount: bigint, decimals: number): string {
  return formatTokenAmount(amount, decimals);
}

function parseBestListing(res: AnyObj): ParsedListingPrice | undefined {
  // The shape changes over time; be permissive.
  const listing = res.listing ?? res.best_listing ?? res;
  const structuredPrice = listing?.price?.current ?? listing?.price;

  const structuredAmount = pick<any>(
    structuredPrice?.value,
    structuredPrice?.amount
  );
  const structuredCurrency = pick<any>(
    structuredPrice?.currency,
    structuredPrice?.currency_symbol
  );
  if (structuredAmount != null && structuredCurrency != null) {
    const rawAmount = parseIntegerLike(structuredAmount);
    const normalizedRawAmount = normalizeAggregateRawAmount(rawAmount, listing);
    return {
      amount:
        normalizedRawAmount == null
          ? String(structuredAmount)
          : normalizedRawAmount.toString(),
      currency: String(structuredCurrency),
      rawAmount: normalizedRawAmount,
      decimals: parseDecimals(structuredPrice?.decimals)
    };
  }

  const legacyPrice =
    listing?.current_price ??
    listing?.protocol_data?.parameters?.consideration?.[0];

  // Common patterns
  const amount = pick<any>(
    legacyPrice?.amount,
    legacyPrice?.value,
    listing?.current_price
  );
  const currency = pick<any>(
    legacyPrice?.currency,
    legacyPrice?.currency_symbol,
    listing?.payment_token?.symbol,
    listing?.protocol_data?.payment_token?.symbol,
    listing?.taker_asset_bundle?.assets?.[0]?.asset_contract?.symbol
  );

  if (amount == null || currency == null) return undefined;
  const rawAmount = parseIntegerLike(amount);
  const normalizedRawAmount = normalizeAggregateRawAmount(rawAmount, listing);
  return {
    amount:
      normalizedRawAmount == null
        ? String(amount)
        : normalizedRawAmount.toString(),
    currency: String(currency),
    rawAmount: normalizedRawAmount,
    decimals:
      String(currency).toUpperCase() === 'ETH'
        ? ETH_DEFAULT_DECIMALS
        : undefined
  };
}

function toMarketPrice(
  parsed: ParsedListingPrice
): { amount: string; currency: string } | undefined {
  if (!parsed.amount || !parsed.currency) {
    return undefined;
  }
  const currency = parsed.currency;
  if (parsed.rawAmount != null && parsed.decimals != null) {
    return {
      amount: formatRawTokenAmount(parsed.rawAmount, parsed.decimals),
      currency
    };
  }
  if (currency.toUpperCase() === 'ETH' && parsed.rawAmount != null) {
    return {
      amount: formatRawTokenAmount(parsed.rawAmount, ETH_DEFAULT_DECIMALS),
      currency
    };
  }
  return {
    amount: parsed.amount,
    currency
  };
}

function hasEthRawAmount(
  listing: ParsedListingPrice
): listing is ParsedListingPriceWithRawAmount {
  return listing.currency.toUpperCase() === 'ETH' && listing.rawAmount != null;
}

function selectBestListingPrice(
  listings: AnyObj[]
): ParsedListingPrice | undefined {
  const parsedListings = listings
    .map((listing) => parseBestListing(listing))
    .filter((it): it is ParsedListingPrice => !!it?.amount && !!it?.currency);
  const ethListingsWithRawAmount = parsedListings.filter(hasEthRawAmount);
  if (ethListingsWithRawAmount.length) {
    const [first, ...rest] = ethListingsWithRawAmount;
    return rest.reduce(
      (best, current) => (current.rawAmount < best.rawAmount ? current : best),
      first
    );
  }
  return parsedListings[0];
}

export class OpenSeaAdapter implements PlatformAdapter {
  canHandle(canonical: CanonicalLink): boolean {
    return (
      canonical.platform === 'OPENSEA' && canonical.identifiers.kind === 'TOKEN'
    );
  }

  async resolveFast(canonical: CanonicalLink): Promise<AdapterResult | null> {
    if (!env.getStringOrNull('OPENSEA_API_KEY')) return null; // no-key => no calls
    if (canonical.identifiers.kind !== 'TOKEN') return null;

    const apiBase = env.getStringOrNull('OPENSEA_API_BASE') ?? DEFAULT_API_BASE;
    const timeoutMs = env.getIntOrNull('OPENSEA_TIMEOUT_MS') ?? 1200;
    const headers = getApiKeyHeader();

    const chain = canonical.identifiers.chain;
    const apiChain = toOpenSeaApiChain(chain);
    const contract = canonical.identifiers.contract;
    const tokenId = canonical.identifiers.tokenId;

    // OpenSea API v2: NFT endpoint
    const metaUrl = `${apiBase}/api/v2/chain/${encodeURIComponent(apiChain)}/contract/${encodeURIComponent(contract)}/nfts/${encodeURIComponent(tokenId)}`;

    const meta = await fetchJsonWithTimeout<AnyObj>(metaUrl, {
      timeoutMs,
      headers
    });

    const m = parseMetadata(meta);

    // Listings: prefer the NFT-specific best-listing endpoint. The legacy
    // orders endpoint reports ERC1155 aggregate prices, so keep it as fallback.
    let price: { amount: string; currency: string } | undefined;
    let saleType: 'FIXED' | 'UNKNOWN' = 'UNKNOWN';

    let collectionSlug = m.collectionSlug;
    if (!collectionSlug) {
      try {
        const collectionUrl = `${apiBase}/api/v2/chain/${encodeURIComponent(apiChain)}/contract/${encodeURIComponent(contract)}/nfts/${encodeURIComponent(tokenId)}/collection`;
        const col = await fetchJsonWithTimeout<AnyObj>(collectionUrl, {
          timeoutMs,
          headers
        });
        collectionSlug = parseCollectionSlug(col);
      } catch {
        // ignore
      }
    }

    if (collectionSlug) {
      const bestUrl = `${apiBase}/api/v2/listings/collection/${encodeURIComponent(collectionSlug)}/nfts/${encodeURIComponent(tokenId)}/best`;
      try {
        const best = await fetchJsonWithTimeout<AnyObj>(bestUrl, {
          timeoutMs,
          headers
        });
        const parsed = parseBestListing(best);
        const marketPrice = parsed ? toMarketPrice(parsed) : undefined;
        if (marketPrice) {
          price = marketPrice;
          saleType = 'FIXED';
        }
      } catch {
        // ignore
      }
    }

    if (!price) {
      const ordersUrl = new URL(
        `${apiBase}/api/v2/orders/${encodeURIComponent(apiChain)}/seaport/listings`
      );
      ordersUrl.searchParams.set('asset_contract_address', contract);
      ordersUrl.searchParams.set('token_ids', tokenId);
      ordersUrl.searchParams.set('limit', '200');
      // Prefer lowest price when server supports ordering
      ordersUrl.searchParams.set('order_by', 'eth_price');
      ordersUrl.searchParams.set('order_direction', 'asc');

      try {
        const orders = await fetchJsonWithTimeout<AnyObj>(
          ordersUrl.toString(),
          {
            timeoutMs,
            headers
          }
        );
        const parsed = selectBestListingPrice(orders?.orders ?? []);
        const marketPrice = parsed ? toMarketPrice(parsed) : undefined;
        if (marketPrice) {
          price = marketPrice;
          saleType = 'FIXED';
        }
      } catch {
        // ignore
      }
    }

    const media = m.animationUrl
      ? {
          kind: 'animation' as const,
          animationUrl: m.animationUrl,
          imageUrl: m.imageUrl
        }
      : m.imageUrl
        ? { kind: 'image' as const, imageUrl: m.imageUrl }
        : undefined;

    const patch: any = {
      chain,
      asset: {
        title: m.title,
        description: m.description,
        creator: m.creatorName ? { name: m.creatorName } : undefined,
        collection: m.collectionName ? { name: m.collectionName } : undefined,
        contract,
        tokenId,
        media
      },
      market: {
        saleType,
        price,
        cta: buildPrimaryAction(canonical.platform, saleType, canonical.viewUrl)
      },
      links: {
        viewUrl: canonical.viewUrl,
        buyOrBidUrl: canonical.viewUrl
      }
    };

    return { patch };
  }
}
