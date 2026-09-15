import { SqlExecutor } from '@/sql-executor';
import { MembershipPrimaryContext } from './membership-primary';
import { MembershipDispatchHint } from './membership-dispatch.types';
import { MembershipFixtureControlDb } from './membership-runtime-fixture-control';
import { MEMBERSHIP_FIXTURE_MANIFEST_HASH } from './membership-runtime-fixture-manifest';
import { MEMBERSHIP_FIXTURE_PROFILES } from './membership-runtime-policy';
import { MembershipWorkerDb } from './membership-worker.db';
import { timeMembershipOperation } from './membership-repository.utils';

/** Fixed staging failure after reservation commit; never repairs scheduling state. */
export class MembershipRuntimeSendFaultDb {
  constructor(private readonly db: SqlExecutor) {}

  async recordOnce(
    hint: MembershipDispatchHint,
    ctx: MembershipPrimaryContext
  ): Promise<boolean> {
    return timeMembershipOperation(
      'MembershipRuntimeSendFaultDb->recordOnce',
      ctx,
      async () => {
        if (
          hint.target.scope !== 'PROFILE' ||
          hint.target.target_id !== MEMBERSHIP_FIXTURE_PROFILES[0]
        )
          return false;
        // Match the already committed target reservation before taking control.
        const target = await new MembershipWorkerDb(() => this.db).target(
          hint.target,
          true,
          ctx
        );
        const controls = new MembershipFixtureControlDb(this.db);
        const control = await controls.read(ctx, true);
        if (
          !control ||
          control.manifest_hash !== MEMBERSHIP_FIXTURE_MANIFEST_HASH ||
          control.state.setup_stage !== 'READY'
        )
          throw new Error(
            'Membership fixture is not ready for send failure proof'
          );
        if (
          control.state.scenario !== 'MISSED_WAKEUP' ||
          control.state.dispatch_send_failure
        )
          return false;
        if (
          !target ||
          target.requested_version !== hint.delivery.requested_version ||
          target.available_at_millis !== hint.delivery.reserved_until_millis ||
          BigInt(target.completed_version) >= BigInt(target.requested_version)
        )
          return false;
        await controls.update(
          control.revision,
          {
            ...control.state,
            dispatch_send_failure: { ...hint.delivery }
          },
          ctx
        );
        return true;
      }
    );
  }
}
