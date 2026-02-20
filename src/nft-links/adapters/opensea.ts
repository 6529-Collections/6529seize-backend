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

  const collectionName = pick<string>(
    nft.collection?.name,
    meta.collection?.name
  );
  const collectionSlug = pick<string>(
    nft.collection?.slug,
    meta.collection?.slug
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

function parseBestListing(
  res: AnyObj
): { amount?: string; currency?: string } | undefined {
  // The shape changes over time; be permissive.
  const listing = res.listing ?? res.best_listing ?? res;
  const price =
    listing?.price ??
    listing?.current_price ??
    listing?.protocol_data?.parameters?.consideration?.[0];

  // Common patterns
  const amount = pick<any>(
    price?.amount,
    price?.value,
    listing?.price?.current?.value,
    listing?.price?.value,
    listing?.current_price
  );
  const currency = pick<any>(
    price?.currency,
    price?.currency_symbol,
    listing?.price?.current?.currency,
    listing?.payment_token?.symbol,
    listing?.protocol_data?.payment_token?.symbol
  );

  if (amount == null && currency == null) return undefined;
  return {
    amount: amount == null ? undefined : String(amount),
    currency: currency == null ? undefined : String(currency)
  };
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

    // Listings: use Seaport orders endpoint (best-effort; shape may evolve)
    let price: { amount: string; currency: string } | undefined;
    let saleType: 'FIXED' | 'UNKNOWN' = 'UNKNOWN';

    const ordersUrl = new URL(
      `${apiBase}/api/v2/orders/${encodeURIComponent(apiChain)}/seaport/listings`
    );
    ordersUrl.searchParams.set('asset_contract_address', contract);
    ordersUrl.searchParams.set('token_ids', tokenId);
    ordersUrl.searchParams.set('limit', '1');
    // Prefer lowest price when server supports ordering
    ordersUrl.searchParams.set('order_by', 'eth_price');
    ordersUrl.searchParams.set('order_direction', 'asc');

    try {
      const orders = await fetchJsonWithTimeout<AnyObj>(ordersUrl.toString(), {
        timeoutMs,
        headers
      });
      const first = orders?.orders?.[0];
      const parsed = first ? parseBestListing(first) : undefined;
      if (parsed?.amount && parsed?.currency) {
        price = {
          amount:
            parsed?.currency === 'ETH'
              ? formatTokenAmount(BigInt(parsed.amount), ETH_DEFAULT_DECIMALS)
              : parsed.amount,
          currency: parsed.currency
        };
        saleType = 'FIXED';
      }
    } catch {
      // ignore
    }

    // Backward-compatible fallback: best listing by collection slug
    if (!price) {
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
          if (parsed?.amount && parsed?.currency) {
            price = {
              amount:
                parsed?.currency === 'ETH'
                  ? formatTokenAmount(
                      BigInt(parsed.amount),
                      ETH_DEFAULT_DECIMALS
                    )
                  : parsed.amount,
              currency: parsed.currency
            };
            saleType = 'FIXED';
          }
        } catch {
          // ignore
        }
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
