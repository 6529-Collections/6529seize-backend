import { z } from 'zod';
import * as Operations from '@/api/generated/routes/operations';
import {
  ApiCollectPlan,
  ApiCollectPlanStateEnum
} from '@/api/generated/models/ApiCollectPlan';
import { ApiCollectKind } from '@/api/generated/models/ApiCollectKind';
import { ApiCollectFamily } from '@/api/generated/models/ApiCollectFamily';
import {
  ApiCollectAcquisitionPlan,
  ApiCollectAcquisitionPlanOptimalityEnum,
  ApiCollectAcquisitionPlanStatusEnum
} from '@/api/generated/models/ApiCollectAcquisitionPlan';
import { assertMarketActor } from '@/api/marketplace/marketplace.service';
import { executeMarketRequest } from '@/api/marketplace/marketplace.http';
import { collectingService } from '@/collecting/collecting.service';
import {
  CollectingPurchaseProjectionRequest,
  ProjectedAccountTdh
} from '@/collecting/collecting-tdh-projection';
import { CollectingAnalysisRequest } from '@/collecting/collecting.types';
import { BadRequestException } from '@/exceptions';
import {
  marketAddressSchema,
  marketUintSchema
} from '@/marketplace/seaport.schema';
import { analysisSchema } from './collect.handlers';
import {
  advanceCollectPlan,
  collectPlanOptionsSchema,
  createCollectPlan,
  readCollectPlan
} from './collect-plans.service';

type Plan = Awaited<ReturnType<typeof readCollectPlan>>;
const idSchema = z.string().uuid();
function acquisitionPlanDto(plan: Plan['result']): ApiCollectAcquisitionPlan {
  return {
    ...plan,
    status: plan.status as ApiCollectAcquisitionPlanStatusEnum,
    optimality: plan.optimality as ApiCollectAcquisitionPlanOptimalityEnum
  };
}
function planDto(plan: Plan): ApiCollectPlan {
  return {
    ...plan,
    state: plan.state as ApiCollectPlanStateEnum,
    analysis: { ...plan.analysis, kind: plan.analysis.kind as ApiCollectKind },
    result: acquisitionPlanDto(plan.result),
    available_result: acquisitionPlanDto(plan.available_result)
  };
}
export function handleCreateCollectPlan(
  req: Operations.CreateCollectPlanRequest
): Promise<Operations.CreateCollectPlanResponse> {
  return executeMarketRequest(req, async (auth) => {
    const actor = assertMarketActor(auth);
    const raw = z
      .object({ goal: z.unknown(), options: collectPlanOptionsSchema })
      .strict()
      .parse(req.body);
    const goal = analysisSchema.validate(raw.goal, { convert: false });
    if (goal.error) throw new BadRequestException('Invalid collecting goal.');
    return planDto(
      await createCollectPlan(
        actor.profileId,
        goal.value as CollectingAnalysisRequest,
        raw.options
      )
    );
  });
}
export function handleGetCollectPlan(
  req: Operations.GetCollectPlanRequest
): Promise<Operations.GetCollectPlanResponse> {
  return executeMarketRequest(req, async (auth) =>
    planDto(
      await readCollectPlan(
        idSchema.parse(req.params.id),
        assertMarketActor(auth).profileId
      )
    )
  );
}
export function handleAdvanceCollectPlan(
  req: Operations.AdvanceCollectPlanRequest
): Promise<Operations.AdvanceCollectPlanResponse> {
  return executeMarketRequest(req, async (auth) =>
    planDto(
      await advanceCollectPlan(
        idSchema.parse(req.params.id),
        assertMarketActor(auth).profileId
      )
    )
  );
}
function projectionAccountDto(account: ProjectedAccountTdh) {
  return {
    ...account,
    tokens: account.tokens.map((token) => ({
      ...token,
      family: token.family as ApiCollectFamily
    })),
    boost_breakdown: Object.entries(account.boost_breakdown).map(
      ([id, boost]) => ({ id, ...boost })
    )
  };
}
export function handleProjectCollectPurchases(
  req: Operations.ProjectCollectPurchasesRequest
): Promise<Operations.ProjectCollectPurchasesResponse> {
  return executeMarketRequest(req, async (auth) => {
    const actor = assertMarketActor(auth);
    const body = z
      .object({
        profile_id: z.literal(actor.profileId),
        horizon_days: z.union([
          z.literal(1),
          z.literal(30),
          z.literal(90),
          z.literal(365)
        ]),
        acquisitions: z
          .array(
            z
              .object({
                asset_key: z.string().min(1).max(150),
                quantity: marketUintSchema,
                recipient: marketAddressSchema
              })
              .strict()
          )
          .min(1)
          .max(2000)
      })
      .strict()
      .parse(req.body);
    const result = await collectingService.projectPurchases(
      body as CollectingPurchaseProjectionRequest
    );
    return {
      ...result,
      baseline: projectionAccountDto(result.baseline),
      proposed: projectionAccountDto(result.proposed)
    };
  });
}
