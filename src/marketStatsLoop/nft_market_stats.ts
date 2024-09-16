import { areEqualAddresses, batchArray, delay, weiToEth } from '../helpers';
import {
  fetchNftsForContract,
  fetchAllMemeLabNFTs,
  persistLabNFTS,
  findVolume,
  persistNFTs
} from '../db';
import { MEMELAB_CONTRACT } from '../constants';
import { Logger } from '../logging';

const logger = Logger.get('NFT_MARKET_STATS');

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
  let pageToken = '';
  const response = [];
  while (pageToken !== null) {
    const res = await getOpenseaResponseForPage(url, pageToken);
    const data: any = await res.json();
    response.push(...data.orders);
    pageToken = data.next;
  }
  return response;
}

export const findNftMarketStats = async (contract: string) => {
  let nfts: any[];
  if (areEqualAddresses(contract, MEMELAB_CONTRACT)) {
    nfts = await fetchAllMemeLabNFTs('id desc');
  } else {
    nfts = await fetchNftsForContract(contract, 'id desc');
  }

  logger.info(
    `[CONTRACT ${contract}] [PROCESSING STATS FOR ${nfts.length} NFTS]`
  );

  const batchedTokens = batchArray(nfts, 30);

  for (let i = 0; i < batchedTokens.length; i++) {
    const batch = batchedTokens[i];
    let listingsUrl = `https://api.opensea.io/api/v2/orders/ethereum/seaport/listings?asset_contract_address=${contract}&limit=50`;
    let offersUrl = `https://api.opensea.io/api/v2/orders/ethereum/seaport/offers?asset_contract_address=${contract}&order_by=eth_price&order_direction=desc&limit=50`;

    for (const nft of batch) {
      listingsUrl += `&token_ids=${nft.id}`;
      offersUrl += `&token_ids=${nft.id}`;
    }
    const listings: any[] = await getOpenseaResponse(listingsUrl);
    await delay(500);
    const offers: any[] = await getOpenseaResponse(offersUrl);

    const processedNfts = [];

    for (const nft of batch) {
      const nftListings = listings.filter(
        (o) =>
          o.protocol_data?.parameters.offer[0].identifierOrCriteria ===
          nft.id.toString()
      );
      const nftOffers = offers.filter((o) =>
        o.protocol_data?.parameters.consideration.some(
          (f: any) =>
            areEqualAddresses(f.token, contract) &&
            f.identifierOrCriteria === nft.id.toString()
        )
      );
      const lowestListing =
        nftListings.sort((a, d) => a.current_price - d.current_price)?.[0] ??
        null;
      const highestOffer =
        nftOffers.sort((a, d) => d.current_price - a.current_price)?.[0] ??
        null;
      const volumes = await findVolume(nft.id, contract);
      nft.total_volume_last_24_hours = volumes?.total_volume_last_24_hours ?? 0;
      nft.total_volume_last_7_days = volumes?.total_volume_last_7_days ?? 0;
      nft.total_volume_last_1_month = volumes?.total_volume_last_1_month ?? 0;
      nft.total_volume = volumes?.total_volume ?? 0;

      let lowestListingPrice = weiToEth(lowestListing?.current_price ?? 0);
      lowestListingPrice = Math.round(lowestListingPrice * 10000) / 10000;
      nft.floor_price = lowestListingPrice;
      nft.market_cap = lowestListingPrice * nft.supply;

      let highestOfferPrice = weiToEth(highestOffer?.current_price ?? 0);
      highestOfferPrice = Math.round(highestOfferPrice * 10000) / 10000;
      nft.highest_offer = highestOfferPrice;
      processedNfts.push(nft);
    }

    if (areEqualAddresses(contract, MEMELAB_CONTRACT)) {
      await persistLabNFTS(processedNfts);
    } else {
      await persistNFTs(processedNfts);
    }

    const remainingBatches = batchedTokens.length - i - 1;
    logger.info(
      `[CONTRACT ${contract}] [PROCESSED BATCH OF ${processedNfts.length}]${
        remainingBatches > 0
          ? ` [REMAINING BATCHES: ${remainingBatches}]`
          : '[LAST BATCH]'
      }`
    );

    await delay(500);
  }
};
