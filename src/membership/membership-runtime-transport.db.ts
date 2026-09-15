import { SqlExecutor } from '@/sql-executor';
import { MembershipPrimaryContext } from './membership-primary';
import { MembershipRefreshTargetKey } from './membership-validation';
import { MembershipWorkerDb } from './membership-worker.db';
import { MembershipWorkerResult } from './membership-worker.types';
import { MEMBERSHIP_FIXTURE_PROFILES } from './membership-runtime-policy';
import {
  FixtureControl,
  FixtureState,
  MembershipFixtureControlDb
} from './membership-runtime-fixture-control';
import { MEMBERSHIP_FIXTURE_MANIFEST_HASH } from './membership-runtime-fixture-manifest';
import { timeMembershipOperation } from './membership-repository.utils';

type TransportReceipt = NonNullable<FixtureState['transport']>;
export interface MembershipTransportDisposition {
  readonly outcome: 'PROCEED' | 'HELD_MESSAGE' | 'OTHER_MESSAGE';
  readonly receipt: TransportReceipt | null;
}

function requireReady(control: FixtureControl | null): FixtureControl {
  if (
    !control ||
    control.manifest_hash !== MEMBERSHIP_FIXTURE_MANIFEST_HASH ||
    control.state.setup_stage !== 'READY'
  )
    throw new Error('Membership fixture is not ready for runtime work');
  return control;
}

export async function assertMembershipFixtureReady(
  db: SqlExecutor,
  ctx: MembershipPrimaryContext
): Promise<FixtureControl> {
  return requireReady(await new MembershipFixtureControlDb(db).read(ctx));
}

/** Fixture-only transport evidence; never changes worker retry or lease authority. */
export class MembershipRuntimeTransportDb {
  private readonly control: MembershipFixtureControlDb;
  private readonly runs: MembershipWorkerDb;
  constructor(private readonly db: SqlExecutor) {
    this.control = new MembershipFixtureControlDb(db);
    this.runs = new MembershipWorkerDb(() => db);
  }

  async heldTarget(
    target: MembershipRefreshTargetKey,
    ctx: MembershipPrimaryContext
  ): Promise<boolean> {
    const control = requireReady(await this.control.read(ctx));
    return (
      this.isTransport(target) && control.state.transport?.phase === 'HELD'
    );
  }

  private isTransport(target: MembershipRefreshTargetKey): boolean {
    return (
      target.scope === 'PROFILE' &&
      target.target_id === MEMBERSHIP_FIXTURE_PROFILES[1]
    );
  }

  /** Call before worker and again after it returns, before acknowledging SQS. */
  async inspectDelivery(
    target: MembershipRefreshTargetKey,
    messageId: string,
    result: MembershipWorkerResult | null,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipTransportDisposition> {
    return timeMembershipOperation(
      'MembershipRuntimeTransportDb->inspectDelivery',
      ctx,
      async () => {
        if (!this.isTransport(target)) {
          await assertMembershipFixtureReady(this.db, ctx);
          return { outcome: 'PROCEED', receipt: null };
        }
        // Same order as dispatcher: target -> run -> fixture control. READY
        // operator mutations acquire their control CAS only after source/target work.
        const current = await this.runs.target(target, true, ctx);
        const runId = result?.run_id ?? current?.active_run_id;
        const run = runId ? await this.runs.run(runId, true, ctx) : null;
        const control = requireReady(await this.control.read(ctx, true));
        let receipt = control.state.transport;
        if (
          !receipt &&
          result &&
          (result.outcome !== 'PENDING' ||
            !result.run_id ||
            result.checkpoint_version === null ||
            !run)
        )
          throw new Error('Transport fixture result has no durable checkpoint');
        if (!receipt && run && BigInt(run.checkpoint_version) > BigInt(0)) {
          if (
            !current ||
            current.active_run_id !== run.id ||
            BigInt(run.request_version) <= BigInt(current.completed_version) ||
            BigInt(run.request_version) > BigInt(current.requested_version) ||
            run.scope !== target.scope ||
            run.target_id !== target.target_id ||
            run.status !== 'PENDING' ||
            run.lease_token !== null ||
            BigInt(run.processed_count) <= BigInt(0) ||
            (result?.checkpoint_version != null &&
              BigInt(run.checkpoint_version) <
                BigInt(result.checkpoint_version))
          )
            throw new Error('Transport fixture checkpoint is inconsistent');
          // Also recovers a crash/unknown receipt commit after the real page was
          // committed: the next delivery records that durable progress before evaluating.
          receipt = {
            phase: 'HELD',
            message_id: messageId,
            run_id: run.id,
            checkpoint_version: run.checkpoint_version
          };
          await this.control.update(
            control.revision,
            { ...control.state, transport: receipt },
            ctx
          );
        }
        if (receipt?.phase !== 'HELD') return { outcome: 'PROCEED', receipt };
        return {
          outcome:
            receipt.message_id === messageId ? 'HELD_MESSAGE' : 'OTHER_MESSAGE',
          receipt
        };
      }
    );
  }
}
