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

const RETRY_DELAY_MS = 5000;

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

const fetchBestListingsForCollection = async (
  collectionSlug: string,
  requiredItemType: number
): Promise<Map<string, PriceResponse>> => {
  const baseUrl = `https://api.opensea.io/api/v2/listings/collection/${collectionSlug}/best?limit=100`;
  const listings = new Map<string, PriceResponse>();
  let next: string | null = null;

  do {
    const url: string = next
      ? `${baseUrl}&next=${encodeURIComponent(next)}`
      : baseUrl;
    const data = await fetchWithRetries<OpenSeaCollectionListingsResponse>(url);
    if (!data) {
      break;
    }

    for (const listing of data.listings || []) {
      const nftItem = listing.protocol_data?.parameters?.offer?.find(
        (item) => item.itemType === requiredItemType
      );
      if (!nftItem) {
        logger.warn(
          `[OPENSEA] No itemType=3 offer found in listing: ${JSON.stringify(listing)}`
        );
        continue;
      }
      const tokenIdStr = nftItem.identifierOrCriteria;
      const tokenAmountStr = nftItem.startAmount;
      const tokenId = Number(tokenIdStr);
      if (!Number.isNaN(tokenId)) {
        const tokenAmount = !Number.isNaN(tokenAmountStr)
          ? Number(tokenAmountStr)
          : 1;
        const priceForAll =
          listing.price?.current?.value && listing.price.current.decimals
            ? Number(listing.price.current.value) /
              10 ** listing.price.current.decimals
            : 0;
        const price = priceForAll / tokenAmount;
        const maker = listing.protocol_data?.parameters?.offerer ?? null;
        const existing = listings.get(tokenIdStr);
        if (!existing || price < existing.price) {
          listings.set(tokenIdStr, { price, maker });
        }
      }
    }
    next = data.next ?? null;
    if (next) await Time.millis(RETRY_DELAY_MS).sleep();
  } while (next);

  return listings;
};

const fetchBestOffersForCollection = async (
  collectionSlug: string,
  requiredItemType: number
): Promise<Map<string, PriceResponse>> => {
  const baseUrl = `https://api.opensea.io/api/v2/offers/collection/${collectionSlug}/all?limit=100`;
  const offers = new Map<string, PriceResponse>();
  let next: string | null = null;

  do {
    const url: string = next
      ? `${baseUrl}&next=${encodeURIComponent(next)}`
      : baseUrl;
    const data = await fetchWithRetries<OpenSeaCollectionOffersResponse>(url);
    if (!data) {
      break;
    }

    for (const offer of data.offers || []) {
      const nftItem = offer.protocol_data?.parameters?.consideration?.find(
        (item) => item.itemType === requiredItemType
      );
      if (!nftItem) {
        logger.warn(
          `[OPENSEA] No itemType=3 offer found in offer: ${JSON.stringify(offer)}`
        );
        continue;
      }
      const tokenIdStr = nftItem.identifierOrCriteria;
      const tokenAmountStr = nftItem.startAmount;
      const tokenId = Number(tokenIdStr);
      if (!Number.isNaN(tokenId)) {
        const tokenAmount = !Number.isNaN(tokenAmountStr)
          ? Number(tokenAmountStr)
          : 1;
        const priceForAll =
          offer.price?.value && offer.price.decimals
            ? Number(offer.price.value) / 10 ** offer.price.decimals
            : 0;
        const price = priceForAll / tokenAmount;
        const maker = offer.protocol_data?.parameters?.offerer ?? null;
        const existing = offers.get(tokenIdStr);
        if (!existing || price > existing.price) {
          offers.set(tokenIdStr, { price, maker });
        }
      }
    }
    next = data.next ?? null;
    if (next) await Time.millis(RETRY_DELAY_MS).sleep();
  } while (next);

  return offers;
};

export const findNftMarketStats = async (contract: string) => {
  let collectionSlug = '';
  let itemType = 0;
  switch (contract) {
    case MEMES_CONTRACT:
      collectionSlug = 'thememes6529';
      itemType = 3;
      break;
    case MEMELAB_CONTRACT:
      collectionSlug = 'memelab6529';
      itemType = 3;
      break;
    case GRADIENT_CONTRACT:
      collectionSlug = '6529-gradient';
      itemType = 2;
      break;
    default:
      throw new Error(`Unknown contract: ${contract}`);
  }

  const offersMap = await fetchBestOffersForCollection(
    collectionSlug,
    itemType
  );
  const listingsMap = await fetchBestListingsForCollection(
    collectionSlug,
    itemType
  );

  console.log('offersMap', offersMap.size);
  console.log('listingsMap', listingsMap.size);

  const nfts = await getNFTsForContract(contract);
  const BATCH_SIZE = 50;
  const totalBatches = Math.ceil(nfts.length / BATCH_SIZE);

  logger.info(
    `[COLLECTION ${collectionSlug}] [PROCESSING STATS FOR ${nfts.length} NFTS IN ${totalBatches} BATCHES]`
  );

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * BATCH_SIZE;
    const end = start + BATCH_SIZE;
    const batch = nfts.slice(start, end);

    const processedBatch: BaseNFT[] = [];

    await Promise.all(
      batch.map(async (nft) => {
        const bestOffer = offersMap.get(nft.id.toString()) ?? {
          price: 0,
          maker: null
        };
        const bestListing = listingsMap.get(nft.id.toString()) ?? {
          price: 0,
          maker: null
        };

        logger.info(
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
