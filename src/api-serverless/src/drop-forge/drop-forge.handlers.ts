import * as Joi from 'joi';
import { getAuthenticatedWalletOrNull } from '@/api/auth/auth';
import { ApiDropForgeLaunch } from '@/api/generated/models/ApiDropForgeLaunch';
import { ApiDropForgeJob } from '@/api/generated/models/ApiDropForgeJob';
import { ApiDropForgePlanRequest } from '@/api/generated/models/ApiDropForgePlanRequest';
import { ApiDropForgeControlRequest } from '@/api/generated/models/ApiDropForgeControlRequest';
import { ApiDropForgeJobRequest } from '@/api/generated/models/ApiDropForgeJobRequest';
import {
  GetDropForgeLaunchRequest,
  PutDropForgeLaunchRequest,
  ControlDropForgeLaunchRequest,
  CreateDropForgeDistributionJobRequest,
  GetDropForgeDistributionJobRequest
} from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { authenticateSubscriptionsAdmin } from '@/api/subscriptions/api.subscriptions.allowlist';
import {
  assertLaunchAccess,
  controlLaunch,
  getLaunch,
  mapLaunch,
  putLaunch
} from '@/drop-forge/drop-forge.service';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import {
  LaunchSafetyError,
  LaunchRevisionConflict
} from '@/drop-forge/drop-forge.types';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { Timer } from '@/time';
import { isAddress } from 'ethers';

const paramsSchema = Joi.object<{ contract: string; claim_id: number }>({
  contract: Joi.string()
    .lowercase()
    .custom((value, helpers) =>
      isAddress(value) ? value : helpers.error('any.invalid')
    )
    .required(),
  claim_id: Joi.number().integer().min(1).max(0x7fffffff).required()
});
const planSchema = Joi.object<ApiDropForgePlanRequest>({
  revision: Joi.number().integer().min(0).required(),
  initialize_at: Joi.number().integer().min(1).required(),
  include_artist_airdrops: Joi.boolean().strict().required(),
  include_team_airdrops: Joi.boolean().strict().required(),
  phases: Joi.array()
    .min(1)
    .max(20)
    .items(
      Joi.object({
        name: Joi.string().trim().min(1).max(100).required(),
        start: Joi.number().integer().min(1).required(),
        end: Joi.number().integer().min(1).required(),
        price_wei: Joi.string().pattern(/^\d+$/).max(78).required(),
        is_public: Joi.boolean().strict().required()
      })
    )
    .required()
});
const controlSchema = Joi.object<ApiDropForgeControlRequest>({
  revision: Joi.number().integer().min(1).required(),
  operation: Joi.string().valid('ARM', 'PAUSE', 'RESUME', 'CANCEL').required()
});
const jobSchema = Joi.object<ApiDropForgeJobRequest>({
  request_id: Joi.string().guid().required(),
  kind: Joi.string().valid('PHASE', 'FINALIZE').required(),
  plan_id: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]+$/)
    .max(100)
    .when('kind', {
      is: 'PHASE',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    }),
  phase_id: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]+$/)
    .max(100)
    .when('kind', {
      is: 'PHASE',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    })
});

async function apiCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LaunchRevisionConflict)
      throw new CustomApiCompliantException(409, error.message);
    if (error instanceof LaunchSafetyError)
      throw new BadRequestException(error.message);
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'CALL_EXCEPTION'].includes(
        error.code
      )
    )
      throw new CustomApiCompliantException(
        503,
        'On-chain verification unavailable; retry after checking RPC configuration'
      );
    throw error;
  }
}
export async function getDropForgeLaunch(
  req: GetDropForgeLaunchRequest
): Promise<ApiDropForgeLaunch> {
  return apiCall(async () => {
    const { contract, claim_id } = getValidatedByJoiOrThrow(
      req.params,
      paramsSchema
    );
    await assertLaunchAccess(getAuthenticatedWalletOrNull(req), contract);
    return mapLaunch(
      await getLaunch(contract, claim_id, { timer: Timer.getFromRequest(req) })
    );
  });
}
export async function putDropForgeLaunch(
  req: PutDropForgeLaunchRequest
): Promise<ApiDropForgeLaunch> {
  return apiCall(async () => {
    const { contract, claim_id } = getValidatedByJoiOrThrow(
      req.params,
      paramsSchema
    );
    const body = getValidatedByJoiOrThrow(req.body, planSchema);
    await assertLaunchAccess(getAuthenticatedWalletOrNull(req), contract);
    return mapLaunch(
      await putLaunch(contract, claim_id, body, {
        timer: Timer.getFromRequest(req)
      })
    );
  });
}
export async function controlDropForgeLaunch(
  req: ControlDropForgeLaunchRequest
): Promise<ApiDropForgeLaunch> {
  return apiCall(async () => {
    const { contract, claim_id } = getValidatedByJoiOrThrow(
      req.params,
      paramsSchema
    );
    const body = getValidatedByJoiOrThrow(req.body, controlSchema);
    await assertLaunchAccess(getAuthenticatedWalletOrNull(req), contract);
    return mapLaunch(
      await controlLaunch(contract, claim_id, body, {
        timer: Timer.getFromRequest(req)
      })
    );
  });
}
function mapJob(job: DropForgeJobEntity): ApiDropForgeJob {
  let resultJson: string | null = null;
  if (job.result)
    resultJson =
      typeof job.result === 'string' ? job.result : JSON.stringify(job.result);
  return {
    id: job.id,
    contract: job.contract,
    claim_id: Number(job.claim_id),
    kind: job.kind as ApiDropForgeJob['kind'],
    status: job.status as ApiDropForgeJob['status'],
    error: job.error,
    result_json: resultJson,
    updated_at: Number(job.updated_at)
  };
}
export async function createDropForgeDistributionJob(
  req: CreateDropForgeDistributionJobRequest
): Promise<ApiDropForgeJob> {
  return apiCall(async () => {
    if (!authenticateSubscriptionsAdmin(req))
      throw new ForbiddenException(
        'Distribution administrator access required'
      );
    const { contract, claim_id } = getValidatedByJoiOrThrow(
      req.params,
      paramsSchema
    );
    const body = getValidatedByJoiOrThrow(req.body, jobSchema);
    const job = Object.assign(new DropForgeJobEntity(), {
      id: body.request_id,
      contract,
      claim_id,
      kind: body.kind,
      plan_id: body.plan_id ?? null,
      phase_id: body.phase_id ?? null,
      updated_at: Date.now()
    });
    return mapJob(
      await dropForgeJobsRepository.create(job, {
        timer: Timer.getFromRequest(req)
      })
    );
  });
}
export async function getDropForgeDistributionJob(
  req: GetDropForgeDistributionJobRequest
): Promise<ApiDropForgeJob> {
  if (!authenticateSubscriptionsAdmin(req))
    throw new ForbiddenException('Distribution administrator access required');
  const { job_id } = getValidatedByJoiOrThrow(
    req.params,
    Joi.object<{ job_id: string }>({ job_id: Joi.string().guid().required() })
  );
  return mapJob(
    await dropForgeJobsRepository.find(job_id, {
      timer: Timer.getFromRequest(req)
    })
  );
}
