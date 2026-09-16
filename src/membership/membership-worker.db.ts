import { randomUUID } from 'node:crypto';
import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE
} from '@/constants';
import { MembershipRefreshTargetEntity } from '@/entities/IMembershipRefreshTarget';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import {
  MEMBERSHIP_DB_NOW,
  timeMembershipOperation
} from './membership-repository.utils';
import {
  MembershipRefreshTargetKey,
  assertMembershipBoundedInteger,
  assertMembershipId,
  normalizeCounter,
  normalizeRefreshTarget
} from './membership-validation';
import {
  MembershipDeliveryDescriptor,
  MembershipWorkerClaim,
  MembershipWorkerCursor,
  MembershipWorkerError,
  MembershipWorkerRun
} from './membership-worker.types';
import {
  membershipAddCounter,
  normalizeMembershipWorkerCursor,
  normalizeMembershipWorkerRun
} from './membership-worker-validation';

export const MEMBERSHIP_RUN_SELECT = `id, scope, target_id, status, spec_version, source_versions, progress_cursor,
 CAST(request_version AS CHAR) request_version, CAST(catalog_version AS CHAR) catalog_version,
 CAST(evaluation_time_millis AS CHAR) evaluation_time_millis, CAST(valid_until_millis AS CHAR) valid_until_millis,
 lease_token, CAST(lease_expires_at_millis AS CHAR) lease_expires_at_millis,
 CAST(checkpoint_version AS CHAR) checkpoint_version, CAST(processed_count AS CHAR) processed_count,
 CAST(created_at_millis AS CHAR) created_at_millis, CAST(updated_at_millis AS CHAR) updated_at_millis,
 CAST(completed_at_millis AS CHAR) completed_at_millis`;

export type MembershipRunSeed = Pick<
  MembershipWorkerRun,
  | 'spec_version'
  | 'catalog_version'
  | 'source_versions'
  | 'progress_cursor'
  | 'evaluation_time_millis'
>;
export interface MembershipLockedClaim {
  readonly run: MembershipWorkerRun;
  readonly target: MembershipRefreshTargetEntity;
  readonly now: string;
}

/** All write methods obtain target then run locks; final callers lock sources first. */
export class MembershipWorkerDb extends LazyDbAccessCompatibleService {
  async now(ctx: MembershipPrimaryContext): Promise<string> {
    const row = await this.db.oneOrNull<{ now: string }>(
      `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
      {},
      membershipQueryOptions(ctx)
    );
    return normalizeCounter(row?.now);
  }

  async target(
    key: MembershipRefreshTargetKey,
    lock: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipRefreshTargetEntity | null> {
    return timeMembershipOperation(
      'MembershipWorkerDb->target',
      ctx,
      async () => {
        const target = normalizeRefreshTarget(key);
        const row = await this.db.oneOrNull<MembershipRefreshTargetEntity>(
          `SELECT scope,target_id,CAST(requested_version AS CHAR) requested_version,CAST(completed_version AS CHAR) completed_version,
          active_run_id,CAST(available_at_millis AS CHAR) available_at_millis,reason,attempts,last_error,
          CAST(created_at_millis AS CHAR) created_at_millis,CAST(updated_at_millis AS CHAR) updated_at_millis
         FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} WHERE scope=:scope AND target_id=:target_id ${lock ? 'FOR UPDATE NOWAIT' : ''}`,
          target,
          membershipQueryOptions(ctx)
        );
        if (!row) return null;
        if (row.scope !== target.scope || row.target_id !== target.target_id)
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership target identity mismatch'
          );
        normalizeCounter(row.requested_version);
        normalizeCounter(row.completed_version);
        if (BigInt(row.completed_version) > BigInt(row.requested_version))
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership target acknowledgments exceed requests'
          );
        assertMembershipBoundedInteger(
          row.attempts,
          'attempt count',
          0,
          2147483647
        );
        if (row.available_at_millis !== null)
          normalizeCounter(row.available_at_millis);
        return row;
      }
    );
  }

  async run(
    id: string,
    lock: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipWorkerRun | null> {
    return timeMembershipOperation('MembershipWorkerDb->run', ctx, async () => {
      assertMembershipId(id, 'run ID', 36);
      const row = await this.db.oneOrNull<MembershipWorkerRun>(
        `SELECT ${MEMBERSHIP_RUN_SELECT} FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} WHERE id=:id ${lock ? 'FOR UPDATE NOWAIT' : ''}`,
        { id },
        membershipQueryOptions(ctx)
      );
      return row === null ? null : normalizeMembershipWorkerRun(row);
    });
  }

  async claim(
    key: MembershipRefreshTargetKey,
    leaseMillis: number,
    seed: (ctx: MembershipPrimaryContext) => Promise<MembershipRunSeed>,
    ctx: MembershipPrimaryContext,
    delivery?: MembershipDeliveryDescriptor
  ): Promise<MembershipWorkerClaim | null> {
    return timeMembershipOperation(
      'MembershipWorkerDb->claim',
      ctx,
      async () => {
        const target = await this.target(key, true, ctx);
        const now = await this.now(ctx);
        if (
          target?.available_at_millis == null ||
          BigInt(target.requested_version) <= BigInt(target.completed_version)
        )
          return null;
        if (delivery) {
          if (
            normalizeCounter(delivery.requested_version) !==
              target.requested_version ||
            normalizeCounter(delivery.reserved_until_millis) !==
              target.available_at_millis
          )
            return null;
        } else if (BigInt(target.available_at_millis) > BigInt(now))
          return null;
        // A matching queue reservation only bypasses scheduling suppression.
        // A live run lease remains the exclusion authority.
        const run =
          target.active_run_id === null
            ? null
            : await this.run(target.active_run_id, true, ctx);
        if (target.active_run_id !== null && !run)
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership active run is missing'
          );
        if (
          run &&
          (run.scope !== key.scope ||
            run.target_id !== key.target_id ||
            !['PENDING', 'RUNNING'].includes(run.status))
        )
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership active run is inconsistent'
          );
        if (
          run?.status === 'RUNNING' &&
          run.lease_expires_at_millis !== null &&
          BigInt(run.lease_expires_at_millis) > BigInt(now)
        )
          return null;
        const token = randomUUID();
        const expiry = membershipAddCounter(now, leaseMillis);
        const id = run?.id ?? randomUUID();
        if (run) {
          await this.db.execute(
            `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET status='RUNNING',lease_token=:token,lease_expires_at_millis=:expiry,updated_at_millis=:now WHERE id=:id`,
            { id, token, expiry, now },
            membershipQueryOptions(ctx)
          );
        } else {
          await this.allocate(
            target,
            id,
            token,
            expiry,
            now,
            await seed(ctx),
            ctx
          );
        }
        await this.db.execute(
          `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET active_run_id=:id,available_at_millis=:expiry,updated_at_millis=:now WHERE scope=:scope AND target_id=:target_id`,
          { ...key, id, expiry, now },
          membershipQueryOptions(ctx)
        );
        return {
          target: key,
          run_id: id,
          lease_token: token,
          checkpoint_version: run?.checkpoint_version ?? '0'
        };
      }
    );
  }

  private async allocate(
    target: MembershipRefreshTargetEntity,
    id: string,
    token: string,
    expiry: string,
    now: string,
    seed: MembershipRunSeed,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const row: MembershipWorkerRun = {
      ...seed,
      id,
      scope: target.scope,
      target_id: target.target_id,
      request_version: target.requested_version,
      status: 'RUNNING',
      valid_until_millis: null,
      lease_token: token,
      lease_expires_at_millis: expiry,
      checkpoint_version: '0',
      processed_count: '0',
      created_at_millis: now,
      updated_at_millis: now,
      completed_at_millis: null
    };
    normalizeMembershipWorkerRun(row);
    await this.db.execute(
      `INSERT INTO ${MEMBERSHIP_REFRESH_RUNS_TABLE}
      (id,scope,target_id,request_version,status,spec_version,catalog_version,source_versions,progress_cursor,evaluation_time_millis,
       valid_until_millis,lease_token,lease_expires_at_millis,checkpoint_version,processed_count,created_at_millis,updated_at_millis,completed_at_millis)
      VALUES (:id,:scope,:target_id,:request_version,'RUNNING',:spec_version,:catalog_version,:source_versions,:progress_cursor,:evaluation_time_millis,
       NULL,:lease_token,:lease_expires_at_millis,0,0,:created_at_millis,:updated_at_millis,NULL)`,
      {
        ...row,
        source_versions: JSON.stringify(row.source_versions),
        progress_cursor: JSON.stringify(row.progress_cursor)
      },
      membershipQueryOptions(ctx)
    );
  }

  async lockClaim(
    claim: MembershipWorkerClaim,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipLockedClaim> {
    return timeMembershipOperation(
      'MembershipWorkerDb->lockClaim',
      ctx,
      async () => {
        const target = await this.target(claim.target, true, ctx);
        const run = await this.run(claim.run_id, true, ctx);
        const now = await this.now(ctx);
        if (
          !target ||
          !run ||
          target.active_run_id !== run.id ||
          run.scope !== claim.target.scope ||
          run.target_id !== claim.target.target_id ||
          run.status !== 'RUNNING' ||
          run.lease_token !== claim.lease_token ||
          run.checkpoint_version !==
            normalizeCounter(claim.checkpoint_version) ||
          run.lease_expires_at_millis === null ||
          BigInt(run.lease_expires_at_millis) <= BigInt(now)
        ) {
          throw new MembershipWorkerError(
            'FENCED',
            'Membership claim is no longer current'
          );
        }
        if (BigInt(run.request_version) > BigInt(target.requested_version))
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership run exceeds requested version'
          );
        if (BigInt(run.request_version) <= BigInt(target.completed_version))
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership active run was already acknowledged'
          );
        return { target, run, now };
      }
    );
  }

  async checkpoint(
    claim: MembershipWorkerClaim,
    cursor: MembershipWorkerCursor,
    groups: readonly string[],
    processed: number,
    horizon: string | null,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipWorkerRun> {
    return timeMembershipOperation(
      'MembershipWorkerDb->checkpoint',
      ctx,
      async () => {
        const { run, now } = await this.lockClaim(claim, ctx);
        assertMembershipBoundedInteger(
          processed,
          'page processed count',
          0,
          128
        );
        if (groups.length > processed || new Set(groups).size !== groups.length)
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Invalid membership candidate member batch'
          );
        const normalized = normalizeMembershipWorkerCursor(cursor);
        if (
          normalized.kind !== run.progress_cursor.kind ||
          normalized.through_id !== run.progress_cursor.through_id ||
          normalized.traversal_collation !==
            run.progress_cursor.traversal_collation
        )
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership immutable cursor changed'
          );
        if (
          normalized.kind === 'PROFILE' &&
          run.progress_cursor.kind === 'PROFILE' &&
          normalized.identity_consolidation_key !==
            run.progress_cursor.identity_consolidation_key
        )
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership canonical identity changed'
          );
        if (
          run.progress_cursor.phase !== 'SCAN' ||
          normalized.phase === 'DONE' ||
          normalized.gc !== undefined
        )
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Invalid membership checkpoint transition'
          );
        if (
          horizon !== null &&
          BigInt(normalizeCounter(horizon)) <= BigInt(now)
        )
          throw new MembershipWorkerError(
            'EXPIRED',
            'Membership evaluation horizon has passed'
          );
        if (
          run.valid_until_millis !== null &&
          (horizon === null || BigInt(horizon) > BigInt(run.valid_until_millis))
        )
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership horizon cannot advance'
          );
        if (groups.length) await this.insertMembers(run, groups, ctx);
        const checkpoint = membershipAddCounter(run.checkpoint_version, 1);
        const count = membershipAddCounter(run.processed_count, processed);
        await this.db.execute(
          `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET progress_cursor=:cursor,valid_until_millis=:horizon,
        checkpoint_version=:checkpoint,processed_count=:count,status='PENDING',lease_token=NULL,lease_expires_at_millis=NULL,updated_at_millis=:now WHERE id=:id`,
          {
            id: run.id,
            cursor: JSON.stringify(normalized),
            horizon,
            checkpoint,
            count,
            now
          },
          membershipQueryOptions(ctx)
        );
        await this.db.execute(
          `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET available_at_millis=:now,updated_at_millis=:now WHERE scope=:scope AND target_id=:target_id`,
          { ...claim.target, now },
          membershipQueryOptions(ctx)
        );
        return {
          ...run,
          progress_cursor: normalized,
          valid_until_millis: horizon,
          checkpoint_version: checkpoint,
          processed_count: count,
          status: 'PENDING',
          lease_token: null,
          lease_expires_at_millis: null,
          updated_at_millis: now
        };
      }
    );
  }

  private async insertMembers(
    run: MembershipWorkerRun,
    groups: readonly string[],
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    if (run.scope !== 'PROFILE')
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Fanout cannot create members'
      );
    for (const group of groups)
      assertMembershipId(group, 'member group ID', 200);
    const params: Record<string, string> = {
      run: run.id,
      profile: run.target_id
    };
    const values = groups.map((group, i) => {
      params[`g${i}`] = group;
      return `(:run,:g${i},:profile)`;
    });
    await this.db.execute(
      `INSERT INTO ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} (run_id,group_id,profile_id) VALUES ${values.join(',')}`,
      params,
      membershipQueryOptions(ctx)
    );
  }

  /** Source guards must already be held before this method is called. */
  async complete(
    claim: MembershipWorkerClaim,
    publish: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipWorkerRun> {
    return timeMembershipOperation(
      'MembershipWorkerDb->complete',
      ctx,
      async () => {
        const { run, target, now } = await this.lockClaim(claim, ctx);
        if (
          run.progress_cursor.phase !== 'READY_TO_FINISH' ||
          publish !== (run.scope === 'PROFILE')
        )
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Membership completion requires explicit exhaustion'
          );
        if (
          run.valid_until_millis !== null &&
          BigInt(run.valid_until_millis) <= BigInt(now)
        )
          throw new MembershipWorkerError(
            'EXPIRED',
            'Membership publication horizon has passed'
          );
        if (publish)
          await this.db.execute(
            `INSERT INTO ${MEMBERSHIP_PUBLICATIONS_TABLE} (profile_id,run_id,published_at_millis)
        VALUES (:profile,:run,:now) ON DUPLICATE KEY UPDATE run_id=VALUES(run_id),published_at_millis=VALUES(published_at_millis)`,
            { profile: run.target_id, run: run.id, now },
            membershipQueryOptions(ctx)
          );
        const cursor = { ...run.progress_cursor, phase: 'DONE' as const };
        const checkpoint = membershipAddCounter(run.checkpoint_version, 1);
        await this.db.execute(
          `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET status='COMPLETED',progress_cursor=:cursor,checkpoint_version=:checkpoint,
        lease_token=NULL,lease_expires_at_millis=NULL,completed_at_millis=:now,updated_at_millis=:now WHERE id=:id`,
          { id: run.id, cursor: JSON.stringify(cursor), checkpoint, now },
          membershipQueryOptions(ctx)
        );
        // lockClaim proved this run's version exceeds completed_version while
        // holding the target lock. Assign exactly; GREATEST with a bound decimal
        // string can compare lexically (for example keeping 8 instead of 10).
        const newerRequest =
          BigInt(target.requested_version) > BigInt(run.request_version);
        // A grant start/expiry is a future source input even without another
        // writer. Keep one durable PROFILE request due at that horizon. A newer
        // request already in flight supersedes this timer and will capture its
        // own horizon when it publishes; do not add a duplicate request here.
        const scheduleHorizon =
          publish && !newerRequest && run.valid_until_millis !== null;
        let availableAt: string | null = null;
        if (newerRequest) availableAt = now;
        else if (scheduleHorizon) availableAt = run.valid_until_millis;
        await this.db.execute(
          `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET completed_version=:version,active_run_id=NULL,
        requested_version=:requested,available_at_millis=:available,reason=:reason,
        attempts=:attempts,last_error=:error,updated_at_millis=:now
        WHERE scope=:scope AND target_id=:target_id`,
          {
            ...claim.target,
            version: run.request_version,
            requested: scheduleHorizon
              ? membershipAddCounter(run.request_version, 1)
              : target.requested_version,
            available: availableAt,
            reason: scheduleHorizon ? 'grant-time-boundary' : target.reason,
            attempts: newerRequest ? target.attempts : 0,
            error: newerRequest ? target.last_error : null,
            now
          },
          membershipQueryOptions(ctx)
        );
        return {
          ...run,
          progress_cursor: cursor,
          checkpoint_version: checkpoint,
          status: 'COMPLETED',
          lease_token: null,
          lease_expires_at_millis: null,
          completed_at_millis: now,
          updated_at_millis: now
        };
      }
    );
  }

  async fail(
    key: MembershipRefreshTargetKey,
    claim: MembershipWorkerClaim | null,
    expectedRequest: string | null,
    failure: {
      error_code: string;
      supersede: boolean;
      retry_millis: number;
      max_attempts: number;
      park: boolean;
    },
    ctx: MembershipPrimaryContext
  ): Promise<'PENDING' | 'FAILED' | 'SUPERSEDED' | 'FENCED'> {
    const {
      error_code: errorCode,
      supersede,
      retry_millis: retryMillis,
      max_attempts: maxAttempts,
      park
    } = failure;
    return timeMembershipOperation(
      'MembershipWorkerDb->fail',
      ctx,
      async () => {
        const target = await this.target(key, true, ctx);
        if (!target) return 'FENCED';
        let version = expectedRequest;
        let run: MembershipWorkerRun | null = null;
        if (claim) {
          run = await this.run(claim.run_id, true, ctx);
          if (
            target.active_run_id !== run?.id ||
            run.lease_token !== claim.lease_token ||
            run.checkpoint_version !== claim.checkpoint_version ||
            run.status !== 'RUNNING'
          )
            return 'FENCED';
          version = run.request_version;
        } else if (target.active_run_id !== null || expectedRequest === null)
          return 'FENCED';
        const now = await this.now(ctx);
        if (
          run &&
          (run.lease_expires_at_millis === null ||
            BigInt(run.lease_expires_at_millis) <= BigInt(now))
        )
          return 'FENCED';
        const newer =
          version !== null &&
          BigInt(target.requested_version) > BigInt(version);
        const attempts = newer ? target.attempts : target.attempts + 1;
        // Retry state belongs to the latest request. Retaining a failed older
        // run while preserving that reset would give the old run infinite free
        // retries and prevent the newer request from ever allocating a run.
        const { outcome, available } = this.failurePlan(
          newer,
          supersede,
          park,
          attempts,
          maxAttempts,
          now,
          retryMillis
        );
        const terminal = outcome !== 'PENDING';
        if (run)
          await this.db.execute(
            `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} SET status=:status,lease_token=NULL,lease_expires_at_millis=NULL,
        checkpoint_version=checkpoint_version+1,updated_at_millis=:now,completed_at_millis=:completed WHERE id=:id`,
            {
              id: run.id,
              status: outcome,
              now,
              completed: terminal ? now : null
            },
            membershipQueryOptions(ctx)
          );
        await this.db.execute(
          `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET active_run_id=:active,available_at_millis=:available,attempts=:attempts,
        last_error=:error,updated_at_millis=:now WHERE scope=:scope AND target_id=:target_id`,
          {
            ...key,
            active: !terminal && run ? run.id : null,
            available,
            attempts,
            error: newer ? target.last_error : errorCode.slice(0, 200),
            now
          },
          membershipQueryOptions(ctx)
        );
        return outcome;
      }
    );
  }

  private failurePlan(
    newer: boolean,
    supersede: boolean,
    park: boolean,
    attempts: number,
    maxAttempts: number,
    now: string,
    retryMillis: number
  ): {
    outcome: 'SUPERSEDED' | 'FAILED' | 'PENDING';
    available: string | null;
  } {
    if (newer || supersede) return { outcome: 'SUPERSEDED', available: now };
    if (park || attempts >= maxAttempts)
      return { outcome: 'FAILED', available: null };
    return {
      outcome: 'PENDING',
      available: membershipAddCounter(now, retryMillis)
    };
  }

  /** Park contradictory persisted state without inventing a run transition. */
  async parkMalformedTarget(
    key: MembershipRefreshTargetKey,
    expectedRequest: string | null,
    ctx: MembershipPrimaryContext
  ): Promise<boolean> {
    return timeMembershipOperation(
      'MembershipWorkerDb->parkMalformedTarget',
      ctx,
      async () => {
        const target = await this.target(key, true, ctx);
        if (
          !target ||
          expectedRequest === null ||
          target.requested_version !== expectedRequest
        )
          return false;
        await this.db.execute(
          `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET available_at_millis=NULL,last_error='INTEGRITY',attempts=attempts+1,
        updated_at_millis=${MEMBERSHIP_DB_NOW} WHERE scope=:scope AND target_id=:target_id`,
          key,
          membershipQueryOptions(ctx)
        );
        return true;
      }
    );
  }
}
