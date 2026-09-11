import * as sentryContext from '@/sentry.context';
import { doInDbContext } from '@/secrets';
import { discoverOpenSeaCollections } from '@/market-depth/opensea-poller';
import { NextGenCollection, NextGenToken } from '@/entities/INextGen';
import { handler as runHandler } from './runtime';

export const handler = sentryContext.wrapLambdaHandler(async (event, context) =>
  doInDbContext(
    async () =>
      runHandler(event, {
        getRemainingTimeInMillis: () => context.getRemainingTimeInMillis(),
        collections: (await discoverOpenSeaCollections()).map((collection) => ({
          slug: collection.collection_slug,
          contract: collection.contract
        }))
      }),
    { skipRedis: true, entities: [NextGenCollection, NextGenToken] }
  )
);
