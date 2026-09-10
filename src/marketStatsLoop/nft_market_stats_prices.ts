import { Logger } from '../logging';
import { Time } from '../time';
import {
  fetchOpenSeaPricePage,
  waitForOpenSeaPage
} from '@/marketStatsLoop/opensea-price-fetch';

const logger = Logger.get('NFT_MARKET_STATS_PRICES_PRICES');

const RETRY_DELAY_MS = 5000;

export type PriceResponse = {
  price: number;
  maker: string | null;
};

interface OpenSeaPriceResponse {
  currency: string;
  decimals: number;
  value: string;
}

interface OpenSeaUserResponse {
  protocol_data: {
    parameters: {
      consideration: {
        startAmount: string;
        identifierOrCriteria: string;
        itemType: number;
      }[];
      offerer: string;
      offer: {
        startAmount: string;
        itemType: number;
        identifierOrCriteria: string;
      }[];
    };
  };
}

interface OpenSeaBestListingResponse extends OpenSeaUserResponse {
  price: {
    current: OpenSeaPriceResponse;
  };
}

interface OpenSeaBestOfferResponse extends OpenSeaUserResponse {
  price: OpenSeaPriceResponse;
}

type PriceSource = 'listings' | 'offers';

interface FetchConfig<T> {
  baseUrl: string;
  extractItems: (entry: T) => any[];
  getPriceForAll: (entry: T) => number;
  getMaker: (entry: T) => string | null;
  isBetterPrice: (newPrice: number, existingPrice: number) => boolean;
  itemLabel: PriceSource;
}

async function fetchBestPricesForCollection<T>(
  collectionSlug: string,
  requiredItemType: number,
  config: FetchConfig<T>,
  deadlineMs: number
): Promise<Map<string, PriceResponse>> {
  const results = new Map<string, PriceResponse>();
  const baseUrl = config.baseUrl.replace('{slug}', collectionSlug);
  let next: string | null = null;
  const seenCursors = new Set<string>();

  do {
    const url = buildUrl(baseUrl, next);
    const data = await fetchOpenSeaPricePage(url, deadlineMs);
    const { entries, next: nextCursor } = parsePricePage<T>(
      data,
      config.itemLabel,
      url
    );

    for (const entry of entries) {
      processEntry(entry, requiredItemType, config, results);
    }

    next = nextCursor;
    if (next) {
      if (seenCursors.has(next)) {
        throw new Error(`[OPENSEA] Repeated pagination cursor for ${url}`);
      }
      seenCursors.add(next);
      await waitForOpenSeaPage(RETRY_DELAY_MS, deadlineMs, url);
    }
  } while (next);

  return results;
}

function parsePricePage<T>(
  data: unknown,
  itemLabel: PriceSource,
  url: string
): { entries: T[]; next: string | null } {
  if (!data || typeof data !== 'object') {
    throw new Error(`[OPENSEA] Invalid ${itemLabel} response for ${url}`);
  }
  const page = data as Record<string, unknown>;
  if (
    !Array.isArray(page[itemLabel]) ||
    (page.next != null && (typeof page.next !== 'string' || !page.next))
  ) {
    throw new Error(`[OPENSEA] Invalid ${itemLabel} page for ${url}`);
  }
  return {
    entries: page[itemLabel] as T[],
    next: (page.next as string | null) ?? null
  };
}

function buildUrl(baseUrl: string, next: string | null): string {
  return next ? `${baseUrl}&next=${encodeURIComponent(next)}` : baseUrl;
}

function processEntry<T>(
  entry: T,
  requiredItemType: number,
  config: FetchConfig<T>,
  results: Map<string, PriceResponse>
) {
  const nftItem = config
    .extractItems(entry)
    ?.find((item) => item.itemType === requiredItemType);
  if (!nftItem) {
    logger.warn(
      `[OPENSEA] No itemType=${requiredItemType} item found in ${config.itemLabel.slice(0, -1)}`
    );
    return;
  }

  const tokenIdStr = nftItem.identifierOrCriteria;
  const tokenId = Number(tokenIdStr);
  if (Number.isNaN(tokenId)) return;

  const tokenAmount = Number.isNaN(nftItem.startAmount)
    ? 1
    : Number(nftItem.startAmount);
  const price = config.getPriceForAll(entry) / tokenAmount;
  const maker = config.getMaker(entry);
  const existing = results.get(tokenIdStr);

  if (!existing || config.isBetterPrice(price, existing.price)) {
    results.set(tokenIdStr, { price, maker });
  }
}

export const fetchBestListingsForCollection = (
  collectionSlug: string,
  requiredItemType: number,
  deadlineMs = Date.now() + Time.minutes(10).toMillis()
): Promise<Map<string, PriceResponse>> =>
  fetchBestPricesForCollection<OpenSeaBestListingResponse>(
    collectionSlug,
    requiredItemType,
    {
      baseUrl:
        'https://api.opensea.io/api/v2/listings/collection/{slug}/best?limit=100',
      extractItems: (entry) => entry.protocol_data?.parameters?.offer ?? [],
      getPriceForAll: (entry) =>
        entry.price?.current?.value && entry.price.current.decimals
          ? Number(entry.price.current.value) /
            10 ** entry.price.current.decimals
          : 0,
      getMaker: (entry) => entry.protocol_data?.parameters?.offerer ?? null,
      isBetterPrice: (newPrice, existingPrice) => newPrice < existingPrice,
      itemLabel: 'listings'
    },
    deadlineMs
  );

export const fetchBestOffersForCollection = (
  collectionSlug: string,
  requiredItemType: number,
  deadlineMs = Date.now() + Time.minutes(10).toMillis()
): Promise<Map<string, PriceResponse>> =>
  fetchBestPricesForCollection<OpenSeaBestOfferResponse>(
    collectionSlug,
    requiredItemType,
    {
      baseUrl:
        'https://api.opensea.io/api/v2/offers/collection/{slug}/all?limit=100',
      extractItems: (entry) =>
        entry.protocol_data?.parameters?.consideration ?? [],
      getPriceForAll: (entry) =>
        entry.price?.value && entry.price.decimals
          ? Number(entry.price.value) / 10 ** entry.price.decimals
          : 0,
      getMaker: (entry) => entry.protocol_data?.parameters?.offerer ?? null,
      isBetterPrice: (newPrice, existingPrice) => newPrice > existingPrice,
      itemLabel: 'offers'
    },
    deadlineMs
  );
