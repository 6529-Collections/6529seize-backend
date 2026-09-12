import { z } from 'zod';
import * as Operations from '@/api/generated/routes/operations';
import {
  ApiCollectRule,
  ApiCollectRuleModeEnum,
  ApiCollectRuleStateEnum
} from '@/api/generated/models/ApiCollectRule';
import { executeMarketRequest } from '@/api/marketplace/marketplace.http';
import { assertMarketActor } from '@/api/marketplace/marketplace.service';
import { collectingRulesService } from '@/collecting/collecting-rules.service';
import { CollectingRule } from '@/collecting/collecting-rules.types';
import {
  marketAddressSchema,
  marketUintSchema
} from '@/marketplace/seaport.schema';
import { marketPrepareSchema } from '@/marketplace/market-preparation';
import {
  createRule,
  prepareRule,
  reconcileRule,
  requireRuleWallet
} from './collect-rules.service';

const id = z.string().uuid();
const definitionSchema = z
  .object({
    profile_id: z.string().min(1).max(100),
    funding_wallet: marketAddressSchema,
    recipient: marketAddressSchema,
    plan_id: id.nullable(),
    analysis_id: z.string().max(100).nullable(),
    targets: z
      .array(
        z
          .object({
            asset_key: z.string().min(1).max(150),
            target_quantity: marketUintSchema,
            maximum_unit_price_wei: marketUintSchema
          })
          .strict()
      )
      .min(1)
      .max(2000),
    max_total_cost_wei: marketUintSchema,
    max_gas_reserve_wei: marketUintSchema,
    expires_at: z.number().int().positive(),
    max_actions: z.number().int().min(1).max(2000)
  })
  .strict();
function ruleDto(rule: CollectingRule): ApiCollectRule {
  return {
    ...rule,
    mode: rule.mode as ApiCollectRuleModeEnum,
    state: rule.state as ApiCollectRuleStateEnum
  };
}

export function handleCreateCollectRule(
  req: Operations.CreateCollectRuleRequest
): Promise<Operations.CreateCollectRuleResponse> {
  return executeMarketRequest(req, async (auth) =>
    ruleDto(
      await createRule(
        auth,
        definitionSchema.parse(req.body),
        id.parse(req.get('Idempotency-Key'))
      )
    )
  );
}
export function handleGetCollectRules(
  req: Operations.GetCollectRulesRequest
): Promise<Operations.GetCollectRulesResponse> {
  return executeMarketRequest(req, async (auth) => {
    const rules = await collectingRulesService.list(
      assertMarketActor(auth).profileId,
      100
    );
    return { rules: rules.map(ruleDto), complete: rules.length < 100 };
  });
}
export function handleGetCollectRule(
  req: Operations.GetCollectRuleRequest
): Promise<Operations.GetCollectRuleResponse> {
  return executeMarketRequest(req, async (auth) =>
    ruleDto(
      await collectingRulesService.get(
        id.parse(req.params.id),
        assertMarketActor(auth).profileId
      )
    )
  );
}
export function handlePauseCollectRule(
  req: Operations.PauseCollectRuleRequest
): Promise<Operations.PauseCollectRuleResponse> {
  return executeMarketRequest(req, async (auth) => {
    const actor = assertMarketActor(auth),
      rule = await requireRuleWallet(id.parse(req.params.id), actor);
    const body = z
      .object({
        expected_revision: z.number().int().positive(),
        paused: z.boolean()
      })
      .strict()
      .parse(req.body);
    return ruleDto(
      await collectingRulesService.setPaused(
        rule.id,
        actor.profileId,
        body.expected_revision,
        body.paused
      )
    );
  });
}
export function handlePrepareCollectRule(
  req: Operations.PrepareCollectRuleRequest
): Promise<Operations.PrepareCollectRuleResponse> {
  return executeMarketRequest(req, async (auth) => {
    const body = z
      .object({
        expected_revision: z.number().int().positive(),
        trade: marketPrepareSchema
      })
      .strict()
      .parse(req.body);
    const result = await prepareRule(
      id.parse(req.params.id),
      auth,
      body,
      id.parse(req.get('Idempotency-Key'))
    );
    return { ...result, rule: ruleDto(result.rule) };
  });
}
export function handleReconcileCollectRule(
  req: Operations.ReconcileCollectRuleRequest
): Promise<Operations.ReconcileCollectRuleResponse> {
  return executeMarketRequest(req, async (auth) =>
    ruleDto(await reconcileRule(id.parse(req.params.id), auth))
  );
}
