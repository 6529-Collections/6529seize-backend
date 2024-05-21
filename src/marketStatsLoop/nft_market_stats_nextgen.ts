import { EntityManager } from 'typeorm';
import { getDataSource } from '../db';
import { NextGenToken, NextGenTokenListing } from '../entities/INextGen';
import { areEqualAddresses, batchArray, weiToEth } from '../helpers';
import { Logger } from '../logging';
import {
  fetchNextgenTokens,
  persitNextgenTokenListings
} from '../nextgen/nextgen.db';
import { NEXTGEN_ROYALTIES_ADDRESS } from '../nextgen/nextgen_constants';

const logger = Logger.get('NEXTGEN_MARKET_STATS');

export const findNextgenMarketStats = async (contract: string) => {
  logger.info(`[CONTRACT ${contract}] [RUNNING]`);

  const blurListings = await getBlurListings(contract);

  const dataSource = getDataSource();
  await dataSource.transaction(async (entityManager) => {
    const tokens: NextGenToken[] = await fetchNextgenTokens(entityManager);
    const sortedTokens = tokens.slice().sort((a, b) => a.id - b.id);
    const batchedTokens = batchArray(sortedTokens, 30);

    for (const batch of batchedTokens) {
      await processBatch(entityManager, batch, contract, blurListings);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });
};

async function processBatch(
  manager: EntityManager,
  tokens: NextGenToken[],
  contract: string,
  blurListings: any[]
) {
  let url = `https://api.opensea.io/api/v2/orders/ethereum/seaport/listings?asset_contract_address=${contract}&limit=${tokens.length}`;
  for (const token of tokens) {
    url += `&token_ids=${token.id}`;
  }
  const response = await getOpenseaResponse(url);
  const data: any = await response.json();
  const orders: any[] = data.orders;
  const listings: NextGenTokenListing[] = [];

  for (const token of tokens) {
    let osPrice = 0;
    let osRoyalty = 0;
    let osListingTime = 0;
    let osExpirationTime = 0;
    let blurPrice = 0;
    let blurListingTime = 0;
    const osOrder = orders?.find(
      (o) =>
        o.protocol_data.parameters.offer[0].identifierOrCriteria ===
        token.id.toString()
    );
    if (osOrder) {
      osPrice = weiToEth(osOrder.current_price);
      const listingRoyalty = osOrder.maker_fees?.find((f: any) =>
        areEqualAddresses(f.account.address, NEXTGEN_ROYALTIES_ADDRESS)
      );
      osRoyalty = listingRoyalty ? listingRoyalty.basis_points / 100 : 0;
      osListingTime = osOrder.listing_time;
      osExpirationTime = osOrder.expiration_time;
    }

    const blurListing = blurListings.find(
      (l) => l.tokenId === token.id.toString()
    );
    if (blurListing?.price) {
      blurPrice = blurListing.price?.amount;
      blurListingTime = new Date(blurListing.price?.listedAt).getTime() / 1000;
    }

    const listing: NextGenTokenListing = {
      id: token.id,
      price: getMinPositivePrice(osPrice, blurPrice),
      opensea_price: osPrice,
      opensea_royalty: osRoyalty,
      opensea_listing_time: osListingTime,
      opensea_expiration_time: osExpirationTime,
      blur_price: blurPrice,
      blur_listing_time: blurListingTime
    };
    listings.push(listing);
  }

  await persitNextgenTokenListings(manager, listings);
  logger.info(
    `[CONTRACT ${contract}] [TOKENS ${tokens[0].id} - ${
      tokens[tokens.length - 1].id
    }] [PROCESSED]`
  );
}

async function getOpenseaResponse(url: string) {
  return await fetch(url, {
    headers: {
      'x-api-key': process.env.OPENSEA_API_KEY!
    }
  });
}

async function getBlurListings(contract: string): Promise<any[]> {
  const url = `https://blur.p.rapidapi.com/v1/collections/${contract}/tokens?filters=%7B%22marketplace%22%3A%22BLUR%22%7D`;
  const response = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': process.env.RAPID_API_KEY!
    }
  });
  const jsonResponse: any = await response.json();
  return jsonResponse?.tokens ?? [];
}

function getMinPositivePrice(osPrice: number, blurPrice: number) {
  if (osPrice > 0 && blurPrice > 0) {
    return Math.min(osPrice, blurPrice);
  }
  if (osPrice > 0) {
    return osPrice;
  }
  if (blurPrice > 0) {
    return blurPrice;
  }
  return 0;
}
