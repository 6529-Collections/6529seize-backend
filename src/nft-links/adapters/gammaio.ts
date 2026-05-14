import type {
  AdapterResult,
  PlatformAdapter
} from '@/nft-links/adapters/types';
import { buildPrimaryAction } from '@/nft-links/lib/market';
import {
  fetchJsonWithTimeout,
  fetchTextWithTimeout
} from '@/nft-links/lib/http';
import { extractOg } from '@/nft-links/lib/og';
import { formatTokenAmount } from '@/nft-links/lib/onchain';
import { CanonicalLink } from '@/nft-links/types';
import { env } from '@/env';
import { CustomApiCompliantException } from '@/exceptions';

type GammaIoIdentifier =
  | { kind: 'ordinal'; inscriptionId: string }
  | { kind: 'stacks'; nftId: string }
  | { kind: 'collection'; collectionSlug: string; tokenId: string }
  | null;

type GammaIoPrice = {
  amount: string;
  currency: string;
};

type GammaIoApiData = {
  title?: string;
  description?: string;
  imageUrl?: string;
  collectionName?: string;
  tokenId?: string;
  price?: GammaIoPrice;
};

const HTML_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#34;': '"',
  '&amp;': '&',
  '&#38;': '&',
  '&lt;': '<',
  '&#60;': '<',
  '&gt;': '>',
  '&#62;': '>'
};

const MICRO_STACKS_PER_STX = BigInt(1_000_000);
const MICRO_STACKS_ROUND_UP_REMAINDER = BigInt(999_999);

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(quot|amp|lt|gt|#34|#38|#60|#62);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractJsonLdBlocks(html: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const scriptRegex =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html))) {
    const rawJson = decodeHtmlEntities(match[1] ?? '').trim();
    if (!rawJson) continue;
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        blocks.push(...parsed.filter(isRecord));
      } else if (isRecord(parsed)) {
        if (Array.isArray(parsed['@graph'])) {
          blocks.push(...parsed['@graph'].filter(isRecord));
        }
        blocks.push(parsed);
      }
    } catch {
      // Gamma.io pages can include partial/non-NFT JSON-LD; ignore malformed blocks.
    }
  }

  return blocks;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function getJsonLdImage(block: Record<string, unknown>): string | undefined {
  const image = block.image;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    return firstString(...image);
  }
  if (isRecord(image)) {
    return firstString(image.url, image.contentUrl);
  }
  return undefined;
}

function hasGammaIoMetadata(
  title: string | undefined,
  description: string | undefined,
  imageUrl: string | undefined
): boolean {
  return !!(title || description || imageUrl);
}

function slugToName(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseGammaIoIdentifier(canonical: CanonicalLink): GammaIoIdentifier {
  if (canonical.identifiers.kind !== 'URL_ONLY') return null;
  const customId = canonical.identifiers.customId;
  if (!customId) return null;

  const ordinalMatch = /^ordinal:(.+)$/.exec(customId);
  if (ordinalMatch?.[1]) {
    return { kind: 'ordinal', inscriptionId: ordinalMatch[1] };
  }

  const stacksMatch = /^stacks:(.+)$/.exec(customId);
  if (stacksMatch?.[1]) {
    return { kind: 'stacks', nftId: stacksMatch[1] };
  }

  const collectionMatch = /^collection:([^:]+):(\d+)$/.exec(customId);
  if (collectionMatch?.[1] && collectionMatch?.[2]) {
    return {
      kind: 'collection',
      collectionSlug: collectionMatch[1],
      tokenId: collectionMatch[2]
    };
  }

  return null;
}

function parseGammaIoPrice(value: unknown): GammaIoPrice | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.amount !== 'number' && typeof value.amount !== 'string') {
    return undefined;
  }

  const priceUnits = {
    micro_stacks: { decimals: 6, currency: 'STX' },
    sats: { decimals: 8, currency: 'BTC' }
  } as const;
  const unit =
    typeof value.unit === 'string'
      ? priceUnits[value.unit as keyof typeof priceUnits]
      : undefined;
  if (!unit) return undefined;

  try {
    let amount = BigInt(value.amount);
    if (
      value.unit === 'micro_stacks' &&
      amount % MICRO_STACKS_PER_STX === MICRO_STACKS_ROUND_UP_REMAINDER
    ) {
      amount += BigInt(1);
    }
    return {
      amount: formatTokenAmount(amount, unit.decimals),
      currency: unit.currency
    };
  } catch {
    return undefined;
  }
}

function extractListingPrice(response: unknown): GammaIoPrice | undefined {
  if (!isRecord(response)) return undefined;
  const item = response.item;
  if (!isRecord(item)) return undefined;
  const marketSummary = item.market_summary;
  if (!isRecord(marketSummary)) return undefined;
  const listing = marketSummary.listing;
  if (!isRecord(listing)) return undefined;
  return parseGammaIoPrice(listing.price_amount);
}

function extractApiItemData(response: unknown): GammaIoApiData | undefined {
  if (!isRecord(response) || !isRecord(response.item)) return undefined;

  const assetContent = response.item.asset_content;
  const collection = response.item.collection;
  const itemId =
    typeof response.item.id === 'string' ? response.item.id : undefined;
  return {
    title: firstString(response.item.name),
    description: firstString(response.item.description),
    imageUrl: isRecord(assetContent)
      ? firstString(assetContent.content_url)
      : undefined,
    collectionName: isRecord(collection)
      ? firstString(collection.name)
      : undefined,
    tokenId: itemId?.split('_').at(-1),
    price: extractListingPrice(response)
  };
}

function getGammaIoApiUrl(identifier: GammaIoIdentifier): string | undefined {
  if (identifier?.kind === 'ordinal') {
    return `https://gamma.io/api/get-inscription?id=${encodeURIComponent(
      identifier.inscriptionId
    )}`;
  }
  if (identifier?.kind === 'stacks') {
    return `https://gamma.io/api/get-stacks-nft?id=${encodeURIComponent(
      identifier.nftId
    )}`;
  }
  return undefined;
}

async function fetchGammaIoApiData(
  identifier: GammaIoIdentifier,
  timeoutMs: number
): Promise<GammaIoApiData | undefined> {
  const url = getGammaIoApiUrl(identifier);
  if (!url) return undefined;
  try {
    const response = await fetchJsonWithTimeout<unknown>(url, {
      timeoutMs,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; 6529-link-resolver/0.7)',
        accept: 'application/json'
      }
    });
    return extractApiItemData(response);
  } catch {
    return undefined;
  }
}

export class GammaIoAdapter implements PlatformAdapter {
  canHandle(canonical: CanonicalLink): boolean {
    return canonical.platform === 'GAMMAIO';
  }

  async resolveFast(canonical: CanonicalLink): Promise<AdapterResult | null> {
    const timeoutMs = env.getIntOrNull('GAMMAIO_TIMEOUT_MS') ?? 1800;
    const html = await fetchTextWithTimeout(canonical.viewUrl, {
      timeoutMs,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; 6529-link-resolver/0.7)',
        accept: 'text/html,application/xhtml+xml'
      }
    });

    const og = extractOg(html);
    const jsonLd = extractJsonLdBlocks(html);
    const primaryJsonLd =
      jsonLd.find((block) => getJsonLdImage(block)) ??
      jsonLd.find((block) => firstString(block.name));
    const identifier = parseGammaIoIdentifier(canonical);
    const apiData = await fetchGammaIoApiData(identifier, timeoutMs);

    const title = firstString(apiData?.title, primaryJsonLd?.name, og.title);
    const description = firstString(
      apiData?.description,
      og.description,
      primaryJsonLd?.description
    );
    const imageUrl = firstString(
      apiData?.imageUrl,
      og.image,
      primaryJsonLd ? getJsonLdImage(primaryJsonLd) : undefined
    );
    const price = apiData?.price;
    const saleType = price ? 'FIXED' : 'UNKNOWN';

    if (!hasGammaIoMetadata(title, description, imageUrl)) {
      throw new CustomApiCompliantException(
        502,
        `Unable to extract Gamma.io metadata from ${canonical.viewUrl}`
      );
    }

    const patch: Partial<AdapterResult['patch']> = {
      asset: {
        title,
        description,
        collection:
          identifier?.kind === 'collection'
            ? { name: slugToName(identifier.collectionSlug) }
            : apiData?.collectionName
              ? { name: apiData.collectionName }
              : undefined,
        tokenId:
          identifier?.kind === 'collection'
            ? identifier.tokenId
            : apiData?.tokenId,
        media: imageUrl ? { kind: 'image', imageUrl } : undefined
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

export default GammaIoAdapter;
