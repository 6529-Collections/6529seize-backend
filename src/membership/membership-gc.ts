import { performance } from 'node:perf_hooks';
import { RequestContext } from '@/request.context';
import { SqlExecutor } from '@/sql-executor';
import { withMembershipPrimaryTransaction } from './membership-primary';
import { MembershipGcCheckpointsDb } from './membership-gc-checkpoints.db';
import { MembershipGcDb } from './membership-gc.db';
import {
  MembershipGcHint,
  MembershipGcOptions,
  MembershipGcResult
} from './membership-gc.types';
import { membershipWorkerBudget } from './membership-worker';
import { MembershipWorkerOptions } from './membership-worker.types';
import { validateMembershipWorkerOptions } from './membership-worker-validation';
import { assertMembershipBoundedInteger } from './membership-validation';

export class MembershipRunGarbageCollector {
  private readonly checkpoints: MembershipGcCheckpointsDb;
  private readonly candidates: MembershipGcDb;
  constructor(private readonly db: SqlExecutor) {
    this.checkpoints = new MembershipGcCheckpointsDb(() => db);
    this.candidates = new MembershipGcDb(() => db);
  }

  async run(
    options: MembershipGcOptions,
    execution: MembershipWorkerOptions,
    context: RequestContext = {}
  ): Promise<MembershipGcResult[]> {
    validateMembershipWorkerOptions(execution);
    assertMembershipBoundedInteger(options.max_attempts, 'GC attempts', 1, 128);
    assertMembershipBoundedInteger(
      options.scan_age_millis,
      'GC scan age',
      0,
      86400000
    );
    assertMembershipBoundedInteger(
      options.pending_claim_millis,
      'GC claim duration',
      1000,
      600000
    );
    const results: MembershipGcResult[] = [];
    for (let i = 0; i < options.max_attempts; i++) {
      if (
        performance.now() + execution.finalization_reserve_millis + 1000 >=
        execution.deadline_monotonic_millis
      )
        break;
      // Acknowledged control commit always precedes candidate work. An uncertain
      // reservation is abandoned until the next durable sweep/claim expiry.
      const hint = await withMembershipPrimaryTransaction(
        this.db,
        (ctx) => this.checkpoints.reserve(options, ctx),
        context,
        membershipWorkerBudget(execution)
      );
      if (!hint) continue;
      const result = await this.collect(hint, options, execution, context);
      results.push(result);
      await withMembershipPrimaryTransaction(
        this.db,
        (ctx) => this.checkpoints.record(hint, result, ctx),
        context,
        membershipWorkerBudget(execution)
      );
    }
    return results;
  }

  private async collect(
    hint: MembershipGcHint,
    options: MembershipGcOptions,
    execution: MembershipWorkerOptions,
    context: RequestContext
  ): Promise<MembershipGcResult> {
    try {
      return await withMembershipPrimaryTransaction(
        this.db,
        (ctx) => this.candidates.collect(hint, options, ctx),
        context,
        membershipWorkerBudget(execution)
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ER_LOCK_NOWAIT' ||
          error.code === 'ER_LOCK_WAIT_TIMEOUT' ||
          ('errno' in error &&
            (error.errno === 3572 || error.errno === 1205)) ||
          ('serverCode' in error &&
            (error.serverCode === 'ER_LOCK_NOWAIT' ||
              error.serverCode === 'ER_LOCK_WAIT_TIMEOUT')))
      )
        return {
          run_id: hint.run_id,
          outcome: 'LOCK_BUSY',
          read_count: 0,
          deleted_count: 0,
          retry_at_millis: null
        };
      throw error;
    }
  }
}
