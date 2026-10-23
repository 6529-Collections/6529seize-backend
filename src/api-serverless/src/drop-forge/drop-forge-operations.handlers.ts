import * as Joi from 'joi';
import { isAddress } from 'ethers';
import { getAuthenticatedWalletOrNull } from '@/api/auth/auth';
import { authenticateSubscriptionsAdmin } from '@/api/subscriptions/api.subscriptions.allowlist';
import { assertLaunchAccess, mapLaunch } from '@/drop-forge/drop-forge.service';
import {
  readyLaunch,
  requestMetadataUpdate,
  coordinateManual
} from '@/drop-forge/drop-forge.operations';
import {
  getDropForgeConfig,
  recoveryEnabled
} from '@/drop-forge/drop-forge.config';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import { decodeProcessResult } from '@/drop-forge/drop-forge.workflow';
import { mapJob } from '@/api/drop-forge/drop-forge.handlers';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import {
  BadRequestException,
  ForbiddenException,
  CustomApiCompliantException
} from '@/exceptions';
import { Timer } from '@/time';
import {
  ReadyDropForgeLaunchRequest,
  UpdateDropForgeMetadataRequest,
  CoordinateDropForgeManualActionRequest,
  GetLatestDropForgeProcessRequest,
  GetDropForgeCompletedListRequest
} from '@/api/generated/routes/operations';
import { ApiDropForgeLaunch } from '@/api/generated/models/ApiDropForgeLaunch';
import { ApiDropForgeJob } from '@/api/generated/models/ApiDropForgeJob';
import { ApiDropForgeManualRequest } from '@/api/generated/models/ApiDropForgeManualRequest';
import { ApiDropForgeManualResponse } from '@/api/generated/models/ApiDropForgeManualResponse';
import { ApiDropForgeListPage } from '@/api/generated/models/ApiDropForgeListPage';
const params = Joi.object<{ contract: string; claim_id: number }>({
  contract: Joi.string()
    .lowercase()
    .custom((value, helpers) =>
      isAddress(value) ? value : helpers.error('any.invalid')
    )
    .required(),
  claim_id: Joi.number().integer().min(1).required()
});
async function execute<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LaunchSafetyError)
      throw new BadRequestException(error.message);
    throw error;
  }
}
async function craftAccess(
  req: ReadyDropForgeLaunchRequest | UpdateDropForgeMetadataRequest,
  contract: string
): Promise<void> {
  if (contract.toLowerCase() !== getDropForgeConfig().creator.toLowerCase())
    throw new ForbiddenException('Contract is outside Drop Forge scope');
  if (authenticateSubscriptionsAdmin(req)) return;
  await assertLaunchAccess(getAuthenticatedWalletOrNull(req), contract);
}
export async function readyDropForgeLaunch(
  req: ReadyDropForgeLaunchRequest
): Promise<ApiDropForgeLaunch> {
  return execute(async () => {
    const { contract, claim_id } = getValidatedByJoiOrThrow(req.params, params);
    await craftAccess(req, contract);
    return mapLaunch(
      await readyLaunch(claim_id, { timer: Timer.getFromRequest(req) })
    );
  });
}
export async function updateDropForgeMetadata(
  req: UpdateDropForgeMetadataRequest
): Promise<ApiDropForgeLaunch> {
  return execute(async () => {
    const { contract, claim_id } = getValidatedByJoiOrThrow(req.params, params);
    await craftAccess(req, contract);
    return mapLaunch(
      await requestMetadataUpdate(claim_id, {
        timer: Timer.getFromRequest(req)
      })
    );
  });
}
export async function coordinateDropForgeManualAction(
  req: CoordinateDropForgeManualActionRequest
): Promise<ApiDropForgeManualResponse> {
  return execute(async () => {
    const { contract, claim_id } = getValidatedByJoiOrThrow(req.params, params);
    const body = getValidatedByJoiOrThrow(
      req.body,
      Joi.object<ApiDropForgeManualRequest>({
        action: Joi.string().valid(
          'ARTIST_AIRDROP',
          'TEAM_AIRDROP',
          'PHASE0_AIRDROP',
          'PHASE1_AIRDROP',
          'PHASE2_AIRDROP',
          'PUBLIC_PHASE_AIRDROP',
          'RESEARCH_AIRDROP',
          'PAY_ARTIST'
        ),
        operation: Joi.string().valid('BEGIN', 'SUBMIT', 'CANCEL').required(),
        lease_id: Joi.string().guid(),
        hash: Joi.string()
          .pattern(/^0x[\da-fA-F]{64}$/)
          .when('operation', {
            is: 'SUBMIT',
            then: Joi.required(),
            otherwise: Joi.forbidden()
          })
      })
    );
    // The legacy manual UI still operates when the new automation is disabled.
    if (
      !recoveryEnabled() ||
      contract.toLowerCase() !== getDropForgeConfig().creator.toLowerCase()
    )
      return { lease_id: null };
    const wallet = getAuthenticatedWalletOrNull(req);
    await assertLaunchAccess(wallet, contract);
    return {
      lease_id: await coordinateManual(
        claim_id,
        wallet!,
        body.operation,
        body.lease_id,
        body.hash,
        body.action,
        { timer: Timer.getFromRequest(req) }
      )
    };
  });
}
export async function getLatestDropForgeProcess(
  req: GetLatestDropForgeProcessRequest
): Promise<ApiDropForgeJob[]> {
  if (!authenticateSubscriptionsAdmin(req))
    throw new ForbiddenException('Distribution administrator access required');
  const { contract, claim_id } = getValidatedByJoiOrThrow(req.params, params);
  const query = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<{ plan_id?: string }>({ plan_id: Joi.string().max(100) })
  );
  const job = await dropForgeJobsRepository.latest(
    contract,
    claim_id,
    query.plan_id,
    { timer: Timer.getFromRequest(req) }
  );
  return job ? [mapJob({ ...job, result: null })] : [];
}
export async function getDropForgeCompletedList(
  req: GetDropForgeCompletedListRequest
): Promise<ApiDropForgeListPage> {
  if (!authenticateSubscriptionsAdmin(req))
    throw new ForbiddenException('Distribution administrator access required');
  const path = getValidatedByJoiOrThrow(
    req.params,
    Joi.object<{
      job_id: string;
      phase_id: string;
      list: 'airdrops' | 'airdrops_unconsolidated' | 'allowlists';
    }>({
      job_id: Joi.string().guid().required(),
      phase_id: Joi.string().max(100).required(),
      list: Joi.string()
        .valid('airdrops', 'airdrops_unconsolidated', 'allowlists')
        .required()
    })
  );
  const { offset } = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<{ offset: number }>({
      offset: Joi.number().integer().min(0).default(0)
    })
  );
  const job = await dropForgeJobsRepository.find(path.job_id, {
    timer: Timer.getFromRequest(req)
  });
  if (job.kind !== 'PROCESS_ALL' || job.status !== 'COMPLETED')
    throw new CustomApiCompliantException(
      409,
      'Lists become available after processing and finalization complete'
    );
  const list = decodeProcessResult(job)?.lists[path.phase_id]?.[path.list];
  if (!list) throw new BadRequestException('Unknown completed list');
  const next = offset + 1000;
  return {
    rows: list.slice(offset, next),
    next_offset: next < list.length ? next : null
  };
}
