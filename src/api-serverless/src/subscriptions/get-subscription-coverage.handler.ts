import { ApiSubscriptionCoverage } from '@/api/generated/models/ApiSubscriptionCoverage';
import { GetSubscriptionCoverageRequest } from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { subscriptionCoverageReconciliationService } from '@/subscription-coverage/subscription-coverage-reconciliation.service';
import { Timer } from '@/time';
import * as Joi from 'joi';
import { mapSubscriptionCoverageToApi } from './subscription-coverage.api-mapper';

interface GetSubscriptionCoveragePathParams {
  readonly consolidation_key: string;
}

const GetSubscriptionCoveragePathParamsSchema: Joi.ObjectSchema<GetSubscriptionCoveragePathParams> =
  Joi.object({
    consolidation_key: Joi.string()
      .trim()
      .lowercase()
      .min(1)
      .max(200)
      .required()
  });

export async function handleGetSubscriptionCoverage(
  req: GetSubscriptionCoverageRequest
): Promise<ApiSubscriptionCoverage> {
  const { consolidation_key: consolidationKey } = getValidatedByJoiOrThrow(
    req.params,
    GetSubscriptionCoveragePathParamsSchema
  );
  const timer = Timer.getFromRequest(req);
  const coverage =
    await subscriptionCoverageReconciliationService.calculateCoverage(
      consolidationKey,
      { timer }
    );
  return mapSubscriptionCoverageToApi(coverage);
}
