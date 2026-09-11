import { z } from 'zod';
import * as Operations from '@/api/generated/routes/operations';
import { ApiCollectFamily } from '@/api/generated/models/ApiCollectFamily';
import {
  ApiCollectTdhRankingCandidateScopeEnum,
  ApiCollectTdhRankingOptimalityEnum
} from '@/api/generated/models/ApiCollectTdhRanking';
import { executeMarketRequest } from '@/api/marketplace/marketplace.http';
import { assertMarketActor } from '@/api/marketplace/marketplace.service';
import { discoveredOrderDto } from '@/api/marketplace/marketplace.dto';
import { marketAddressSchema } from '@/marketplace/seaport.schema';
import {
  discoverCollectListings,
  rankCollectPurchases
} from './collect-discovery.service';

const familySchema = z.enum(['memes', 'gradients', 'pebbles']);
export function handleGetMarketListings(
  req: Operations.GetMarketListingsRequest
): Promise<Operations.GetMarketListingsResponse> {
  return executeMarketRequest(req, async () => {
    const query = z
      .object({
        family: familySchema,
        cursor: z.string().min(1).max(2048).optional(),
        limit: z.coerce.number().int().min(1).max(48).default(24)
      })
      .strict()
      .parse(req.query);
    const result = await discoverCollectListings(
      query.family,
      query.limit,
      query.cursor
    );
    return {
      ...result,
      entries: result.entries.map(({ asset, order }) => ({
        asset: { ...asset, family: asset.family as ApiCollectFamily },
        order: discoveredOrderDto(order, asset.asset_key)
      }))
    };
  });
}
export function handleRankCollectTdhPurchases(
  req: Operations.RankCollectTdhPurchasesRequest
): Promise<Operations.RankCollectTdhPurchasesResponse> {
  return executeMarketRequest(req, async (auth) => {
    const actor = assertMarketActor(auth);
    const input = z
      .object({
        profile_id: z.literal(actor.profileId),
        family: familySchema,
        recipient: marketAddressSchema,
        horizon_days: z.union([
          z.literal(1),
          z.literal(30),
          z.literal(90),
          z.literal(365)
        ]),
        plan_id: z.string().uuid().optional()
      })
      .strict()
      .parse(req.body);
    const result = await rankCollectPurchases(input);
    return {
      ...result,
      optimality: result.optimality as ApiCollectTdhRankingOptimalityEnum,
      candidate_scope:
        result.candidate_scope as ApiCollectTdhRankingCandidateScopeEnum
    };
  });
}
