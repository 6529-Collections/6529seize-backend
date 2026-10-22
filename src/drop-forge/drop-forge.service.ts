import { launchGroup } from '@/drop-forge/drop-forge.groups';
import { ApiDropForgeRecovery } from '@/api/generated/models/ApiDropForgeRecovery';
import { ApiDropForgeRecoveryAttempt } from '@/api/generated/models/ApiDropForgeRecoveryAttempt';
import { originalRecovery } from '@/drop-forge/drop-forge.recovery';
import { ApiDropForgeControlRequest } from '@/api/generated/models/ApiDropForgeControlRequest';
import { ApiDropForgeLaunch } from '@/api/generated/models/ApiDropForgeLaunch';
import { ApiDropForgePlanRequest } from '@/api/generated/models/ApiDropForgePlanRequest';
import { getClaimsAdminWallets } from '@/api/seize-settings';
import { EthereumLaunchChain } from '@/drop-forge/drop-forge.chain';
import { getDropForgeConfig } from '@/drop-forge/drop-forge.config';
import {
  buildLaunchPlan,
  sourceMatchesLaunch
} from '@/drop-forge/drop-forge.plan';
import {
  dropForgeRepository,
  launchId,
  setLaunchState
} from '@/drop-forge/drop-forge.repository';
import {
  LaunchRecord,
  LaunchSafetyError,
  LaunchRevisionConflict,
  assertPhaseScopedPlan
} from '@/drop-forge/drop-forge.types';
import { ForbiddenException, NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dropForgePreparationRepository } from '@/drop-forge/drop-forge.preparation.repository';
import { validateForgeReporting } from '@/drop-forge/drop-forge.reporting-access';

export function mapLaunch(record: LaunchRecord): ApiDropForgeLaunch {
  return {
    metadata_location: record.data.metadata,
    manual_pending:
      !!record.data.manual_lease ||
      !!record.data.manual_transactions?.some((it) => it.state === 'PENDING'),
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
        label,
        kind,
        state,
        phase,
        due,
        deadline,
        recipients,
        hash,
        block_number,
        recovery,
        remaining_recipients,
        attempt_count,
        attempt_error,
        retry_at,
        observed
      }) => {
        const inspection =
          recovery ??
          (['SIGNED', 'FAILED'].includes(state) && hash
            ? originalRecovery(
                record.data.actions.find((action) => action.id === id)!
              )
            : undefined);
        return {
          recovery: inspection
            ? {
                nonce: inspection.nonce,
                cancel_requested: inspection.cancel_requested,
                winner_hash: inspection.winner_hash,
                supply: inspection.supply,
                block_number: inspection.block_number,
                block_hash: inspection.block_hash,
                outcome: inspection.outcome as ApiDropForgeRecovery['outcome'],
                attempts: inspection.attempts.map(
                  ({ id, operation, requested_by, requested_at, hash }) => ({
                    id,
                    operation:
                      operation as ApiDropForgeRecoveryAttempt['operation'],
                    requested_by,
                    requested_at,
                    hash: hash ?? null
                  })
                ),
                allocations: remaining_recipients ?? recipients
              }
            : undefined,
          id,
          group: launchGroup(
            record.data.actions.find((action) => action.id === id)!
          ),
          attempt_count: attempt_count ?? 0,
          attempt_error: attempt_error ?? null,
          retry_at: retry_at ?? null,
          observed: observed ?? false,
          label,
          kind: kind as ApiDropForgeLaunch['actions'][number]['kind'],
          state: state as ApiDropForgeLaunch['actions'][number]['state'],
          phase,
          due,
          deadline,
          recipients: recipients.length,
          hash: hash ?? null,
          block_number: block_number ?? null
        };
      }
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
function pauseLaunch(record: LaunchRecord): void {
  if (!['ARMED', 'RUNNING', 'BLOCKED'].includes(record.state))
    throw new LaunchSafetyError(
      'Control is not valid for the current launch state'
    );
  setLaunchState(
    record,
    'PAUSED',
    'Launch paused; previously signed transactions may still mine and will be reconciled.'
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
          pauseLaunch(record);
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
        assertPhaseScopedPlan(record.data);
        const source = await dropForgeRepository.source(contract, claim, txCtx);
        if (!sourceMatchesLaunch(source, record.data))
          throw new LaunchSafetyError(
            'Distribution or metadata changed; recreate the draft before arming'
          );
        await dropForgeRepository.assertPrepared(record.data, txCtx);
        if (!record.data.actions.some((action) => action.state !== 'CONFIRMED'))
          throw new LaunchSafetyError('No remaining launch action');
        if (arming) {
          const next = record.data.actions[0];
          const now = await new EthereumLaunchChain(config).now();
          if (now >= next.due || now >= next.deadline - 120)
            throw new LaunchSafetyError(
              'Execution window is too close or has passed'
            );
        }
        setLaunchState(
          record,
          arming ? 'ARMED' : 'RUNNING',
          arming
            ? 'Launch armed with a frozen distribution and schedule.'
            : 'Launch resumed after operator review.'
        );
      },
      controlCtx,
      true
    );
  if (request.operation === 'ARM') {
    await validateForgeReporting(config, ctx);
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
