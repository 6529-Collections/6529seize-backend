import { Transaction } from 'ethers';
import { ApiDropForgeRecoveryRequest } from '@/api/generated/models/ApiDropForgeRecoveryRequest';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import { LaunchChain } from '@/drop-forge/drop-forge.chain';
import {
  DropForgeRepository,
  addLaunchEvent,
  setLaunchState
} from '@/drop-forge/drop-forge.repository';
import {
  LaunchAction,
  LaunchRecord,
  LaunchRevisionConflict,
  LaunchSafetyError,
  RecoveryAttempt,
  RecoveryLedger
} from '@/drop-forge/drop-forge.types';
import { mirrorCompletion } from '@/drop-forge/drop-forge.completion';
import { sourceMatchesLaunch } from '@/drop-forge/drop-forge.plan';
import {
  RecoveryEvidence,
  validateRecoveryTransaction
} from '@/drop-forge/drop-forge.recovery-chain';
import { RequestContext } from '@/request.context';

type Reservation = { launch_id: string | null; action_id: string | null };
export function originalRecovery(action: LaunchAction): RecoveryLedger {
  if (!action.signed_tx || !action.hash)
    throw new LaunchSafetyError('No persisted signed transaction to recover');
  return {
    nonce: Transaction.from(action.signed_tx).nonce,
    cancel_requested: false,
    attempts: [
      {
        id: 'original',
        operation: 'ORIGINAL',
        requested_by: 'scheduler',
        requested_at: 0,
        signed_tx: action.signed_tx,
        hash: action.hash
      }
    ]
  };
}
export class DropForgeRecovery {
  private readonly walletId: string;
  constructor(
    private readonly config: DropForgeConfig,
    private readonly repository: DropForgeRepository,
    private readonly chain: LaunchChain,
    private readonly signer?: { sign(unsigned: string): Promise<string> }
  ) {
    this.walletId = `${config.chainId}:${config.signer.toLowerCase()}`;
  }
  async request(
    id: string,
    wallet: string,
    request: ApiDropForgeRecoveryRequest,
    ctx: RequestContext
  ): Promise<LaunchRecord> {
    return this.repository.wallet(
      this.walletId,
      async (pending, txCtx) => {
        const record = await this.repository.lockLaunch(id, txCtx);
        const action = record.data.actions.find(
          (it) => it.id === request.action_id
        );
        if (!action) throw new LaunchSafetyError('Unknown recovery action');
        if (
          record.data.chain_id !== this.config.chainId ||
          record.data.signer.toLowerCase() !==
            this.config.signer.toLowerCase() ||
          record.data.contract.toLowerCase() !==
            this.config.creator.toLowerCase()
        )
          throw new LaunchSafetyError(
            'Recovery scope differs from the frozen operational wallet'
          );
        const repeated = action.recovery_requests?.find(
          (it) => it.id === request.request_id
        );
        if (repeated) {
          if (
            repeated.operation !== request.operation ||
            repeated.expected_hash !== request.expected_hash ||
            repeated.transaction_hash !== request.transaction_hash ||
            repeated.wallet.toLowerCase() !== wallet.toLowerCase()
          )
            throw new LaunchSafetyError(
              'Recovery request ID was used for a different instruction'
            );
          return record;
        }
        if (
          record.revision !== request.revision ||
          action.hash !== request.expected_hash
        )
          throw new LaunchRevisionConflict(
            'Recovery action changed; reload and inspect the current transaction'
          );
        if (
          record.data.manual_lease ||
          record.data.manual_transactions?.some((it) => it.state === 'PENDING')
        )
          throw new LaunchSafetyError(
            'Reconcile manual work before recovering the operational signer'
          );
        if (
          request.operation === 'RETRY' ||
          request.operation === 'DELIVER_REMAINING'
        ) {
          await this.retry(record, action, pending, request.operation);
        } else {
          await this.queueReplacement(record, action, pending, wallet, request);
        }
        action.recovery_requests ??= [];
        action.recovery_requests.push({
          id: request.request_id,
          operation: request.operation,
          expected_hash: request.expected_hash,
          transaction_hash: request.transaction_hash,
          wallet
        });
        addLaunchEvent(
          record,
          `Claim #${record.data.claim_id}: Administrator requested ${request.operation} for ${action.id}; original transaction ${request.expected_hash}.`
        );
        await this.repository.save(record, txCtx);
        return record;
      },
      ctx
    );
  }
  private async queueReplacement(
    record: LaunchRecord,
    action: LaunchAction,
    pending: Reservation,
    wallet: string,
    request: ApiDropForgeRecoveryRequest
  ): Promise<void> {
    this.reserveRecovery(record, action, pending);
    action.recovery!.resume_scheduled ??= record.state !== 'PAUSED';
    if (request.operation === 'RECORD_WINNER') {
      await this.adoptReplacement(record, action, wallet, request);
    } else {
      if (request.operation !== 'SPEED_UP' && request.operation !== 'CANCEL')
        throw new LaunchSafetyError('Invalid replacement operation');
      if (request.operation === 'SPEED_UP') {
        if (action.recovery!.cancel_requested)
          throw new LaunchSafetyError(
            'Cancellation already requested; original action cannot be sped up'
          );
        await this.verifySpeedUp(record, action);
      } else {
        action.recovery!.attempts = action.recovery!.attempts.filter(
          (it) => it.signed_tx || it.operation !== 'SPEED_UP'
        );
      }
      if (action.recovery!.attempts.some((it) => !it.signed_tx))
        throw new LaunchSafetyError(
          'A recovery attempt is already being prepared'
        );
      action.recovery!.cancel_requested ||= request.operation === 'CANCEL';
      action.recovery!.attempts.push({
        id: request.request_id,
        operation: request.operation,
        requested_by: wallet,
        requested_at: Date.now()
      });
    }
    setLaunchState(
      record,
      'PAUSED',
      'Transaction recovery in progress; wallet remains reserved until the winning transaction is finalized'
    );
  }
  private async adoptReplacement(
    record: LaunchRecord,
    action: LaunchAction,
    wallet: string,
    request: ApiDropForgeRecoveryRequest
  ): Promise<void> {
    if (!request.transaction_hash || !this.chain.inspectRecovery)
      throw new LaunchSafetyError('Transaction evidence is required');
    const raw = await this.chain.inspectRecovery(request.transaction_hash);
    const tx = Transaction.from(raw);
    const operation = tx.data === '0x' ? 'CANCEL' : 'SPEED_UP';
    const attempt: RecoveryAttempt = {
      id: request.request_id,
      operation,
      requested_by: wallet,
      requested_at: Date.now(),
      signed_tx: raw,
      hash: tx.hash!
    };
    validateRecoveryTransaction(record.data, action, attempt);
    if (!action.recovery!.attempts.some((it) => it.hash === attempt.hash))
      action.recovery!.attempts.push(attempt);
    action.recovery!.cancel_requested ||= operation === 'CANCEL';
    if (operation === 'CANCEL')
      action.recovery!.attempts = action.recovery!.attempts.filter(
        (it) => it.signed_tx || it.operation !== 'SPEED_UP'
      );
  }
  private reserveRecovery(
    record: LaunchRecord,
    action: LaunchAction,
    pending: Reservation
  ): void {
    if (
      !['SIGNED', 'FAILED'].includes(action.state) ||
      action.recovery?.outcome
    )
      throw new LaunchSafetyError(
        'Action has no unresolved signed transaction'
      );
    if (
      pending.launch_id &&
      (pending.launch_id !== record.id || pending.action_id !== action.id)
    )
      throw new LaunchSafetyError(
        'Operational signer is reserved for another action'
      );
    action.recovery ??= originalRecovery(action);
    pending.launch_id = record.id;
    pending.action_id = action.id;
    action.state = 'SIGNED';
  }
  private async verifySpeedUp(
    record: LaunchRecord,
    action: LaunchAction
  ): Promise<void> {
    if (['CANCELLED', 'COMPLETED'].includes(record.state))
      throw new LaunchSafetyError(
        'Cancelled or completed launch cannot speed up an action'
      );
    if ((await this.chain.now()) >= action.deadline - 120)
      throw new LaunchSafetyError(
        'Execution window has closed; only cancellation is allowed'
      );
    const source = await this.repository.source(
      record.data.contract,
      record.data.claim_id,
      {}
    );
    if (!sourceMatchesLaunch(source, record.data))
      throw new LaunchSafetyError(
        'Frozen Craft/distribution changed; speed-up is prohibited'
      );
    await this.chain.verify(record.data, action);
  }
  private async retry(
    record: LaunchRecord,
    action: LaunchAction,
    pending: Reservation,
    operation: string
  ): Promise<void> {
    const recovery = action.recovery;
    if (
      pending.launch_id ||
      !recovery?.outcome ||
      recovery.outcome === 'EXECUTED' ||
      !['FAILED', 'CANCELLED'].includes(action.state)
    )
      throw new LaunchSafetyError(
        'Fresh nonce requires finalized cancellation or revert with outstanding work'
      );
    const winner = recovery.attempts.find(
      (it) => it.hash === recovery.winner_hash
    )!;
    const evidence = await this.chain.recoveryEvidence?.(
      record.data,
      action,
      winner
    );
    if (
      !evidence?.finalized ||
      evidence.receipt.blockHash !== recovery.block_hash
    )
      throw new LaunchSafetyError(
        'Recovery winner is no longer finalized and canonical; retry is prohibited'
      );
    const now = await this.chain.now();
    if (record.state === 'CANCELLED' || record.state === 'COMPLETED')
      throw new LaunchSafetyError(
        'Terminal launch requires manual delivery; automatic restart is prohibited'
      );
    if (operation === 'DELIVER_REMAINING') {
      if (action.kind !== 'AIRDROP' || now < record.data.phases.at(-1)!.end)
        throw new LaunchSafetyError(
          'Late delivery is only available for outstanding airdrops after all minting closes'
        );
      action.late_delivery = true;
      action.deadline = now + 86400;
    } else if (now >= action.deadline - 120)
      throw new LaunchSafetyError('Original execution window has closed');
    action.recovery_history = [...(action.recovery_history ?? []), recovery];
    delete action.recovery;
    delete action.signed_tx;
    delete action.unsigned_tx;
    delete action.hash;
    delete action.block_hash;
    delete action.block_number;
    action.state = 'PENDING';
    delete action.attempt_error;
    delete action.retry_at;
    delete action.window_reported;
    record.state = 'RUNNING';
    record.error = null;
  }
  async tick(launch: string): Promise<void> {
    try {
      const work = await this.repository.wallet(
        this.walletId,
        async (pending, ctx) => {
          if (pending.launch_id !== launch) return null;
          const record = await this.repository.lockLaunch(launch, ctx);
          const action = record.data.actions.find(
            (it) => it.id === pending.action_id
          )!;
          if (!action.recovery || action.recovery.outcome) return null;
          if (await this.settle(record, action, pending, ctx)) return null;
          const attempt = [...action.recovery.attempts]
            .reverse()
            .find((it) => !it.signed_tx);
          if (attempt) {
            if (record.data.events.some((it) => !it.drop_id)) return null;
            if (attempt.operation === 'ORIGINAL' || !this.chain.prepareRecovery)
              throw new LaunchSafetyError('Recovery signing is unavailable');
            if (attempt.operation === 'SPEED_UP')
              await this.verifySpeedUp(record, action);
            attempt.unsigned_tx ??= await this.chain.prepareRecovery(
              record.data,
              action,
              attempt.operation
            );
            await this.repository.save(record, ctx);
            return { record, action, attempt };
          }
          return null;
        },
        {}
      );
      if (work) await this.sign(work.record.id, work.action.id, work.attempt);
      await this.broadcast(launch);
    } catch (error) {
      await this.repository.change(
        launch,
        (record) => {
          setLaunchState(
            record,
            'BLOCKED',
            error instanceof LaunchSafetyError
              ? error.message
              : 'Recovery failed; transaction evidence and wallet reservation retained'
          );
        },
        {}
      );
    }
  }
  private async sign(
    id: string,
    actionId: string,
    attempt: RecoveryAttempt
  ): Promise<void> {
    if (!this.signer)
      throw new LaunchSafetyError('Recovery signer unavailable');
    const raw = await this.signer.sign(attempt.unsigned_tx!);
    const tx = Transaction.from(raw);
    if (
      tx.unsignedSerialized !== attempt.unsigned_tx ||
      tx.from?.toLowerCase() !== this.config.signer.toLowerCase()
    )
      throw new LaunchSafetyError(
        'KMS returned a different recovery transaction'
      );
    await this.repository.wallet(
      this.walletId,
      async (pending, ctx) => {
        if (pending.launch_id !== id || pending.action_id !== actionId) return;
        const record = await this.repository.lockLaunch(id, ctx);
        const action = record.data.actions.find((it) => it.id === actionId)!;
        const current = action.recovery?.attempts.find(
          (it) => it.id === attempt.id
        );
        if (!current || current.signed_tx || action.recovery?.outcome) return;
        if (current.operation === 'SPEED_UP') {
          if (action.recovery!.cancel_requested) return;
          await this.verifySpeedUp(record, action);
        }
        current.signed_tx = raw;
        current.hash = tx.hash!;
        validateRecoveryTransaction(record.data, action, current);
        addLaunchEvent(
          record,
          `Claim #${record.data.claim_id}: ${current.operation} transaction signed for ${action.id}: ${current.hash}.`
        );
        await this.repository.save(record, ctx);
      },
      {}
    );
  }
  private async broadcast(id: string): Promise<void> {
    const raw = await this.repository.wallet(
      this.walletId,
      async (pending, ctx) => {
        if (pending.launch_id !== id) return null;
        const record = await this.repository.lockLaunch(id, ctx);
        const action = record.data.actions.find(
          (it) => it.id === pending.action_id
        )!;
        if (await this.settle(record, action, pending, ctx)) return null;
        const recovery = action.recovery!;
        const attempt = [...recovery.attempts]
          .reverse()
          .find(
            (it) =>
              it.signed_tx &&
              (!recovery.cancel_requested || it.operation === 'CANCEL')
          );
        if (!attempt) return null;
        if (attempt.operation !== 'CANCEL')
          await this.verifySpeedUp(record, action);
        const tx = validateRecoveryTransaction(record.data, action, attempt);
        const fee = tx.maxFeePerGas ?? tx.gasPrice ?? BigInt(0);
        if (
          tx.gasLimit > this.config.maxGas ||
          fee > this.config.maxFee ||
          tx.gasLimit * fee > this.config.maxCost
        )
          throw new LaunchSafetyError(
            'Recovery broadcast exceeds current gas budget; receipt reconciliation continues'
          );
        return attempt.signed_tx!;
      },
      {}
    );
    if (raw) {
      try {
        await this.chain.broadcast(raw);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes('already known')
        )
          return;
        await this.repository.change(
          id,
          (record) => {
            setLaunchState(
              record,
              'BLOCKED',
              'Recovery RPC submission outcome is uncertain; signed evidence and wallet reservation retained'
            );
          },
          {}
        );
      }
    }
  }
  private async applyRecoveryEvidence(
    record: LaunchRecord,
    action: LaunchAction,
    pending: Reservation,
    ctx: RequestContext,
    attempt: RecoveryAttempt,
    evidence: RecoveryEvidence
  ): Promise<void> {
    const recovery = action.recovery!;
    recovery.outcome = recoveryOutcome(attempt, evidence);
    recovery.winner_hash = attempt.hash;
    recovery.supply = evidence.total;
    recovery.block_number = evidence.receipt.blockNumber;
    recovery.block_hash = evidence.receipt.blockHash;
    action.hash = attempt.hash;
    action.block_number = evidence.receipt.blockNumber;
    action.block_hash = evidence.receipt.blockHash;
    action.state = recoveredActionState(recovery.outcome);
    if (action.kind === 'METADATA' && action.state === 'CONFIRMED')
      record.data.metadata = action.target_metadata!;
    pending.launch_id = null;
    pending.action_id = null;
    await mirrorCompletion(record, ctx);
    setLaunchState(
      record,
      recovery.resume_scheduled ? 'RUNNING' : 'PAUSED',
      'Recovery finalized; later scheduled groups retain independent readiness checks, outstanding work is not replayed'
    );
    if (action.state !== 'CONFIRMED')
      action.attempt_error =
        'Recovery finalized without delivery; outstanding allocations require operator recovery';
    addLaunchEvent(
      record,
      `Claim #${record.data.claim_id}: Recovery ${recovery.outcome} for ${action.id}; winning transaction ${attempt.hash}; ${evidence.total} total minted.`,
      recovery.outcome !== 'EXECUTED'
    );
    await this.repository.save(record, ctx);
  }

  private async settle(
    record: LaunchRecord,
    action: LaunchAction,
    pending: Reservation,
    ctx: RequestContext
  ): Promise<boolean> {
    if (!this.chain.recoveryEvidence)
      throw new LaunchSafetyError('Recovery evidence verification unavailable');
    const recovery = action.recovery!;
    for (const attempt of recovery.attempts) {
      if (!attempt.hash) continue;
      const evidence = await this.chain.recoveryEvidence(
        record.data,
        action,
        attempt
      );
      if (!evidence) continue;
      if (
        !evidence.finalized ||
        evidence.receipt.confirmations < this.config.confirmations
      )
        return true;
      if (evidence.receipt.status !== 0 && evidence.receipt.status !== 1)
        throw new LaunchSafetyError(
          'Winning receipt has an unknown execution status'
        );
      await this.applyRecoveryEvidence(
        record,
        action,
        pending,
        ctx,
        attempt,
        evidence
      );
      return true;
    }
    return false;
  }
}

function recoveryOutcome(
  attempt: RecoveryAttempt,
  evidence: RecoveryEvidence
): NonNullable<RecoveryLedger['outcome']> {
  if (evidence.receipt.status === 0) return 'REVERTED';
  return attempt.operation === 'CANCEL' ? 'CANCELLED' : 'EXECUTED';
}

function recoveredActionState(
  outcome: NonNullable<RecoveryLedger['outcome']>
): LaunchAction['state'] {
  if (outcome === 'EXECUTED') return 'CONFIRMED';
  return outcome === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
}
