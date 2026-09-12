import { z } from 'zod';
import * as Operations from '@/api/generated/routes/operations';
import { createCollectDailyTdhPlan } from '@/api/collect/collect-daily-tdh.service';
import { executeMarketRequest } from '@/api/marketplace/marketplace.http';
import { assertMarketActor } from '@/api/marketplace/marketplace.service';
import {
  marketAddressSchema,
  marketUintSchema
} from '@/marketplace/seaport.schema';
import { MARKET_ZERO_ADDRESS } from '@/marketplace/seaport.registry';

const allFamilies = ['memes', 'gradients', 'pebbles'] as const;

const targetRateSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})$/)
  .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));

function createCollectDailyTdhSchema(profileId: z.ZodType<string>) {
  return z
    .object({
      profile_id: profileId,
      recipient: marketAddressSchema.refine(
        (recipient) => recipient.toLowerCase() !== MARKET_ZERO_ADDRESS,
        'A recipient is required.'
      ),
      families: z
        .array(z.enum(allFamilies))
        .min(1)
        .max(allFamilies.length)
        .refine((families) => new Set(families).size === families.length)
        .default([...allFamilies])
        .transform((families) =>
          families.slice().sort((a, b) => a.localeCompare(b))
        ),
      mode: z.enum(['BASE_TDH_TARGET', 'ETH_BUDGET']),
      target_base_tdh_per_day_hundredths: targetRateSchema.optional(),
      budget_wei: marketUintSchema.optional()
    })
    .strict()
    .superRefine((request, context) => {
      const hasTarget =
        request.target_base_tdh_per_day_hundredths !== undefined;
      const hasBudget = request.budget_wei !== undefined;
      const validInputs =
        request.mode === 'BASE_TDH_TARGET'
          ? hasTarget && !hasBudget
          : hasBudget && !hasTarget;
      if (!validInputs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Exactly one input matching mode is required',
          path:
            request.mode === 'BASE_TDH_TARGET'
              ? ['target_base_tdh_per_day_hundredths']
              : ['budget_wei']
        });
      }
    });
}

export const collectDailyTdhSchema = createCollectDailyTdhSchema(
  z.string().min(1).max(100)
);

export function handleCreateCollectDailyTdhPlan(
  req: Operations.CreateCollectDailyTdhPlanRequest
): Promise<Operations.CreateCollectDailyTdhPlanResponse> {
  return executeMarketRequest(req, async (auth) => {
    const actor = assertMarketActor(auth);
    const body = createCollectDailyTdhSchema(z.literal(actor.profileId)).parse(
      req.body
    );
    return createCollectDailyTdhPlan(body);
  });
}
