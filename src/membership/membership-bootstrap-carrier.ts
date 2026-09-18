import { performance } from 'node:perf_hooks';
import type { Context } from 'aws-lambda';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { withMembershipPrimaryTransaction } from './membership-primary';
import {
  MembershipBootstrapDb,
  type MembershipTrackedWriterReceipt
} from './membership-bootstrap.db';
import { MembershipBackfillDb } from './membership-backfill.db';

const logger = Logger.get('MEMBERSHIP_BOOTSTRAP_CARRIER');
const actions = [
  'membership_bootstrap_prepare_v1',
  'membership_bootstrap_advance_v1',
  'membership_bootstrap_status_v1',
  'membership_bootstrap_record_writers_v1',
  'membership_backfill_start_v1',
  'membership_backfill_status_v1',
  'membership_backfill_observe_v1',
  'membership_backfill_pause_v1',
  'membership_backfill_resume_v1'
] as const;
type Action = (typeof actions)[number];
interface OperatorEvent {
  readonly operator_action: Action;
  readonly tracked_writer_receipt?: MembershipTrackedWriterReceipt;
}

/** No caller supplied table, target, database, cursor or batch size. */
export function membershipBootstrapAction(
  event: unknown
): OperatorEvent | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const keys = Object.keys(event);
  const input = event as Record<string, unknown>;
  const action = input.operator_action;
  if (typeof action !== 'string' || !actions.some((item) => item === action))
    return null;
  if (action === 'membership_bootstrap_record_writers_v1') {
    if (
      keys.length !== 2 ||
      !keys.includes('tracked_writer_receipt') ||
      !input.tracked_writer_receipt ||
      typeof input.tracked_writer_receipt !== 'object' ||
      Array.isArray(input.tracked_writer_receipt)
    )
      throw new Error('Invalid membership writer receipt action');
    return input as unknown as OperatorEvent;
  }
  if (keys.length !== 1) throw new Error('Invalid membership operator action');
  return { operator_action: action as Action };
}

export async function handleMembershipBootstrapAction(
  event: OperatorEvent,
  context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>,
  environment: {
    readonly stage: string | undefined;
    readonly region: string | undefined;
  }
): Promise<unknown> {
  if (environment.stage !== 'staging' || environment.region !== 'eu-west-1')
    throw new Error('Membership bootstrap carrier is staging only');
  const remaining = context.getRemainingTimeInMillis();
  if (!Number.isFinite(remaining) || remaining < 15000)
    throw new Error('Insufficient membership bootstrap invocation budget');
  const result = await doInDbContext(
    () =>
      withMembershipPrimaryTransaction(
        sqlExecutor,
        async (primary) => {
          const bootstrap = new MembershipBootstrapDb(() => sqlExecutor);
          const backfill = new MembershipBackfillDb(() => sqlExecutor);
          switch (event.operator_action) {
            case 'membership_bootstrap_prepare_v1':
              return bootstrap.prepare(primary);
            case 'membership_bootstrap_advance_v1':
              return bootstrap.advance(64, primary);
            case 'membership_bootstrap_status_v1':
              return bootstrap.status(primary);
            case 'membership_bootstrap_record_writers_v1':
              return bootstrap.recordTrackedWriters(
                event.tracked_writer_receipt!,
                primary
              );
            case 'membership_backfill_start_v1':
              return backfill.start(primary);
            case 'membership_backfill_status_v1':
              return backfill.status(primary);
            case 'membership_backfill_observe_v1':
              return backfill.observe(64, primary);
            case 'membership_backfill_pause_v1':
              return backfill.pause(primary);
            case 'membership_backfill_resume_v1':
              return backfill.resume(primary);
          }
        },
        {},
        {
          deadlineMonotonicMillis:
            performance.now() + Math.min(45000, remaining - 5000),
          maxStatementMillis: 5000,
          finalizationReserveMillis: 2000,
          lockWaitSeconds: 1
        }
      ),
    { logger, syncEntities: false, skipRedis: true }
  );
  logger.info(
    JSON.stringify({
      event: 'membership_bootstrap_operator_action',
      request_id: context.awsRequestId,
      action: event.operator_action
    })
  );
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded) > 131072)
    throw new Error('Membership bootstrap response exceeds its bound');
  return result;
}
