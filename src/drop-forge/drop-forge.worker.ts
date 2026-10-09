import { Transaction } from 'ethers';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import { LaunchChain, ChainReceipt } from '@/drop-forge/drop-forge.chain';
import { hashLaunchSource } from '@/drop-forge/drop-forge.plan';
import {
  addLaunchEvent,
  DropForgeRepository,
  setLaunchState
} from '@/drop-forge/drop-forge.repository';
import {
  LaunchAction,
  LaunchRecord,
  LaunchSafetyError
} from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';

type Work = { record: LaunchRecord; action: LaunchAction };
type PendingSigner = { launch_id: string | null; action_id: string | null };
const runnable = (record: LaunchRecord) =>
  ['ARMED', 'RUNNING'].includes(record.state);

export class DropForgeWorker {
  constructor(
    private readonly config: DropForgeConfig,
    private readonly repository: DropForgeRepository,
    private readonly chain: LaunchChain,
    private readonly signer: { sign(unsigned: string): Promise<string> }
  ) {}

  async tick(): Promise<void> {
    const walletId = `${this.config.chainId}:${this.config.signer.toLowerCase()}`;
    const work = await this.repository.wallet(
      walletId,
      async (pending, ctx): Promise<Work | null> => {
        if (pending.launch_id) return this.pendingWork(pending, ctx);
        for (const candidate of await this.repository.active(ctx)) {
          const record = await this.repository.lockLaunch(candidate.id, ctx);
          if (!runnable(record)) continue;
          if (record.data.events.some((event) => !event.drop_id)) continue;
          try {
            const reserved = await this.reserve(record, pending, ctx);
            if (reserved) return reserved;
          } catch (error) {
            setLaunchState(
              record,
              'BLOCKED',
              error instanceof LaunchSafetyError
                ? error.message
                : 'RPC or preparation check failed; review before resuming'
            );
            await this.repository.save(record, ctx);
          }
        }
        return null;
      },
      {}
    );
    if (!work) return;
    if (work.action.state === 'RESERVED') await this.sign(walletId, work);
    await this.reconcile(walletId, work.record.id);
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
    if (action.state === 'RESERVED' && !runnable(record)) {
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
    for (const previous of record.data.actions.filter(
      (it) => it.state === 'CONFIRMED'
    )) {
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
    await this.assertCanonical(record);
    const action = record.data.actions.find((it) => it.state !== 'CONFIRMED');
    if (!action) {
      setLaunchState(
        record,
        'COMPLETED',
        'All launch transactions confirmed. Mint windows continue to enforce their configured times on-chain.'
      );
      await this.repository.save(record, ctx);
      return null;
    }
    const now = await this.chain.now();
    if (now < action.due) return null;
    if (now >= action.deadline - 120)
      throw new LaunchSafetyError(
        `Missed safe execution window for ${action.id}`
      );
    if (action.state !== 'PENDING')
      throw new LaunchSafetyError('Action state differs from signer ledger');
    const source = await this.repository.source(
      record.data.contract,
      record.data.claim_id,
      ctx
    );
    if (hashLaunchSource(source) !== record.data.distribution_hash)
      throw new LaunchSafetyError(
        'Prepared distribution or metadata changed after the launch was frozen'
      );
    action.unsigned_tx = await this.chain.prepare(record.data, action);
    action.state = 'RESERVED';
    pending.launch_id = record.id;
    pending.action_id = action.id;
    setLaunchState(record, 'RUNNING', `Reserved transaction for ${action.id}`);
    await this.repository.save(record, ctx);
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
      if (hashLaunchSource(source) !== work.record.data.distribution_hash)
        throw new LaunchSafetyError(
          'Prepared distribution or metadata changed before signing'
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
      await this.repository.change(
        work.record.id,
        async (record) => {
          setLaunchState(
            record,
            'BLOCKED',
            error instanceof LaunchSafetyError
              ? error.message
              : 'KMS signing failed; review configuration before resuming'
          );
        },
        {}
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
        if (action.state !== 'RESERVED' || !runnable(record)) return;
        action.signed_tx = raw;
        action.hash = signed.hash!;
        action.state = 'SIGNED';
        addLaunchEvent(record, `Signed ${action.id}: ${action.hash}`);
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
        if (action.state !== 'SIGNED') return null;
        const receipt = await this.chain.receipt(action.hash!);
        if (receipt && receipt.confirmations >= this.config.confirmations) {
          this.applyReceipt(record, action, receipt, pending);
          await this.repository.save(record, ctx);
          return null;
        }
        if (receipt || !runnable(record)) return null;
        const nonce = Transaction.from(action.signed_tx!).nonce;
        if ((await this.chain.nonce(record.data.signer, false)) > nonce) {
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
        /* persisted intent remains the only transaction eligible for retry */
      }
    }
  }

  private applyReceipt(
    record: LaunchRecord,
    action: LaunchAction,
    receipt: ChainReceipt,
    pending: PendingSigner
  ): void {
    action.block_number = receipt.blockNumber;
    action.block_hash = receipt.blockHash;
    action.state = receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
    pending.launch_id = null;
    pending.action_id = null;
    if (receipt.status === 1)
      addLaunchEvent(
        record,
        `Confirmed ${action.id}: ${action.hash} (${receipt.confirmations} confirmations)`
      );
    else
      setLaunchState(
        record,
        'BLOCKED',
        `Transaction reverted for ${action.id}: ${action.hash}; manual recovery required`
      );
  }
}
