import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Context } from 'aws-lambda';
import type { SqlExecutor } from '@/sql-executor';
import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE
} from '@/constants';
import {
  MembershipPrimaryContext,
  membershipQueryOptions,
  withMembershipPrimaryTransaction
} from './membership-primary';
import {
  FixtureControl,
  MembershipFixtureControlDb
} from './membership-runtime-fixture-control';
import {
  assertMembershipFixtureEnvironment,
  MembershipFixtureEnvironment
} from './membership-runtime-fixture-setup-schema';
import {
  MEMBERSHIP_FIXTURE_MANIFEST_HASH,
  MEMBERSHIP_FIXTURE_SOURCE_KEYS
} from './membership-runtime-fixture-manifest';
import {
  MEMBERSHIP_FIXTURE_GROUPS,
  MEMBERSHIP_FIXTURE_PROFILES
} from './membership-runtime-policy';
import {
  MembershipFixtureDbProof,
  membershipFixtureDbProofReport,
  membershipFixtureDbProofSchema
} from './membership-runtime-fixture-db-proof.types';
import { MembershipWorkerDb, MembershipRunSeed } from './membership-worker.db';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipEvaluationInputsDb } from './membership-evaluation-inputs.db';
import { PrimaryMembershipProfileEvaluator } from './membership-profile-evaluator';
import { MembershipRefreshWorker } from './membership-worker';
import {
  MembershipWorkerClaim,
  MembershipWorkerError,
  MembershipWorkerOptions
} from './membership-worker.types';
import { MembershipWorkerSourcesDb } from './membership-worker-sources.db';
import { MembershipGcDb } from './membership-gc.db';
import { MembershipRunGarbageCollector } from './membership-gc';
import { MembershipGcOptions } from './membership-gc.types';
import { normalizeCounter } from './membership-validation';
import { MembershipSourceStatesDb } from './membership-source-states.db';

const emptyTarget = {
  scope: 'PROFILE',
  target_id: MEMBERSHIP_FIXTURE_PROFILES[2]
} as const;
const longTarget = {
  scope: 'PROFILE',
  target_id: MEMBERSHIP_FIXTURE_PROFILES[0]
} as const;
const LEASE_MILLIS = 90000;
const READER_GRACE_MILLIS = 120000;
const READER_MILLIS = 45000;
const gcOptions: MembershipGcOptions = {
  reader_grace_millis: READER_GRACE_MILLIS,
  scan_age_millis: 120000,
  member_batch: 2,
  pending_claim_millis: 90000,
  max_attempts: 16
};
type Invocation = Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>;
type Snapshot = { run_id: string; members: string[]; hash: string };
function requireProof(value: unknown): asserts value {
  if (!value)
    throw new Error('Membership database proof evidence is inconsistent');
}

/** Closed, DB-only evidence. It does not simulate SQS or scheduled invocations. */
export class MembershipFixtureDbProofService {
  private readonly controls: MembershipFixtureControlDb;
  private readonly runs: MembershipWorkerDb;
  private readonly targets: MembershipRefreshTargetsDb;
  private readonly evaluator: PrimaryMembershipProfileEvaluator;
  private readonly worker: MembershipRefreshWorker;
  private deadline = 0;
  private owner = '';
  private workerCalls = 0;

  constructor(
    private readonly db: SqlExecutor,
    private readonly environment: MembershipFixtureEnvironment
  ) {
    this.controls = new MembershipFixtureControlDb(db);
    this.runs = new MembershipWorkerDb(() => db);
    this.targets = new MembershipRefreshTargetsDb(() => db);
    this.evaluator = new PrimaryMembershipProfileEvaluator(() => db);
    this.worker = new MembershipRefreshWorker(db, this.evaluator);
  }

  async run(invocation: Invocation) {
    assertMembershipFixtureEnvironment(this.environment);
    const remaining = invocation.getRemainingTimeInMillis();
    if (!Number.isFinite(remaining) || remaining < 180000 || remaining > 900000)
      throw new Error('Insufficient bounded fixture database proof time');
    if (
      !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
        invocation.awsRequestId
      )
    )
      throw new Error('Invalid fixture database proof invocation');
    this.deadline = performance.now() + Math.min(840000, remaining - 30000);
    this.owner = invocation.awsRequestId;
    this.workerCalls = 0;
    try {
      await this.execute();
      const proof = await this.release();
      requireProof(proof);
      return membershipFixtureDbProofReport(proof);
    } catch (error) {
      try {
        await this.release();
      } catch {
        // Preserve the failed operation. A crashed/expired owner also has a
        // finite DB-clock expiry; cleanup must not erase that live evidence.
      }
      throw error;
    }
  }

  private async execute() {
    let proof = await this.acquire();
    for (let step = 0; step < 12; step++) {
      if (proof.phase === 'DONE' || proof.phase === 'INTERRUPTED') break;
      this.requireTime(10000);
      proof = await this.step(proof);
      if (proof.phase === 'GC_GRACE' && step >= 10) break;
    }
  }

  private async release() {
    return this.tx(async (ctx) => {
      const control = await this.control(ctx);
      const current = control.state.proof?.db_runtime;
      if (!current || current.owner?.request_id !== this.owner) return null;
      return this.save(control, { ...current, owner: null }, ctx);
    });
  }

  private requireTime(margin: number) {
    if (performance.now() + margin >= this.deadline)
      throw new Error('Membership database proof deadline reached');
  }

  private tx<T>(
    work: (ctx: MembershipPrimaryContext) => Promise<T>,
    duration = 15000
  ) {
    this.requireTime(5000);
    return withMembershipPrimaryTransaction(
      this.db,
      work,
      {},
      {
        deadlineMonotonicMillis: Math.min(
          this.deadline,
          performance.now() + duration
        ),
        maxStatementMillis: 1000,
        finalizationReserveMillis: 2000,
        lockWaitSeconds: 1
      }
    );
  }

  private async control(
    ctx: MembershipPrimaryContext
  ): Promise<FixtureControl> {
    const control = await this.controls.read(ctx);
    if (
      !control ||
      control.manifest_hash !== MEMBERSHIP_FIXTURE_MANIFEST_HASH ||
      control.state.setup_stage !== 'READY' ||
      control.state.scenario !== 'IDENTITY_RECOVERED' ||
      control.state.transport?.phase !== 'CORRECTED'
    )
      throw new Error(
        'Membership database proof requires completed fixture scenarios'
      );
    return control;
  }

  private owned(control: FixtureControl): MembershipFixtureDbProof {
    const proof = control.state.proof?.db_runtime;
    requireProof(proof && proof.owner?.request_id === this.owner);
    return proof;
  }

  private async save(
    control: FixtureControl,
    proof: MembershipFixtureDbProof,
    ctx: MembershipPrimaryContext
  ) {
    const normalized = membershipFixtureDbProofSchema.parse(proof);
    await this.controls.update(
      control.revision,
      {
        ...control.state,
        proof: {
          ...control.state.proof,
          protocol_version: 1,
          db_runtime: normalized
        }
      },
      ctx
    );
    return normalized;
  }

  private async seed(
    ctx: MembershipPrimaryContext
  ): Promise<MembershipRunSeed> {
    const seed = await this.evaluator.captureProfile(
      emptyTarget.target_id,
      ctx
    );
    const order = await new MembershipEvaluationInputsDb(this.db).groupOrder(
      ctx
    );
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

  private async acquire() {
    return this.tx(async (ctx) => {
      const control = await this.control(ctx);
      const now = await this.runs.now(ctx);
      const previous = control.state.proof?.db_runtime;
      if (
        previous?.owner &&
        BigInt(previous.owner.expires_at_millis) > BigInt(now)
      )
        throw new Error(
          'Membership database proof already has an active invocation'
        );
      const owner = {
        request_id: this.owner,
        expires_at_millis: String(
          BigInt(now) + BigInt(Math.floor(this.deadline - performance.now()))
        )
      };
      if (previous) return this.save(control, { ...previous, owner }, ctx);
      const sources = await new MembershipSourceStatesDb(() => this.db).read(
        MEMBERSHIP_FIXTURE_SOURCE_KEYS,
        false,
        ctx
      );
      requireProof(
        sources.every(
          (entry) => entry.provisioned && entry.state?.active_jobs === 0
        )
      );
      for (const profile of MEMBERSHIP_FIXTURE_PROFILES)
        requireProof(await this.settled(profile, ctx));
      const full = await this.runs.target(
        { scope: 'FULL', target_id: '*' },
        false,
        ctx
      );
      requireProof(
        full &&
          full.requested_version === full.completed_version &&
          full.active_run_id === null
      );
      await this.targets.request(
        [{ ...emptyTarget, reason: 'fixture-db-lease-proof-v1' }],
        ctx
      );
      const claim = await this.runs.claim(
        emptyTarget,
        LEASE_MILLIS,
        (primary) => this.seed(primary),
        ctx
      );
      requireProof(claim);
      const run = await this.runs.run(claim.run_id, false, ctx);
      requireProof(run?.lease_expires_at_millis);
      return this.save(
        control,
        {
          protocol_version: 1,
          phase: 'LEASE_WAIT',
          owner,
          lease: {
            run_id: claim.run_id,
            checkpoint_version: claim.checkpoint_version,
            lease_token: claim.lease_token,
            claimed_at_millis: run.created_at_millis,
            expires_at_millis: run.lease_expires_at_millis,
            request_version: run.request_version,
            successor_checkpoint_version: null,
            checkpoint_fenced: false,
            completion_fenced: false,
            failure_fenced: false
          },
          gc: null,
          completed_at_millis: null,
          interruption: null
        },
        ctx
      );
    });
  }

  private async settled(profile: string, ctx: MembershipPrimaryContext) {
    const target = await this.runs.target(
      { scope: 'PROFILE', target_id: profile },
      false,
      ctx
    );
    if (
      !target ||
      target.active_run_id !== null ||
      target.requested_version !== target.completed_version
    )
      return false;
    const snapshot = await this.publication(profile, ctx);
    if (!snapshot) return false;
    const run = await this.runs.run(snapshot.run_id, false, ctx);
    return (
      run?.status === 'COMPLETED' &&
      run.request_version === target.completed_version
    );
  }

  private async publication(
    profile: string,
    ctx: MembershipPrimaryContext
  ): Promise<Snapshot | null> {
    const publication = await this.db.oneOrNull<{ run_id: string }>(
      `SELECT run_id FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} WHERE profile_id=:profile`,
      { profile },
      membershipQueryOptions(ctx)
    );
    if (!publication) return null;
    const members = await this.members(publication.run_id, ctx);
    return {
      run_id: publication.run_id,
      members,
      hash: createHash('sha256').update(JSON.stringify(members)).digest('hex')
    };
  }

  private async members(run: string, ctx: MembershipPrimaryContext) {
    const rows = await this.db.execute<{ group_id: string }>(
      `SELECT m.group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} m FORCE INDEX(PRIMARY) WHERE m.run_id=:run ORDER BY m.group_id LIMIT 37`,
      { run },
      membershipQueryOptions(ctx)
    );
    requireProof(
      rows.length <= 36 &&
        rows.every((row) => MEMBERSHIP_FIXTURE_GROUPS.includes(row.group_id))
    );
    return rows.map((row) => row.group_id);
  }

  private async connectionId(ctx: MembershipPrimaryContext) {
    const row = await this.db.oneOrNull<{ id: string }>(
      'SELECT CAST(CONNECTION_ID() AS CHAR) id',
      {},
      membershipQueryOptions(ctx)
    );
    return normalizeCounter(row?.id);
  }

  private async waitUntil(until: string) {
    for (let polls = 0; polls < 421; polls++) {
      this.requireTime(10000);
      const now = await this.tx(async (ctx) => {
        this.owned(await this.control(ctx));
        return this.runs.now(ctx);
      });
      const wait = Number(BigInt(until) - BigInt(now));
      if (wait <= 0) return;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(wait, 2000))
      );
    }
    throw new Error('Membership database proof wait exceeds bound');
  }

  private workerOptions(deadline = this.deadline): MembershipWorkerOptions {
    return {
      deadline_monotonic_millis: deadline,
      transaction_millis: 15000,
      max_statement_millis: 1000,
      finalization_reserve_millis: 2000,
      checkpoint_reserve_millis: 2000,
      lock_wait_seconds: 1,
      lease_millis: LEASE_MILLIS,
      max_quanta: 1,
      page_size: 2,
      input_limits: {
        max_queries: 300,
        max_input_rows: 100000,
        max_input_bytes: 8000000,
        max_windows: 100,
        raw_window: 128
      },
      retry_millis: 60000,
      max_attempts: 3
    };
  }

  private async work(profile: string, deadline = this.deadline) {
    if (++this.workerCalls > 64)
      throw new Error('Membership proof worker quantum bound reached');
    this.requireTime(10000);
    const result = await this.worker.runTarget(
      { scope: 'PROFILE', target_id: profile },
      this.workerOptions(deadline)
    );
    if (result.outcome === 'FAILED' || result.outcome === 'SUPERSEDED')
      throw new Error(
        'Membership database proof worker did not preserve its generation'
      );
    return result;
  }

  private async step(
    proof: MembershipFixtureDbProof
  ): Promise<MembershipFixtureDbProof> {
    switch (proof.phase) {
      case 'LEASE_WAIT':
        return this.reclaim(proof);
      case 'LEASE_REPLAY':
        return this.replay(proof);
      case 'EMPTY_SETTLE':
        return this.beginReaderProof(proof);
      case 'GC_OVERLAP':
        return this.readerProof(proof);
      case 'GC_GRACE':
        return this.collect(proof);
      default:
        return proof;
    }
  }

  private async reclaim(proof: MembershipFixtureDbProof) {
    await this.waitUntil(proof.lease.expires_at_millis);
    let run = await this.tx((ctx) =>
      this.runs.run(proof.lease.run_id, false, ctx)
    );
    requireProof(
      run &&
        run.scope === 'PROFILE' &&
        run.target_id === emptyTarget.target_id &&
        run.request_version === proof.lease.request_version
    );
    if (run.checkpoint_version === proof.lease.checkpoint_version) {
      await this.work(emptyTarget.target_id);
      run = await this.tx((ctx) =>
        this.runs.run(proof.lease.run_id, false, ctx)
      );
    }
    requireProof(
      run &&
        run.scope === 'PROFILE' &&
        run.target_id === emptyTarget.target_id &&
        run.request_version === proof.lease.request_version &&
        ['PENDING', 'COMPLETED'].includes(run.status) &&
        BigInt(run.processed_count) > BigInt(0) &&
        run.lease_token !== proof.lease.lease_token &&
        BigInt(run.checkpoint_version) > BigInt(proof.lease.checkpoint_version)
    );
    return this.tx(async (ctx) => {
      const control = await this.control(ctx);
      const current = this.owned(control);
      return this.save(
        control,
        {
          ...current,
          phase: 'LEASE_REPLAY',
          lease: {
            ...current.lease,
            successor_checkpoint_version: run!.checkpoint_version
          }
        },
        ctx
      );
    });
  }

  private claim(proof: MembershipFixtureDbProof): MembershipWorkerClaim {
    requireProof(proof.lease.lease_token);
    return {
      target: emptyTarget,
      run_id: proof.lease.run_id,
      lease_token: proof.lease.lease_token,
      checkpoint_version: proof.lease.checkpoint_version
    };
  }

  private async authority(ctx: MembershipPrimaryContext, runId: string) {
    return JSON.stringify({
      target: await this.runs.target(emptyTarget, true, ctx),
      run: await this.runs.run(runId, true, ctx),
      publication: await this.publication(emptyTarget.target_id, ctx)
    });
  }

  private async fenced(
    claim: MembershipWorkerClaim,
    action: 'checkpoint' | 'complete' | 'fail'
  ) {
    const before = await this.tx((ctx) => this.authority(ctx, claim.run_id));
    let rejected = false;
    try {
      await this.tx(async (ctx) => {
        const run = await this.runs.run(claim.run_id, false, ctx);
        requireProof(run);
        if (action === 'checkpoint') {
          await this.runs.checkpoint(
            claim,
            run.progress_cursor,
            [],
            0,
            run.valid_until_millis,
            ctx
          );
          throw new Error('Stale membership checkpoint unexpectedly accepted');
        } else if (action === 'complete') {
          await new MembershipWorkerSourcesDb(() => this.db).validateSources(
            run,
            true,
            ctx
          );
          await this.runs.complete(claim, true, ctx);
          throw new Error('Stale membership completion unexpectedly accepted');
        } else {
          const result = await this.runs.fail(
            emptyTarget,
            claim,
            null,
            {
              error_code: 'fixture-old-lease-v1',
              supersede: false,
              retry_millis: 60000,
              max_attempts: 3,
              park: false
            },
            ctx
          );
          requireProof(result === 'FENCED');
          rejected = true;
        }
      });
    } catch (error) {
      if (!(error instanceof MembershipWorkerError) || error.code !== 'FENCED')
        throw error;
      rejected = true;
    }
    requireProof(rejected);
    const after = await this.tx((ctx) => this.authority(ctx, claim.run_id));
    requireProof(before === after);
  }

  private async replay(proof: MembershipFixtureDbProof) {
    const run = await this.tx((ctx) =>
      this.runs.run(proof.lease.run_id, false, ctx)
    );
    requireProof(
      run &&
        run.scope === 'PROFILE' &&
        run.target_id === emptyTarget.target_id &&
        run.request_version === proof.lease.request_version &&
        BigInt(run.checkpoint_version) >=
          BigInt(proof.lease.successor_checkpoint_version!)
    );
    const claim = this.claim(proof);
    await this.fenced(claim, 'checkpoint');
    await this.fenced(claim, 'complete');
    await this.fenced(claim, 'fail');
    return this.tx(async (ctx) => {
      const control = await this.control(ctx);
      const current = this.owned(control);
      return this.save(
        control,
        {
          ...current,
          phase: 'EMPTY_SETTLE',
          lease: {
            ...current.lease,
            lease_token: null,
            checkpoint_fenced: true,
            completion_fenced: true,
            failure_fenced: true
          }
        },
        ctx
      );
    });
  }

  private async finishProfile(
    profile: string,
    requestVersion: string,
    deadline = this.deadline
  ) {
    for (let i = 0; i < 24; i++) {
      if (
        await this.tx(async (ctx) => {
          const target = await this.runs.target(
            { scope: 'PROFILE', target_id: profile },
            false,
            ctx
          );
          requireProof(target?.requested_version === requestVersion);
          return this.settled(profile, ctx);
        })
      )
        return;
      if (performance.now() + 10000 >= deadline)
        throw new Error('Membership reader overlap time exhausted');
      const result = await this.work(profile, deadline);
      if (result.outcome === 'NO_WORK')
        throw new Error(
          'Membership proof target is reserved by another invocation'
        );
    }
    throw new Error('Membership proof profile continuation bound reached');
  }

  private async beginReaderProof(proof: MembershipFixtureDbProof) {
    await this.finishProfile(
      emptyTarget.target_id,
      proof.lease.request_version
    );
    return this.tx(async (ctx) => {
      const control = await this.control(ctx);
      const proof = this.owned(control);
      const empty = await this.publication(emptyTarget.target_id, ctx);
      requireProof(empty?.members.length === 0);
      requireProof(await this.settled(longTarget.target_id, ctx));
      const old = await this.publication(longTarget.target_id, ctx);
      requireProof(old && old.members.length > 0);
      await this.targets.request(
        [{ ...longTarget, reason: 'fixture-db-reader-proof-v1' }],
        ctx
      );
      const target = await this.runs.target(longTarget, false, ctx);
      requireProof(target);
      return this.save(
        control,
        {
          ...proof,
          phase: 'GC_OVERLAP',
          gc: {
            old_run_id: old.run_id,
            request_version: target.requested_version,
            new_run_id: null,
            member_count: old.members.length,
            member_hash: old.hash,
            reader_connection_id: null,
            writer_connection_id: null,
            reader_verified_at_millis: null,
            retired_at_millis: null,
            eligible_at_millis: null,
            deleted_count: 0
          }
        },
        ctx
      );
    });
  }

  private async readerProof(proof: MembershipFixtureDbProof) {
    requireProof(proof.gc);
    const before = await this.tx((ctx) =>
      this.publication(longTarget.target_id, ctx)
    );
    if (before?.run_id !== proof.gc.old_run_id)
      return this.tx(async (ctx) => {
        const control = await this.control(ctx);
        return this.save(
          control,
          {
            ...this.owned(control),
            phase: 'INTERRUPTED',
            interruption: 'READER_OVERLAP_LOST'
          },
          ctx
        );
      });
    const readerDeadline = Math.min(
      this.deadline - 10000,
      performance.now() + READER_MILLIS
    );
    return withMembershipPrimaryTransaction(
      this.db,
      async (reader) => {
        this.owned(await this.control(reader));
        const old = await this.publication(longTarget.target_id, reader);
        requireProof(
          old &&
            old.run_id === proof.gc!.old_run_id &&
            old.hash === proof.gc!.member_hash
        );
        const readerId = await this.connectionId(reader);
        await this.finishProfile(
          longTarget.target_id,
          proof.gc!.request_version,
          readerDeadline - 5000
        );
        const observed = await this.tx(async (ctx) => {
          const current = await this.publication(longTarget.target_id, ctx);
          requireProof(
            current &&
              current.run_id !== old.run_id &&
              current.hash === old.hash
          );
          const gc = new MembershipGcDb(() => this.db);
          const retired = await gc.collect(
            { target: longTarget, run_id: old.run_id, pending: null },
            gcOptions,
            ctx
          );
          requireProof(
            retired.outcome === 'RETIRED' || retired.outcome === 'TOO_YOUNG'
          );
          const protectedRun = await gc.collect(
            { target: longTarget, run_id: current.run_id, pending: null },
            gcOptions,
            ctx
          );
          requireProof(protectedRun.outcome === 'PROTECTED');
          const oldRun = await this.runs.run(old.run_id, false, ctx);
          requireProof(oldRun?.progress_cursor.gc && retired.retry_at_millis);
          return {
            current,
            writerId: await this.connectionId(ctx),
            retiredAt: oldRun.progress_cursor.gc.retired_at_millis,
            eligibleAt: retired.retry_at_millis
          };
        });
        requireProof(readerId !== observed.writerId);
        const stillOld = await this.publication(longTarget.target_id, reader);
        requireProof(
          stillOld &&
            stillOld.run_id === old.run_id &&
            stillOld.hash === old.hash
        );
        const verifiedAt = await this.runs.now(reader);
        requireProof(BigInt(verifiedAt) < BigInt(observed.eligibleAt));
        return this.tx(async (ctx) => {
          const control = await this.control(ctx);
          const current = this.owned(control);
          requireProof(current.gc);
          return this.save(
            control,
            {
              ...current,
              phase: 'GC_GRACE',
              gc: {
                ...current.gc,
                new_run_id: observed.current.run_id,
                reader_connection_id: readerId,
                writer_connection_id: observed.writerId,
                reader_verified_at_millis: verifiedAt,
                retired_at_millis: observed.retiredAt,
                eligible_at_millis: observed.eligibleAt
              }
            },
            ctx
          );
        });
      },
      {},
      {
        deadlineMonotonicMillis: readerDeadline,
        maxStatementMillis: 1000,
        finalizationReserveMillis: 2000,
        lockWaitSeconds: 1
      }
    );
  }

  private async collect(proof: MembershipFixtureDbProof) {
    requireProof(proof.gc?.eligible_at_millis && proof.gc.new_run_id);
    await this.waitUntil(proof.gc.eligible_at_millis);
    await new MembershipRunGarbageCollector(this.db).run(
      gcOptions,
      this.workerOptions()
    );
    return this.tx(async (ctx) => {
      const control = await this.control(ctx);
      const current = this.owned(control);
      requireProof(current.gc);
      const old = await this.runs.run(current.gc.old_run_id, false, ctx);
      const publication = await this.publication(longTarget.target_id, ctx);
      requireProof(
        publication &&
          publication.run_id === current.gc.new_run_id &&
          publication.hash === current.gc.member_hash
      );
      const remaining = await this.members(current.gc.old_run_id, ctx);
      requireProof(
        remaining.length <= current.gc.member_count &&
          (old !== null || remaining.length === 0)
      );
      const now = await this.runs.now(ctx);
      return this.save(
        control,
        {
          ...current,
          phase: old ? 'GC_GRACE' : 'DONE',
          completed_at_millis: old ? null : now,
          gc: {
            ...current.gc,
            deleted_count: current.gc.member_count - remaining.length
          }
        },
        ctx
      );
    });
  }
}
