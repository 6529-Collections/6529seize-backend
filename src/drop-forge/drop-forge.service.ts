import { ApiDropForgeControlRequest } from '@/api/generated/models/ApiDropForgeControlRequest';
import { ApiDropForgeLaunch } from '@/api/generated/models/ApiDropForgeLaunch';
import { ApiDropForgePlanRequest } from '@/api/generated/models/ApiDropForgePlanRequest';
import { getClaimsAdminWallets } from '@/api/seize-settings';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import { getDropForgeConfig } from '@/drop-forge/drop-forge.config';
import {
  buildLaunchPlan,
  hashLaunchSource
} from '@/drop-forge/drop-forge.plan';
import {
  dropForgeRepository,
  launchId,
  setLaunchState
} from '@/drop-forge/drop-forge.repository';
import {
  LaunchRecord,
  LaunchSafetyError,
  LaunchRevisionConflict
} from '@/drop-forge/drop-forge.types';
import { ForbiddenException, NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dropForgePreparationRepository } from '@/drop-forge/drop-forge.preparation.repository';

export function mapLaunch(record: LaunchRecord): ApiDropForgeLaunch {
  return {
    id: record.id,
    revision: record.revision,
    state: record.state as ApiDropForgeLaunch['state'],
    error: record.error,
    chain_id: record.data.chain_id,
    contract: record.data.contract,
    claim_id: record.data.claim_id,
    signer: record.data.signer,
    payment_receiver: record.data.receiver,
    distribution_hash: record.data.distribution_hash,
    phases: record.data.phases,
    actions: record.data.actions.map(
      ({
        id,
        kind,
        state,
        phase,
        due,
        deadline,
        recipients,
        hash,
        block_number
      }) => ({
        id,
        kind: kind as ApiDropForgeLaunch['actions'][number]['kind'],
        state: state as ApiDropForgeLaunch['actions'][number]['state'],
        phase,
        due,
        deadline,
        recipients: recipients.length,
        hash: hash ?? null,
        block_number: block_number ?? null
      })
    ),
    updated_at: record.updated_at
  };
}
export async function assertLaunchAccess(
  wallet: string | null,
  contract: string
): Promise<void> {
  const config = getDropForgeConfig();
  if (config.creator.toLowerCase() !== contract.toLowerCase())
    throw new ForbiddenException(
      'Contract is outside the configured Drop Forge scope'
    );
  if (!wallet)
    throw new ForbiddenException('Claims administrator access required');
  if (
    getClaimsAdminWallets().some(
      (admin) => admin.toLowerCase() === wallet.toLowerCase()
    )
  )
    return;
  if (!(await new EthereumLaunchChain(config).assertAdmin(wallet)))
    throw new ForbiddenException('Claims administrator access required');
}
export async function getLaunch(
  contract: string,
  claim: number,
  ctx: RequestContext
): Promise<LaunchRecord> {
  const record = await dropForgeRepository.find(
    launchId(getDropForgeConfig().chainId, contract, claim),
    ctx
  );
  if (!record) throw new NotFoundException('Launch not found');
  return record;
}
export async function putLaunch(
  contract: string,
  claim: number,
  request: ApiDropForgePlanRequest,
  ctx: RequestContext
): Promise<LaunchRecord> {
  const config = getDropForgeConfig();
  const source = await dropForgeRepository.source(contract, claim, ctx);
  const data = buildLaunchPlan(
    config,
    claim,
    request,
    source,
    Math.floor(Date.now() / 1000)
  );
  return dropForgeRepository.putDraft(
    launchId(config.chainId, contract, claim),
    request.revision,
    data,
    ctx
  );
}
export async function controlLaunch(
  contract: string,
  claim: number,
  request: ApiDropForgeControlRequest,
  ctx: RequestContext
): Promise<LaunchRecord> {
  const config = getDropForgeConfig();
  const id = launchId(config.chainId, contract, claim);
  const applyControl = (controlCtx: RequestContext) =>
    dropForgeRepository.change(
      id,
      async (record, txCtx) => {
        if (record.revision !== request.revision)
          throw new LaunchRevisionConflict(
            'Launch revision changed; reload before applying control'
          );
        const terminal =
          record.state === 'COMPLETED' || record.state === 'CANCELLED';
        if (terminal)
          throw new LaunchSafetyError(
            'Terminal launch ledgers cannot be restarted'
          );
        if (request.operation === 'CANCEL') {
          setLaunchState(
            record,
            'CANCELLED',
            'Launch cancelled; previously signed transactions may still mine and will be reconciled.'
          );
          return;
        }
        if (request.operation === 'PAUSE') {
          setLaunchState(
            record,
            'PAUSED',
            'Launch paused; previously signed transactions may still mine and will be reconciled.'
          );
          return;
        }
        const arming = request.operation === 'ARM';
        if (
          arming
            ? record.state !== 'DRAFT'
            : !['PAUSED', 'BLOCKED'].includes(record.state)
        )
          throw new LaunchSafetyError(
            'Control is not valid for the current launch state'
          );
        if (record.data.actions.some((action) => action.state === 'FAILED'))
          throw new LaunchSafetyError(
            'A reverted transaction requires manual recovery; automatic replay is prohibited'
          );
        const source = await dropForgeRepository.source(contract, claim, txCtx);
        if (hashLaunchSource(source) !== record.data.distribution_hash)
          throw new LaunchSafetyError(
            'Distribution or metadata changed; recreate the draft before arming'
          );
        await dropForgeRepository.assertPrepared(record.data, txCtx);
        const next = record.data.actions.find(
          (action) => action.state !== 'CONFIRMED'
        );
        if (!next) throw new LaunchSafetyError('No remaining launch action');
        const chain = new EthereumLaunchChain(config);
        const now = await chain.now();
        if (now >= next.deadline - 120 || (arming && now >= next.due))
          throw new LaunchSafetyError(
            'Execution window is too close or has passed'
          );
        // Reserved or signed intent is immutable. Reconciliation must determine its
        // outcome before another nonce can be used; resuming never replaces it.
        if (next.state === 'PENDING') await chain.verify(record.data, next);
        setLaunchState(
          record,
          arming ? 'ARMED' : 'RUNNING',
          arming
            ? 'Launch armed with a frozen distribution and schedule.'
            : 'Launch resumed after operator review.'
        );
      },
      controlCtx
    );
  if (request.operation === 'ARM') {
    await dropForgePreparationRepository.run(
      contract,
      claim,
      async (_, preparationCtx) => applyControl(preparationCtx),
      ctx
    );
  } else {
    await applyControl(ctx);
  }
  return getLaunch(contract, claim, ctx);
}
