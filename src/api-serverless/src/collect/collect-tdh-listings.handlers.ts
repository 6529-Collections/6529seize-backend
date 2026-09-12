import { z } from 'zod';
import * as Operations from '@/api/generated/routes/operations';
import { executeMarketRequest } from '@/api/marketplace/marketplace.http';
import { getCollectTdhListings } from './collect-tdh-listings.service';

export function handleGetCollectTdhListings(
  req: Operations.GetCollectTdhListingsRequest
): Promise<Operations.GetCollectTdhListingsResponse> {
  return executeMarketRequest(req, async () => {
    const query = z
      .object({
        family: z.enum(['memes', 'gradients', 'pebbles']).default('memes'),
        limit: z.coerce.number().int().min(1).max(48).default(24),
        cursor: z.string().min(1).max(2048).optional()
      })
      .strict()
      .parse(req.query);
    return getCollectTdhListings(query.family, query.limit, query.cursor);
  });
}
