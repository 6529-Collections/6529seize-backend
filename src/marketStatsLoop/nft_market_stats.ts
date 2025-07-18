import {
  fetchAllMemeLabNFTs,
  fetchNftsForContract,
  findVolume,
  persistLabNFTS,
  persistNFTs
} from '../db';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { Logger } from '../logging';
import { equalIgnoreCase } from '../strings';
import { BaseNFT } from '../entities/INFT';
import { Time } from '../time';

const logger = Logger.get('NFT_MARKET_STATS');

type PriceResponse = {
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
      offerer: string;
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
  maxRetries = 5,
  retryDelayMs = 1500
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
        `[OPENSEA] HTTP 429 on attempt ${attempt} for ${url}. Retrying in ${retryDelayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
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

const fetchBestListingsForCollection = async (
  collectionSlug: string
): Promise<Map<number, PriceResponse>> => {
  const baseUrl = `https://api.opensea.io/api/v2/listings/collection/${collectionSlug}/best?limit=100`;
  const listings = new Map<number, PriceResponse>();
  let next: string | null = null;

  do {
    const url = next ? `${baseUrl}&next=${encodeURIComponent(next)}` : baseUrl;
    const data = await fetchWithRetries<OpenSeaCollectionListingsResponse>(url);
    if (!data) {
      break;
    }

    for (const listing of data.listings || []) {
      const tokenId = Number(
        listing.asset?.token_id ??
          listing.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria
      );
      if (!Number.isNaN(tokenId)) {
        const price =
          listing.price?.current?.value && listing.price.current.decimals
            ? Number(listing.price.current.value) /
              10 ** listing.price.current.decimals
            : 0;
        const maker = listing.protocol_data?.parameters?.offerer ?? null;
        listings.set(tokenId, { price, maker });
      }
    }
    next = data.next ?? null;
  } while (next);

  return listings;
};

const fetchBestOffersForCollection = async (
  collectionSlug: string
): Promise<Map<number, PriceResponse>> => {
  const baseUrl = `https://api.opensea.io/api/v2/offers/collection/${collectionSlug}/best?limit=100`;
  const offers = new Map<number, PriceResponse>();
  let next: string | null = null;

  do {
    const url = next ? `${baseUrl}&next=${encodeURIComponent(next)}` : baseUrl;
    const data = await fetchWithRetries<OpenSeaCollectionOffersResponse>(url);
    if (!data) {
      break;
    }

    for (const offer of data.offers || []) {
      const tokenId = Number(
        offer.asset?.token_id ??
          offer.protocol_data?.parameters?.consideration?.[0]
            ?.identifierOrCriteria
      );
      if (!Number.isNaN(tokenId)) {
        const price =
          offer.price?.value && offer.price.decimals
            ? Number(offer.price.value) / 10 ** offer.price.decimals
            : 0;
        const maker = offer.protocol_data?.parameters?.offerer ?? null;
        offers.set(tokenId, { price, maker });
      }
    }
    next = data.next ?? null;
  } while (next);

  return offers;
};

export const findNftMarketStats = async (contract: string) => {
  let collectionSlug = '';
  switch (contract) {
    case MEMES_CONTRACT:
      collectionSlug = 'thememes6529';
      break;
    case MEMELAB_CONTRACT:
      collectionSlug = 'memelab6529';
      break;
    case GRADIENT_CONTRACT:
      collectionSlug = '6529-gradient';
      break;
    default:
      throw new Error(`Unknown contract: ${contract}`);
  }

  const nfts = await getNFTsForContract(contract);
  const BATCH_SIZE = 5;
  const totalBatches = Math.ceil(nfts.length / BATCH_SIZE);

  logger.info(
    `[COLLECTION ${collectionSlug}] [PROCESSING STATS FOR ${nfts.length} NFTS IN ${totalBatches} BATCHES]`
  );

  const [offersMap, listingsMap] = await Promise.all([
    fetchBestOffersForCollection(collectionSlug),
    fetchBestListingsForCollection(collectionSlug)
  ]);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * BATCH_SIZE;
    const end = start + BATCH_SIZE;
    const batch = nfts.slice(start, end);

    const processedBatch: BaseNFT[] = [];

    await Promise.all(
      batch.map(async (nft) => {
        const bestOffer = offersMap.get(nft.id) ?? { price: 0, maker: null };
        const bestListing = listingsMap.get(nft.id) ?? {
          price: 0,
          maker: null
        };

        logger.debug(
          `[NFT ${nft.id}] [BEST OFFER: ${bestOffer.price}] [BEST LISTING: ${bestListing.price}]`
        );

        const volumes = await findVolume(nft.id, contract);
        updateNftVolumeStats(nft, volumes);
        updateNftMarketStats(nft, bestListing, bestOffer);

        processedBatch.push(nft);
      })
    );

    await persistNFTsForContract(contract, processedBatch);
    logger.info(
      `[COLLECTION ${collectionSlug}] [PROCESSED BATCH ${batchIndex + 1}/${totalBatches}]`
    );

    await Time.millis(1000).sleep();
  }
};

const getNFTsForContract = async (contract: string): Promise<BaseNFT[]> => {
  if (equalIgnoreCase(contract, MEMELAB_CONTRACT)) {
    return fetchAllMemeLabNFTs('id desc');
  }
  return fetchNftsForContract(contract, 'id desc');
};

const updateNftVolumeStats = (nft: any, volumes: any): void => {
  nft.total_volume_last_24_hours = volumes?.total_volume_last_24_hours ?? 0;
  nft.total_volume_last_7_days = volumes?.total_volume_last_7_days ?? 0;
  nft.total_volume_last_1_month = volumes?.total_volume_last_1_month ?? 0;
  nft.total_volume = volumes?.total_volume ?? 0;
};

const updateNftMarketStats = (
  nft: any,
  lowestListing: PriceResponse,
  highestOffer: PriceResponse
): void => {
  nft.floor_price = lowestListing.price;
  nft.floor_price_from = lowestListing.maker;
  nft.market_cap = lowestListing.price * nft.supply;
  nft.highest_offer = highestOffer.price;
  nft.highest_offer_from = highestOffer.maker;
};

const persistNFTsForContract = async (
  contract: string,
  processedNfts: any[]
): Promise<void> => {
  if (equalIgnoreCase(contract, MEMELAB_CONTRACT)) {
    await persistLabNFTS(processedNfts);
  } else {
    await persistNFTs(processedNfts);
  }
};
