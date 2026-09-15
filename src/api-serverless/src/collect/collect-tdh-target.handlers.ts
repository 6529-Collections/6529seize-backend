import { z } from 'zod';
import * as Operations from '@/api/generated/routes/operations';
import { executeMarketRequest } from '@/api/marketplace/marketplace.http';
import { assertMarketActor } from '@/api/marketplace/marketplace.service';
import {
  marketAddressSchema,
  marketUintSchema
} from '@/marketplace/seaport.schema';
import { createCollectTdhTargetPlan } from '@/api/collect/collect-tdh-target.service';

export const collectTdhTargetSchema = z
  .object({
    profile_id: z.string().min(1).max(100),
    recipient: marketAddressSchema,
    target_tdh: z
      .string()
      .regex(/^(0|[1-9]\d{0,15})$/)
      .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
    target_mode: z
      .enum(['TOTAL_AT_DEADLINE', 'ADDITIONAL_OVER_BASELINE'])
      .default('TOTAL_AT_DEADLINE'),
    horizon_days: z.union([
      z.literal(1),
      z.literal(30),
      z.literal(90),
      z.literal(365)
    ]),
    families: z
      .array(z.enum(['memes', 'gradients', 'pebbles']))
      .min(1)
      .max(3)
      .refine((families) => new Set(families).size === families.length)
      .default(['memes', 'gradients', 'pebbles'])
      .transform((families) =>
        families.slice().sort((a, b) => a.localeCompare(b))
      ),
    budget_wei: marketUintSchema.optional()
  })
  .strict();

export function handleCreateCollectTdhTargetPlan(
  req: Operations.CreateCollectTdhTargetPlanRequest
): Promise<Operations.CreateCollectTdhTargetPlanResponse> {
  return executeMarketRequest(req, async (auth) => {
    const actor = assertMarketActor(auth);
    const body = collectTdhTargetSchema
      .extend({ profile_id: z.literal(actor.profileId) })
      .parse(req.body);
    return createCollectTdhTargetPlan(body);
  });
}
