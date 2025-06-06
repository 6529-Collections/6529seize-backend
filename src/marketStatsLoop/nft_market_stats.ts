import {
  fetchAllMemeLabNFTs,
  fetchNftsForContract,
  findVolume,
  persistLabNFTS,
  persistNFTs
} from '../db';
import { MEMELAB_CONTRACT } from '../constants';
import { Logger } from '../logging';
import { Time } from '../time';
import { equalIgnoreCase } from '../strings';
import { collections } from '../collections';
import { ethTools } from '../eth-tools';

const logger = Logger.get('NFT_MARKET_STATS');

type PriceResponse = {
  price: number;
  maker: string | null;
};

async function getOpenseaResponseForPage(url: string, pageToken: string) {
  if (pageToken) {
    url += `&cursor=${pageToken}`;
  }
  return await fetch(url, {
    headers: {
      'x-api-key': process.env.OPENSEA_API_KEY!
    }
  });
}

export async function getOpenseaResponse(url: string): Promise<any[]> {
  let pageToken: any = '';
  const response: any[] = [];
  while (pageToken !== null) {
    try {
      const res = await getOpenseaResponseForPage(url, pageToken);
      const data: any = await res.json();
      response.push(...data.orders);
      pageToken = data.next;
    } catch (e) {
      logger.error(`[OPENSEA ERROR] ${e}`);
      pageToken = null;
    }
  }
  return response;
}

export const findNftMarketStats = async (contract: string) => {
  const nfts = await getNFTsForContract(contract);
  logger.info(
    `[CONTRACT ${contract}] [PROCESSING STATS FOR ${nfts.length} NFTS]`
  );

  const batchedTokens = collections.chunkArray(nfts, 30);

  for (let i = 0; i < batchedTokens.length; i++) {
    const batch = batchedTokens[i];
    const listingsUrl = buildOpenseaUrl(contract, 'listings', batch);
    const offersUrl = buildOpenseaUrl(contract, 'offers', batch);

    const listings = await getOpenseaResponse(listingsUrl);
    await Time.millis(500).sleep();
    const offers = await getOpenseaResponse(offersUrl);

    const processedNfts = await processBatch(batch, listings, offers, contract);

    await persistNFTsForContract(contract, processedNfts);

    logBatchStatus(
      contract,
      processedNfts.length,
      batchedTokens.length - i - 1
    );

    await Time.millis(500).sleep();
  }
};

const getNFTsForContract = async (contract: string): Promise<any[]> => {
  if (equalIgnoreCase(contract, MEMELAB_CONTRACT)) {
    return fetchAllMemeLabNFTs('id desc');
  }
  return fetchNftsForContract(contract, 'id desc');
};

const buildOpenseaUrl = (
  contract: string,
  type: string,
  batch: any[]
): string => {
  let url = `https://api.opensea.io/api/v2/orders/ethereum/seaport/${type}?asset_contract_address=${contract}&limit=50`;

  for (const nft of batch) {
    url += `&token_ids=${nft.id}`;
  }

  return url;
};

const processBatch = async (
  batch: any[],
  listings: any[],
  offers: any[],
  contract: string
): Promise<any[]> => {
  const processedNfts = [];

  for (const nft of batch) {
    const nftListings = filterListingsForNft(listings, nft.id);
    const nftOffers = filterOffersForNft(offers, contract, nft.id);
    const lowestListing = getLowestListing(nft.id, contract, nftListings);
    const highestOffer = getHighestOffer(nft.id, contract, nftOffers);

    const volumes = await findVolume(nft.id, contract);
    updateNftVolumeStats(nft, volumes);
    updateNftMarketStats(nft, lowestListing, highestOffer);

    processedNfts.push(nft);
  }

  return processedNfts;
};

const filterListingsForNft = (listings: any[], nftId: string): any[] => {
  return listings.filter(
    (o) =>
      !o.taker &&
      o.protocol_data?.parameters.offer[0].identifierOrCriteria ===
        nftId.toString()
  );
};

const filterOffersForNft = (
  offers: any[],
  contract: string,
  nftId: string
): any[] => {
  return offers.filter((o) =>
    o.protocol_data?.parameters.consideration.some(
      (f: any) =>
        equalIgnoreCase(f.token, contract) &&
        f.identifierOrCriteria === nftId.toString()
    )
  );
};

const getLowestListing = (
  id: string,
  contract: string,
  nftListings: any[]
): PriceResponse => {
  const entries = nftListings
    .map((item) => {
      const offer = item.protocol_data.parameters.offer.find(
        (o: any) =>
          equalIgnoreCase(o.token, contract) &&
          o.identifierOrCriteria === id.toString()
      );
      if (offer) {
        const normalizedPrice = ethTools.weiToEth(
          item.current_price / offer.endAmount
        );
        return { price: normalizedPrice, maker: item.maker?.address ?? null };
      }
      return null;
    })
    .filter((entry) => entry !== null) as PriceResponse[];

  if (entries.length === 0) {
    return { price: 0, maker: null };
  }

  const lowest = entries.reduce(
    (min, curr) => (curr.price < min.price ? curr : min),
    { price: Infinity, maker: null }
  );

  return {
    price: Math.round(lowest.price * 10000) / 10000,
    maker: lowest.maker
  };
};

const getHighestOffer = (
  id: string,
  contract: string,
  nftOffers: any[]
): PriceResponse => {
  const entries = nftOffers
    .map((item) => {
      const consideration = item.protocol_data.parameters.consideration.find(
        (c: any) =>
          equalIgnoreCase(c.token, contract) &&
          c.identifierOrCriteria === id.toString()
      );
      if (consideration) {
        const normalizedPrice = ethTools.weiToEth(
          item.current_price / consideration.endAmount
        );
        return { price: normalizedPrice, maker: item.maker?.address ?? null };
      }
      return null;
    })
    .filter((entry) => entry !== null) as PriceResponse[];

  if (entries.length === 0) {
    return { price: 0, maker: null };
  }

  const highest = entries.reduce(
    (max, curr) => (curr.price > max.price ? curr : max),
    { price: -Infinity, maker: null }
  );

  return {
    price: Math.round(highest.price * 10000) / 10000,
    maker: highest.maker
  };
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

const logBatchStatus = (
  contract: string,
  processedNftsLength: number,
  remainingBatches: number
): void => {
  logger.info(
    `[CONTRACT ${contract}] [PROCESSED BATCH OF ${processedNftsLength}]${
      remainingBatches > 0
        ? ` [REMAINING BATCHES: ${remainingBatches}]`
        : '[LAST BATCH]'
    }`
  );
};
