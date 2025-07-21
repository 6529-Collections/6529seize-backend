import { Logger } from '../logging';
import { Time } from '../time';

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

const fetchWithRetries = async <T>(
  url: string,
  maxRetries = 12
): Promise<T | null> => {
  let attempt = 0;

  while (attempt <= maxRetries) {
    attempt++;

    const response = await fetch(url, {
      headers: {
        'x-api-key': process.env.OPENSEA_API_KEY!
      }
    });

    if (response.status === 429) {
      if (attempt > maxRetries) {
        logger.error(`[OPENSEA] Throttled after ${maxRetries} retries: ${url}`);
        return null;
      }
      logger.warn(
        `[OPENSEA] HTTP 429 on attempt ${attempt} for ${url}. Retrying in ${RETRY_DELAY_MS / 1000}s...`
      );
      await Time.millis(RETRY_DELAY_MS).sleep();
      continue;
    }

    if (!response.ok) {
      logger.warn(
        `[OPENSEA] Request failed with status ${response.status} for ${url}`
      );
      return null;
    }

    try {
      const data = (await response.json()) as T;
      return data;
    } catch (error) {
      logger.error(`[OPENSEA] Failed to parse JSON for ${url}`, error);
      return null;
    }
  }

  return null;
};

interface OpenSeaCollectionListingsResponse {
  listings: (OpenSeaBestListingResponse & { asset: { token_id: string } })[];
  next: string | null;
}

interface OpenSeaCollectionOffersResponse {
  offers: (OpenSeaBestOfferResponse & { asset: { token_id: string } })[];
  next: string | null;
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
  config: FetchConfig<T>
): Promise<Map<string, PriceResponse>> {
  const results = new Map<string, PriceResponse>();
  const baseUrl = config.baseUrl.replace('{slug}', collectionSlug);
  let next: string | null = null;

  do {
    const url: string = next
      ? `${baseUrl}&next=${encodeURIComponent(next)}`
      : baseUrl;
    const data = await fetchWithRetries<
      { next?: string | null } & Record<string, T[]>
    >(url);
    if (!data) break;

    const entries = (data[config.itemLabel] || []) as T[];

    for (const entry of entries) {
      const nftItem = config
        .extractItems(entry)
        ?.find((item) => item.itemType === requiredItemType);
      if (!nftItem) {
        logger.warn(
          `[OPENSEA] No itemType=${requiredItemType} item found in ${config.itemLabel.slice(0, -1)}: ${JSON.stringify(entry)}`
        );
        continue;
      }

      const tokenIdStr = nftItem.identifierOrCriteria;
      const tokenAmountStr = nftItem.startAmount;
      const tokenId = Number(tokenIdStr);
      if (Number.isNaN(tokenId)) continue;

      const tokenAmount = Number.isNaN(tokenAmountStr)
        ? 1
        : Number(tokenAmountStr);
      const price = config.getPriceForAll(entry) / tokenAmount;
      const maker = config.getMaker(entry);
      const existing = results.get(tokenIdStr);
      if (!existing || config.isBetterPrice(price, existing.price)) {
        results.set(tokenIdStr, { price, maker });
      }
    }

    next = data.next ?? null;
    if (next) await Time.millis(RETRY_DELAY_MS).sleep();
  } while (next);

  return results;
}

// Wrappers

export const fetchBestListingsForCollection = (
  collectionSlug: string,
  requiredItemType: number
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
    }
  );

export const fetchBestOffersForCollection = (
  collectionSlug: string,
  requiredItemType: number
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
    }
  );
