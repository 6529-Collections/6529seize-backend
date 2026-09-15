import { performance } from 'node:perf_hooks';
import type { RequestContext } from '@/request.context';
import type { SqlExecutor, SqlExecutionBudget } from '@/sql-executor';
import { MembershipEvaluationInputsDb } from './membership-evaluation-inputs.db';
import { minimumMembershipHorizon } from './membership-evaluation-validation';
import {
  MembershipEvaluationQuantumResult,
  MembershipProfileEvaluationSeed,
  MembershipProfileEvaluator
} from './membership-evaluator.types';
import { MEMBERSHIP_EVALUATOR_SPEC_VERSION } from './membership-profile-evaluator';
import {
  MembershipPrimaryContext,
  withMembershipPrimaryTransaction
} from './membership-primary';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipWorkerDb, MembershipRunSeed } from './membership-worker.db';
import { MembershipWorkerSourcesDb } from './membership-worker-sources.db';
import {
  MembershipDeliveryDescriptor,
  MembershipWorkerClaim,
  MembershipWorkerError,
  MembershipWorkerOptions,
  MembershipWorkerResult,
  MembershipWorkerRun
} from './membership-worker.types';
import {
  normalizeMembershipWorkerCursor,
  validateMembershipWorkerOptions
} from './membership-worker-validation';
import {
  MembershipRefreshTargetKey,
  assertMembershipBoundedInteger,
  assertMembershipId,
  normalizeRefreshTarget
} from './membership-validation';

export function membershipWorkerBudget(
  options: MembershipWorkerOptions
): SqlExecutionBudget {
  return {
    deadlineMonotonicMillis: Math.min(
      options.deadline_monotonic_millis,
      performance.now() + options.transaction_millis
    ),
    maxStatementMillis: options.max_statement_millis,
    finalizationReserveMillis: options.finalization_reserve_millis,
    lockWaitSeconds: options.lock_wait_seconds
  };
}

export function membershipWorkerSeed(
  run: MembershipWorkerRun
): MembershipProfileEvaluationSeed {
  if (run.progress_cursor.kind !== 'PROFILE')
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Fanout has no profile evaluation seed'
    );
  return {
    profile_id: run.target_id,
    identity_consolidation_key: run.progress_cursor.identity_consolidation_key,
    spec_version: run.spec_version,
    source_versions: run.source_versions,
    catalog_version: run.catalog_version,
    evaluation_time_millis: run.evaluation_time_millis,
    through_group_id: run.progress_cursor.through_id
  };
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'errno' in error &&
    error.errno === 3572
  )
    return 'ER_LOCK_NOWAIT';
  if (
    error &&
    typeof error === 'object' &&
    'serverCode' in error &&
    typeof error.serverCode === 'string'
  )
    return error.serverCode;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  )
    return error.code;
  return 'TRANSIENT';
}

/** A bounded invocation. Each committed quantum is independently resumable. */
export class MembershipRefreshWorker {
  private readonly runs: MembershipWorkerDb;
  private readonly sources: MembershipWorkerSourcesDb;
  private readonly targets: MembershipRefreshTargetsDb;
  private readonly inputs: MembershipEvaluationInputsDb;

  constructor(
    private readonly db: SqlExecutor,
    private readonly evaluator: MembershipProfileEvaluator
  ) {
    this.runs = new MembershipWorkerDb(() => db);
    this.sources = new MembershipWorkerSourcesDb(() => db);
    this.targets = new MembershipRefreshTargetsDb(() => db);
    this.inputs = new MembershipEvaluationInputsDb(db);
  }

  async runTarget(
    rawTarget: MembershipRefreshTargetKey,
    options: MembershipWorkerOptions,
    context: RequestContext = {},
    delivery?: MembershipDeliveryDescriptor
  ): Promise<MembershipWorkerResult> {
    const target = normalizeRefreshTarget(rawTarget);
    validateMembershipWorkerOptions(options);
    let result: MembershipWorkerResult = {
      outcome: 'NO_WORK',
      run_id: null,
      checkpoint_version: null,
      quanta: 0,
      processed_count: '0',
      query_count: 0,
      input_rows: 0
    };
    for (let i = 0; i < options.max_quanta; i++) {
      if (
        performance.now() +
          options.finalization_reserve_millis +
          options.checkpoint_reserve_millis +
          1000 >=
        options.deadline_monotonic_millis
      )
        return result;
      const next = await this.runOne(
        target,
        options,
        context,
        i === 0 ? delivery : undefined
      );
      if (next.outcome === 'NO_WORK' && result.run_id !== null) return result;
      result = {
        ...next,
        quanta: result.quanta + next.quanta,
        query_count: result.query_count + next.query_count,
        input_rows: result.input_rows + next.input_rows
      };
      if (next.outcome !== 'PENDING' || next.quanta === 0) return result;
    }
    return result;
  }

  private async runOne(
    target: MembershipRefreshTargetKey,
    options: MembershipWorkerOptions,
    context: RequestContext,
    delivery?: MembershipDeliveryDescriptor
  ): Promise<MembershipWorkerResult> {
    let claim: MembershipWorkerClaim | null = null;
    let expectedRequest: string | null = null;
    try {
      claim = await withMembershipPrimaryTransaction(
        this.db,
        async (ctx) => {
          expectedRequest =
            (await this.runs.target(target, false, ctx))?.requested_version ??
            null;
          return this.runs.claim(
            target,
            options.lease_millis,
            (primary) => this.seed(target, primary),
            ctx,
            delivery
          );
        },
        context,
        membershipWorkerBudget(options)
      );
      if (!claim) return this.result('NO_WORK', null);
      const budget = membershipWorkerBudget(options);
      const work = await withMembershipPrimaryTransaction(
        this.db,
        async (ctx) => {
          // Read immutable metadata before sources; publication's locking order is
          // sources -> target -> run -> publication, never run -> sources.
          const run = await this.runs.run(claim!.run_id, false, ctx);
          if (!run)
            throw new MembershipWorkerError(
              'FENCED',
              'Membership run disappeared'
            );
          if (run.progress_cursor.phase === 'READY_TO_FINISH')
            return {
              run: await this.finish(claim!, run, ctx),
              query_count: 0,
              input_rows: 0
            };
          const locked = await this.runs.lockClaim(claim!, ctx);
          await this.sources.validateSources(locked.run, false, ctx);
          if (locked.run.scope === 'PROFILE')
            return this.profileQuantum(
              claim!,
              locked.run,
              options,
              budget,
              ctx
            );
          return this.fanoutQuantum(claim!, locked.run, options, ctx);
        },
        context,
        budget
      );
      return {
        ...this.result(
          work.run.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
          work.run
        ),
        quanta: 1,
        query_count: work.query_count,
        input_rows: work.input_rows
      };
    } catch (error) {
      const code = errorCode(error);
      if (claim === null && code === 'INTEGRITY') {
        const parked = await withMembershipPrimaryTransaction(
          this.db,
          (ctx) => this.runs.parkMalformedTarget(target, expectedRequest, ctx),
          context,
          membershipWorkerBudget(options)
        );
        return this.result(parked ? 'FAILED' : 'NO_WORK', null);
      }
      // The connection may have committed despite a lost acknowledgment. A new
      // fenced lookup reconciles actual progress; never infer rollback here.
      const reconciled = await this.reconcile(claim, options, context);
      if (reconciled) return reconciled;
      if (code === 'FENCED' || code === 'ER_LOCK_NOWAIT')
        return this.result('NO_WORK', null);
      const supersede = ['SOURCE_CHANGED', 'EXPIRED'].includes(code);
      const park = [
        'INTEGRITY',
        'INVALID_INPUT',
        'NUMERIC_DOMAIN_UNSUPPORTED'
      ].includes(code);
      const failure = await withMembershipPrimaryTransaction(
        this.db,
        async (ctx) => {
          const outcome = await this.runs.fail(
            target,
            claim,
            expectedRequest,
            {
              error_code: code,
              supersede,
              retry_millis: options.retry_millis,
              max_attempts: options.max_attempts,
              park
            },
            ctx
          );
          const run =
            claim && outcome !== 'FENCED'
              ? await this.runs.run(claim.run_id, false, ctx)
              : null;
          return { outcome, run };
        },
        context,
        membershipWorkerBudget(options)
      );
      return this.result(
        failure.outcome === 'FENCED' ? 'NO_WORK' : failure.outcome,
        failure.run
      );
    }
  }

  private async reconcile(
    claim: MembershipWorkerClaim | null,
    options: MembershipWorkerOptions,
    context: RequestContext
  ): Promise<MembershipWorkerResult | null> {
    if (
      !claim ||
      performance.now() + options.finalization_reserve_millis + 1000 >=
        options.deadline_monotonic_millis
    )
      return null;
    return withMembershipPrimaryTransaction(
      this.db,
      async (ctx) => {
        const run = await this.runs.run(claim.run_id, false, ctx);
        if (run?.status === 'COMPLETED') return this.result('COMPLETED', run);
        if (
          run?.status === 'PENDING' &&
          BigInt(run.checkpoint_version) > BigInt(claim.checkpoint_version)
        )
          return this.result('PENDING', run);
        return null;
      },
      context,
      membershipWorkerBudget(options)
    );
  }

  private result(
    outcome: MembershipWorkerResult['outcome'],
    run: MembershipWorkerRun | null
  ): MembershipWorkerResult {
    return {
      outcome,
      run_id: run?.id ?? null,
      checkpoint_version: run?.checkpoint_version ?? null,
      quanta: 0,
      processed_count: run?.processed_count ?? '0',
      query_count: 0,
      input_rows: 0
    };
  }

  private async seed(
    target: MembershipRefreshTargetKey,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipRunSeed> {
    if (target.scope === 'PROFILE') {
      const seed = await this.evaluator.captureProfile(target.target_id, ctx);
      const order = await this.inputs.groupOrder(ctx);
      return {
        ...seed,
        source_versions: [...seed.source_versions],
        progress_cursor: {
          protocol_version: 2,
          kind: 'PROFILE',
          phase: 'SCAN',
          after_id: null,
          through_id: seed.through_group_id,
          traversal_collation: order.collation,
          identity_consolidation_key: seed.identity_consolidation_key,
          active_input: null
        }
      };
    }
    const seed = await this.sources.fanoutSeed(ctx);
    return {
      ...seed,
      spec_version: MEMBERSHIP_EVALUATOR_SPEC_VERSION,
      progress_cursor: {
        protocol_version: 1,
        kind: 'PROFILE_FANOUT',
        phase: 'SCAN',
        after_id: null,
        through_id: seed.through_id,
        traversal_collation: seed.traversal_collation
      }
    };
  }

  private async profileQuantum(
    claim: MembershipWorkerClaim,
    run: MembershipWorkerRun,
    options: MembershipWorkerOptions,
    budget: SqlExecutionBudget,
    ctx: MembershipPrimaryContext
  ) {
    const cursor = run.progress_cursor;
    if (cursor.kind !== 'PROFILE' || cursor.phase !== 'SCAN')
      throw new MembershipWorkerError('INTEGRITY', 'Invalid profile cursor');
    if (run.spec_version !== MEMBERSHIP_EVALUATOR_SPEC_VERSION)
      throw new MembershipWorkerError(
        'SOURCE_CHANGED',
        'Membership evaluator version changed'
      );
    const order = await this.inputs.groupOrder(ctx);
    if (order.collation !== cursor.traversal_collation)
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Membership group collation changed'
      );
    const output = await this.evaluator.evaluateQuantum(
      {
        ...membershipWorkerSeed(run),
        after_group_id: cursor.after_id,
        max_scanned_groups: options.page_size,
        max_query_millis: options.max_statement_millis,
        deadline_monotonic_millis:
          budget.deadlineMonotonicMillis -
          options.finalization_reserve_millis -
          options.checkpoint_reserve_millis,
        active_input: cursor.active_input,
        limits: options.input_limits
      },
      ctx
    );
    await this.validateOutput(output, run, options.page_size, ctx);
    const next = normalizeMembershipWorkerCursor({
      ...cursor,
      after_id: output.after_group_id,
      active_input: output.active_input,
      phase: output.done ? 'READY_TO_FINISH' : 'SCAN'
    });
    const horizon = minimumMembershipHorizon(
      run.valid_until_millis,
      output.valid_until_millis
    );
    const saved = await this.runs.checkpoint(
      claim,
      next,
      output.eligible_group_ids,
      output.scanned_count,
      horizon,
      ctx
    );
    return {
      run: saved,
      query_count: output.query_count,
      input_rows: output.input_rows
    };
  }

  private async validateOutput(
    output: MembershipEvaluationQuantumResult,
    run: MembershipWorkerRun,
    size: number,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    assertMembershipBoundedInteger(
      output.scanned_count,
      'evaluated groups',
      0,
      size
    );
    assertMembershipBoundedInteger(
      output.query_count,
      'query count',
      0,
      1000000
    );
    assertMembershipBoundedInteger(
      output.input_rows,
      'input rows',
      0,
      Number.MAX_SAFE_INTEGER
    );
    if (
      output.eligible_group_ids.length > output.scanned_count ||
      new Set(output.eligible_group_ids).size !==
        output.eligible_group_ids.length
    )
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Invalid evaluator member subset'
      );
    const before = run.progress_cursor.after_id;
    if (
      output.after_group_id !== before &&
      (output.after_group_id === null ||
        !(await this.inputs.isGroupRangeValid(
          output.after_group_id,
          before,
          run.progress_cursor.through_id,
          ctx
        )))
    )
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Evaluator frontier escaped its captured range'
      );
    for (const id of output.eligible_group_ids) {
      assertMembershipId(id, 'evaluated group', 200);
      if (
        !(await this.inputs.isGroupRangeValid(
          id,
          before,
          output.after_group_id,
          ctx
        ))
      )
        throw new MembershipWorkerError(
          'INTEGRITY',
          'Evaluator member escaped completed prefix'
        );
    }
    if (
      output.kind === 'INPUT_PENDING' &&
      (output.done || output.active_input === null)
    )
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Incomplete evaluator input claimed exhaustion'
      );
    if (output.kind === 'PAGE_COMPLETE' && output.active_input !== null)
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Completed evaluator page retained input'
      );
    if (
      !output.done &&
      output.after_group_id === before &&
      JSON.stringify(output.active_input) ===
        JSON.stringify(
          run.progress_cursor.kind === 'PROFILE'
            ? run.progress_cursor.active_input
            : null
        )
    )
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Evaluator returned no durable progress'
      );
  }

  private async fanoutQuantum(
    claim: MembershipWorkerClaim,
    run: MembershipWorkerRun,
    options: MembershipWorkerOptions,
    ctx: MembershipPrimaryContext
  ) {
    const page = await this.sources.fanoutPage(run, options.page_size, ctx);
    await this.targets.request(
      page.ids.map((id) => ({
        scope: 'PROFILE',
        target_id: id,
        reason: 'MEMBERSHIP_FANOUT'
      })),
      ctx
    );
    const saved = await this.runs.checkpoint(
      claim,
      {
        ...run.progress_cursor,
        after_id: page.after_id,
        phase: page.done ? 'READY_TO_FINISH' : 'SCAN'
      },
      [],
      page.ids.length,
      null,
      ctx
    );
    return { run: saved, query_count: 0, input_rows: page.ids.length };
  }

  private async finish(
    claim: MembershipWorkerClaim,
    run: MembershipWorkerRun,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipWorkerRun> {
    if (
      run.scope === 'PROFILE' &&
      run.spec_version !== MEMBERSHIP_EVALUATOR_SPEC_VERSION
    )
      throw new MembershipWorkerError(
        'SOURCE_CHANGED',
        'Membership evaluator version changed'
      );
    await this.sources.validateSources(run, true, ctx);
    return this.runs.complete(claim, run.scope === 'PROFILE', ctx);
  }
}
