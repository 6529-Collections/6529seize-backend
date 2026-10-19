import {
  dueActions,
  reportActionFailure,
  reportActionSkip
} from '@/drop-forge/drop-forge.groups';
import {
  DropForgeRecovery,
  originalRecovery
} from '@/drop-forge/drop-forge.recovery';
import { Transaction } from 'ethers';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import { LaunchChain, ChainReceipt } from '@/drop-forge/drop-forge.chain';
import { mirrorCompletion } from '@/drop-forge/drop-forge.completion';
import { reconcileManual } from '@/drop-forge/drop-forge.manual';
import { sourceMatchesLaunch } from '@/drop-forge/drop-forge.plan';
import {
  addLaunchEvent,
  DropForgeRepository,
  setLaunchState
} from '@/drop-forge/drop-forge.repository';
import {
  LaunchAction,
  LaunchRecord,
  LaunchSafetyError,
  DROP_FORGE_PLAN_VERSION,
  assertPhaseScopedPlan
} from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { isResearchAirdrop } from '@/drop-forge/drop-forge.research';

type Work = { record: LaunchRecord; action: LaunchAction };
type PendingSigner = { launch_id: string | null; action_id: string | null };
const runnable = (record: LaunchRecord) =>
  ['ARMED', 'RUNNING'].includes(record.state);

function matchesObservedProof(
  record: LaunchRecord,
  action: LaunchAction,
  proof: NonNullable<LaunchRecord['data']['manual_transactions']>[number]
): boolean {
  if (proof.state !== 'CONFIRMED') return false;
  if (isResearchAirdrop(action))
    return proof.action === 'RESEARCH_AIRDROP' && proof.method === 'airdrop';
  const method =
    action.kind === 'INITIALIZE' ? 'initializeClaim' : 'updateClaim';
  return (
    proof.phase === action.phase &&
    proof.method === method &&
    proof.metadata === (action.target_metadata ?? record.data.metadata)
  );
}

export class DropForgeWorker {
  constructor(
    private readonly config: DropForgeConfig,
    private readonly repository: DropForgeRepository,
    private readonly chain: LaunchChain,
    private readonly signer: { sign(unsigned: string): Promise<string> },
    private readonly scheduledEnabled = true
  ) {}

  async tick(): Promise<void> {
    const walletId = `${this.config.chainId}:${this.config.signer.toLowerCase()}`;
    const work = await this.repository.wallet(
      walletId,
      async (pending, ctx): Promise<Work | null> => {
        if (pending.launch_id) return this.pendingWork(pending, ctx);
        for (const candidate of await this.repository.active(
          await this.chain.now(),
          ctx
        )) {
          const record = await this.repository.lockLaunch(candidate.id, ctx);
          if (!runnable(record) || !this.scheduledEnabled) {
            await this.reconcileInactive(record, ctx);
            continue;
          }
          if (record.data.events.some((event) => !event.drop_id)) continue;
          const reserved = await this.reserveCandidate(record, pending, ctx);
          if (reserved) return reserved;
        }
        return null;
      },
      {}
    );
    if (!work) return;
    if (work.action.recovery) {
      await new DropForgeRecovery(
        this.config,
        this.repository,
        this.chain,
        this.signer
      ).tick(work.record.id);
      return;
    }
    if (work.action.state === 'RESERVED' && this.scheduledEnabled) {
      if (work.record.data.events.some((event) => !event.drop_id)) return;
      await this.sign(walletId, work);
    }
    await this.reconcile(walletId, work.record.id);
  }

  private async reserveCandidate(
    record: LaunchRecord,
    pending: PendingSigner,
    ctx: RequestContext
  ): Promise<Work | null> {
    try {
      const reserved = await this.reserve(record, pending, ctx);
      return reserved;
    } catch (error) {
      if (pending.launch_id === record.id) throw error;
      setLaunchState(
        record,
        'BLOCKED',
        error instanceof LaunchSafetyError
          ? error.message
          : 'RPC or preparation check failed; review before resuming'
      );
      await this.repository.save(record, ctx);
    }
    return null;
  }

  private async reconcileInactive(
    record: LaunchRecord,
    ctx: RequestContext
  ): Promise<void> {
    if (record.data.manual_transactions?.some((it) => it.state === 'PENDING')) {
      try {
        await reconcileManual(
          record,
          this.chain,
          this.config,
          (
            await this.repository.source(
              record.data.contract,
              record.data.claim_id,
              ctx
            )
          ).metadata
        );
        await mirrorCompletion(record, ctx);
      } catch (error) {
        setLaunchState(
          record,
          'BLOCKED',
          error instanceof LaunchSafetyError
            ? error.message
            : 'Manual transaction reconciliation failed'
        );
      }
      await this.repository.save(record, ctx);
    }
  }

  private async pendingWork(
    pending: PendingSigner,
    ctx: RequestContext
  ): Promise<Work | null> {
    const record = await this.repository.lockLaunch(pending.launch_id!, ctx);
    const action = record.data.actions.find(
      (it) => it.id === pending.action_id
    );
    if (!action || !['RESERVED', 'SIGNED'].includes(action.state))
      throw new LaunchSafetyError(
        'Signer ledger is inconsistent; manual recovery required'
      );
    if (record.data.plan_version !== DROP_FORGE_PLAN_VERSION)
      setLaunchState(
        record,
        'BLOCKED',
        'Legacy launch plan requires manual reconciliation before phase/research execution'
      );
    const expiredUnsigned =
      action.state === 'RESERVED' &&
      runnable(record) &&
      this.scheduledEnabled &&
      (await this.chain.now()) >= action.deadline - 120;
    if (
      action.state === 'RESERVED' &&
      (!runnable(record) || !this.scheduledEnabled || expiredUnsigned)
    ) {
      if (expiredUnsigned) {
        reportActionFailure(
          record,
          action,
          await this.chain.now(),
          'Unsigned reservation expired; no transaction was submitted'
        );
        action.window_reported = true;
      }
      action.state = 'PENDING';
      delete action.unsigned_tx;
      pending.launch_id = null;
      pending.action_id = null;
      await this.repository.save(record, ctx);
      return null;
    }
    return { record, action };
  }

  private async assertCanonical(record: LaunchRecord): Promise<void> {
    for (const action of record.data.actions) {
      for (const recovery of [
        ...(action.recovery_history ?? []),
        ...(action.recovery?.outcome ? [action.recovery] : [])
      ]) {
        const evidence = await this.chain.receipt(recovery.winner_hash!);
        if (
          !evidence ||
          evidence.blockHash !== recovery.block_hash ||
          evidence.confirmations < this.config.confirmations
        )
          throw new LaunchSafetyError(
            'A finalized recovery winner is no longer canonical; further writes are prohibited'
          );
      }
    }
    const confirmed = record.data.actions.filter(
      (it) => it.state === 'CONFIRMED' && !!it.hash
    );
    // Actions confirm serially on one chain. A reorg removing an earlier
    // receipt also removes its latest confirmed descendant's block.
    const previous = confirmed[confirmed.length - 1];
    if (previous) {
      const receipt = await this.chain.receipt(previous.hash!);
      if (
        !receipt ||
        receipt.blockHash !== previous.block_hash ||
        receipt.status !== 1 ||
        receipt.confirmations < this.config.confirmations
      )
        throw new LaunchSafetyError(
          'A previously confirmed transaction is no longer canonical'
        );
    }
  }

  private async reserve(
    record: LaunchRecord,
    pending: PendingSigner,
    ctx: RequestContext
  ): Promise<Work | null> {
    assertPhaseScopedPlan(record.data);
    await this.assertCanonical(record);
    if (
      !(await reconcileManual(
        record,
        this.chain,
        this.config,
        (
          await this.repository.source(
            record.data.contract,
            record.data.claim_id,
            ctx
          )
        ).metadata
      ))
    ) {
      await this.repository.save(record, ctx);
      return null;
    }
    await mirrorCompletion(record, ctx);
    if (record.data.events.some((event) => !event.drop_id)) {
      await this.repository.save(record, ctx);
      return null;
    }
    if (record.data.actions.every((action) => action.state === 'CONFIRMED')) {
      setLaunchState(
        record,
        'COMPLETED',
        'All launch work completed, including post-mint Research reconciliation.'
      );
      await this.repository.save(record, ctx);
      return null;
    }
    const now = await this.chain.now();
    for (const action of dueActions(record, now)) {
      const work = await this.tryAction(record, action, pending, ctx, now);
      if (work) {
        await this.repository.save(record, ctx);
        return work;
      }
    }
    await mirrorCompletion(record, ctx);
    await this.repository.save(record, ctx);
    return null;
  }

  private async tryAction(
    record: LaunchRecord,
    action: LaunchAction,
    pending: PendingSigner,
    ctx: RequestContext,
    now: number
  ): Promise<Work | null> {
    let work: Work | null = null;
    try {
      if ((action.retry_at ?? 0) > now) return null;
      if (await this.observe(record, action)) return null;
      if (this.deferAction(record, action, now)) return null;
      work = await this.prepareAction(record, action, pending, ctx);
    } catch (error) {
      if (now < action.deadline - 120 || !action.window_reported) {
        reportActionFailure(
          record,
          action,
          now,
          error instanceof LaunchSafetyError
            ? error.message
            : 'RPC or readiness check failed'
        );
        if (now >= action.deadline - 120) action.window_reported = true;
      }
    }
    return work;
  }

  private async observe(
    record: LaunchRecord,
    action: LaunchAction
  ): Promise<boolean> {
    const completed = await this.chain.completed?.(record.data, action);
    if (completed) {
      if (action.recovery?.outcome) {
        action.recovery_history = [
          ...(action.recovery_history ?? []),
          action.recovery
        ];
        delete action.recovery;
        delete action.signed_tx;
        delete action.hash;
        delete action.block_hash;
        delete action.block_number;
      }
      action.state = 'CONFIRMED';
      action.observed = true;
      if (action.kind === 'INITIALIZE' && completed.metadata !== undefined)
        record.data.metadata = completed.metadata;
      const proof = [...(record.data.manual_transactions ?? [])]
        .reverse()
        .find((it) => matchesObservedProof(record, action, it));
      if (proof) {
        action.hash = proof.hash;
        action.block_hash = proof.block_hash;
        action.block_number = proof.block_number;
      }
      if (action.kind === 'UPDATE') {
        action.expected_supply = completed.total;
        action.airdrop_baseline =
          completed.total -
          record.data.actions
            .filter((it) => it.phase === action.phase)
            .reduce((n, it) => n + (it.credited_tokens ?? 0), 0);
      }
      if (action.kind === 'METADATA')
        record.data.metadata = action.target_metadata!;
      reportActionSkip(record, action);
      return true;
    }
    return false;
  }

  private deferAction(
    record: LaunchRecord,
    action: LaunchAction,
    now: number
  ): boolean {
    if (now >= action.deadline - 120 && !action.late_delivery) {
      if (!action.window_reported) {
        reportActionFailure(
          record,
          action,
          now,
          'Safe execution window closed; outstanding work requires operator reconciliation'
        );
        action.window_reported = true;
      }
      return true;
    }
    if (['FAILED', 'CANCELLED'].includes(action.state)) {
      if (!action.attempt_error)
        reportActionFailure(
          record,
          action,
          now,
          'Finalized unsuccessful transaction; outstanding work requires authorized recovery'
        );
      return true;
    }
    return (action.retry_at ?? 0) > now;
  }

  private async prepareAction(
    record: LaunchRecord,
    action: LaunchAction,
    pending: PendingSigner,
    ctx: RequestContext
  ): Promise<Work> {
    if (action.state !== 'PENDING')
      throw new LaunchSafetyError('Action state differs from signer ledger');
    const source = await this.repository.source(
      record.data.contract,
      record.data.claim_id,
      ctx
    );
    if (!sourceMatchesLaunch(source, record.data))
      throw new LaunchSafetyError(
        'Prepared distribution or metadata changed after the launch was frozen'
      );
    if (
      action.kind === 'METADATA' &&
      source.metadata !== action.target_metadata
    )
      throw new LaunchSafetyError(
        'A newer Craft publication exists; request its metadata update'
      );
    if (action.kind === 'UPDATE') {
      delete action.expected_supply;
      delete action.airdrop_baseline;
    }
    action.unsigned_tx = await this.chain.prepare(record.data, action);
    action.state = 'RESERVED';
    delete action.attempt_error;
    delete action.retry_at;
    pending.launch_id = record.id;
    pending.action_id = action.id;
    setLaunchState(record, 'RUNNING', `Reserved transaction for ${action.id}`);
    return { record, action };
  }

  private async sign(walletId: string, work: Work): Promise<void> {
    let signed: Transaction;
    let raw: string;
    try {
      if ((await this.chain.now()) >= work.action.deadline - 120)
        throw new LaunchSafetyError('Signing deadline passed');
      await this.chain.verify(work.record.data, work.action);
      const source = await this.repository.source(
        work.record.data.contract,
        work.record.data.claim_id,
        {}
      );
      if (!sourceMatchesLaunch(source, work.record.data))
        throw new LaunchSafetyError(
          'Prepared distribution or metadata changed before signing'
        );
      if (
        work.action.kind === 'METADATA' &&
        source.metadata !== work.action.target_metadata
      )
        throw new LaunchSafetyError(
          'Craft publication changed before metadata signing'
        );
      const nonce = Transaction.from(work.action.unsigned_tx!).nonce;
      const [latest, pending] = await Promise.all([
        this.chain.nonce(work.record.data.signer, false),
        this.chain.nonce(work.record.data.signer, true)
      ]);
      if (latest !== nonce || pending !== nonce)
        throw new LaunchSafetyError('Signer nonce changed before signing');
      raw = await this.signer.sign(work.action.unsigned_tx!);
      signed = Transaction.from(raw);
      if (
        signed.unsignedSerialized !== work.action.unsigned_tx ||
        signed.from?.toLowerCase() !== this.config.signer.toLowerCase()
      )
        throw new LaunchSafetyError(
          'Signer returned a different transaction or wallet'
        );
    } catch (error) {
      await this.releaseUnsigned(
        walletId,
        work,
        error,
        await this.chain.now().catch(() => Math.floor(Date.now() / 1000))
      );
      return;
    }
    await this.repository.wallet(
      walletId,
      async (pending, ctx) => {
        if (
          pending.launch_id !== work.record.id ||
          pending.action_id !== work.action.id
        )
          return;
        const record = await this.repository.lockLaunch(work.record.id, ctx);
        const action = record.data.actions.find(
          (it) => it.id === work.action.id
        )!;
        if (
          action.state !== 'RESERVED' ||
          !runnable(record) ||
          record.data.events.some((event) => !event.drop_id)
        )
          return;
        if ((await this.chain.now()) >= action.deadline - 120) {
          action.state = 'PENDING';
          delete action.unsigned_tx;
          pending.launch_id = null;
          pending.action_id = null;
          reportActionFailure(
            record,
            action,
            await this.chain.now(),
            'Signing deadline passed; no signed intent committed'
          );
          await this.repository.save(record, ctx);
          return;
        }
        action.signed_tx = raw;
        action.hash = signed.hash!;
        action.state = 'SIGNED';
        addLaunchEvent(record, `Signed ${action.id}: ${action.hash}`);
        await this.repository.save(record, ctx);
      },
      {}
    );
  }

  private async releaseUnsigned(
    walletId: string,
    work: Work,
    error: unknown,
    now: number
  ): Promise<void> {
    await this.repository.wallet(
      walletId,
      async (pending, ctx) => {
        if (
          pending.launch_id !== work.record.id ||
          pending.action_id !== work.action.id
        )
          return;
        const record = await this.repository.lockLaunch(work.record.id, ctx);
        const action = record.data.actions.find(
          (it) => it.id === work.action.id
        )!;
        if (action.state !== 'RESERVED' || action.signed_tx) return;
        action.state = 'PENDING';
        delete action.unsigned_tx;
        pending.launch_id = null;
        pending.action_id = null;
        reportActionFailure(
          record,
          action,
          now,
          error instanceof LaunchSafetyError
            ? error.message
            : 'KMS signing failed'
        );
        await this.repository.save(record, ctx);
      },
      {}
    );
  }

  private async reconcile(walletId: string, launch: string): Promise<void> {
    // Receipt reads are safe to repeat. Broadcast happens only after the raw
    // transaction and its hash have committed to the durable ledger.
    const broadcast = await this.repository.wallet(
      walletId,
      async (pending, ctx): Promise<string | null> => {
        if (pending.launch_id !== launch) return null;
        const record = await this.repository.lockLaunch(launch, ctx);
        const action = record.data.actions.find(
          (it) => it.id === pending.action_id
        )!;
        if (action.state !== 'SIGNED' || action.recovery) return null;
        const receipt = await this.chain.receipt(action.hash!);
        if (receipt && receipt.confirmations >= this.config.confirmations) {
          this.applyReceipt(
            record,
            action,
            receipt,
            pending,
            await this.chain.now()
          );
          await mirrorCompletion(record, ctx);
          await this.repository.save(record, ctx);
          return null;
        }
        if (record.data.plan_version !== DROP_FORGE_PLAN_VERSION) {
          setLaunchState(
            record,
            'BLOCKED',
            'Legacy signed intent requires manual reconciliation; rebroadcast is prohibited'
          );
          await this.repository.save(record, ctx);
          return null;
        }
        if (receipt || !runnable(record) || !this.scheduledEnabled) return null;
        const nonce = Transaction.from(action.signed_tx!).nonce;
        if ((await this.chain.nonce(record.data.signer, false)) > nonce) {
          // Inclusion may happen between the first receipt and nonce reads.
          const included = await this.chain.receipt(action.hash!);
          if (included) {
            if (included.confirmations >= this.config.confirmations) {
              this.applyReceipt(
                record,
                action,
                included,
                pending,
                await this.chain.now()
              );
              await mirrorCompletion(record, ctx);
              await this.repository.save(record, ctx);
            }
            return null;
          }
          setLaunchState(
            record,
            'BLOCKED',
            'Signer nonce was consumed without a canonical receipt; manual recovery required'
          );
          await this.repository.save(record, ctx);
          return null;
        }
        if ((await this.chain.now()) >= action.deadline - 120) {
          setLaunchState(
            record,
            'BLOCKED',
            `Execution deadline reached for ${action.id}; outstanding transaction still requires reconciliation`
          );
          await this.repository.save(record, ctx);
          return null;
        }
        const now = await this.chain.now();
        if ((action.retry_at ?? 0) > now) return null;
        action.retry_at = now + 60;
        await this.repository.save(record, ctx);
        return action.signed_tx!;
      },
      {}
    );
    if (broadcast) {
      // Errors, including timeouts and already-known responses, cannot justify
      // a fresh nonce. The next invocation reconciles this exact hash.
      try {
        await this.chain.broadcast(broadcast);
      } catch {
        await this.repository.wallet(
          walletId,
          async (_, ctx) => {
            const record = await this.repository.lockLaunch(launch, ctx);
            const hash = Transaction.from(broadcast).hash;
            const action = record.data.actions.find((it) => it.hash === hash);
            if (!action) return;
            addLaunchEvent(
              record,
              `Claim #${record.data.claim_id}: Broadcast attempt failed for ${action.id}: ${hash}; exact signed transaction retained pending receipt reconciliation.`,
              true
            );
            await this.repository.save(record, ctx);
          },
          {}
        );
      }
    }
  }

  private applyReceipt(
    record: LaunchRecord,
    action: LaunchAction,
    receipt: ChainReceipt,
    pending: PendingSigner,
    confirmedAt: number
  ): void {
    action.block_number = receipt.blockNumber;
    action.block_hash = receipt.blockHash;
    action.state = receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
    pending.launch_id = null;
    pending.action_id = null;
    if (receipt.status === 1) {
      if (action.kind === 'METADATA')
        record.data.metadata = action.target_metadata!;
      addLaunchEvent(
        record,
        `Confirmed ${action.id}: ${action.hash} (${receipt.confirmations} confirmations)`
      );
      delete action.attempt_error;
      delete action.retry_at;
      if (confirmedAt >= action.deadline)
        addLaunchEvent(
          record,
          `Claim #${record.data.claim_id}: ${action.id} confirmed after its deadline; completed work will not be repeated. ${action.hash}`
        );
    } else {
      action.recovery = {
        ...originalRecovery(action),
        outcome: 'REVERTED',
        winner_hash: action.hash,
        block_number: receipt.blockNumber,
        block_hash: receipt.blockHash
      };
      reportActionFailure(
        record,
        action,
        confirmedAt,
        `Transaction reverted: ${action.hash}; manual recovery required`
      );
    }
  }
}
