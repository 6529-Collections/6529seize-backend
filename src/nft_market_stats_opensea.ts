import { EntityManager } from 'typeorm';
import { getDataSource } from './db';
import { NextGenToken, NextGenTokenListing } from './entities/INextGen';
import { areEqualAddresses, batchArray, weiToEth } from './helpers';
import { Logger } from './logging';
import {
  fetchNextgenTokens,
  persitNextgenTokenListings
} from './nextgen/nextgen.db';
import { NEXTGEN_ROYALTIES_ADDRESS } from './nextgen/nextgen_constants';

const logger = Logger.get('OPENSEA_MARKET_STATS');

export const findNftMarketStatsOpensea = async (contract: string) => {
  logger.info(`[CONTRACT ${contract}] [RUNNING]`);

  const dataSource = getDataSource();
  await dataSource.transaction(async (entityManager) => {
    const tokens: NextGenToken[] = await fetchNextgenTokens(entityManager);
    const sortedTokens = tokens.slice().sort((a, b) => a.id - b.id);
    const batchedTokens = batchArray(sortedTokens, 30);

    for (const batch of batchedTokens) {
      await processBatch(entityManager, batch, contract);
    }
  });
};

async function processBatch(
  manager: EntityManager,
  tokens: NextGenToken[],
  contract: string
) {
  let url = `https://api.opensea.io/api/v2/orders/ethereum/seaport/listings?asset_contract_address=${contract}&limit=${tokens.length}`;
  for (const token of tokens) {
    url += `&token_ids=${token.id}`;
  }
  const response = await fetch(url, {
    headers: {
      'x-api-key': process.env.OPENSEA_API_KEY!
    }
  });

  const data: any = await response.json();
  const orders: any[] = data.orders;
  const listings: NextGenTokenListing[] = [];

  for (const token of tokens) {
    let price = 0;
    let royalty = 0;
    let listing_time = 0;
    let expiration_time = 0;
    const order = orders?.find(
      (o) =>
        o.protocol_data.parameters.offer[0].identifierOrCriteria ===
        token.id.toString()
    );
    if (order) {
      price = weiToEth(order.current_price);
      const listingRoyalty = order.maker_fees?.find((f: any) =>
        areEqualAddresses(f.account.address, NEXTGEN_ROYALTIES_ADDRESS)
      );
      royalty = listingRoyalty ? listingRoyalty.basis_points / 100 : 0;
      listing_time = order.listing_time;
      expiration_time = order.expiration_time;
    }

    const listing: NextGenTokenListing = {
      id: token.id,
      opensea_price: price,
      opensea_royalty: royalty,
      opensea_listing_time: listing_time,
      opensea_expiration_time: expiration_time
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
