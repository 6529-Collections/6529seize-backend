import { RequestContext } from '@/request.context';
import { ConnectionWrapper, dbSupplier } from '@/sql-executor';
import { createHash } from 'node:crypto';
import {
  withMembershipPrimaryMutationContext,
  withMembershipPrimaryTransaction
} from './membership-primary';
import { isMembershipSourceTrackingActive } from './membership-producer-policy';
import { MembershipSourceJobsDb } from './membership-source-jobs.db';
import {
  MEMBERSHIP_CATALOG_KEY,
  MembershipGroupChange,
  MembershipSourceMutation,
  MembershipSourceStatesDb
} from './membership-source-states.db';
import { MembershipSourceDimension } from './membership-schema.types';
import { MembershipSourceKey } from './membership-validation';

const sources = new MembershipSourceStatesDb(dbSupplier);
const jobs = new MembershipSourceJobsDb(dbSupplier);

export async function getActiveMembershipGlobalJobId(
  dimension: MembershipSourceDimension,
  ctx: RequestContext = {}
): Promise<string | null> {
  if (!isMembershipSourceTrackingActive()) return null;
  return withMembershipPrimaryTransaction(
    dbSupplier(),
    (primary) => jobs.findActiveGlobalJobId(dimension, primary),
    ctx
  );
}

export function membershipProducerJobId(
  producer: string,
  identity: readonly (string | number)[]
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 32);
  return `${producer}:${digest}`;
}

/**
 * Invoke at the beginning of an existing primary write transaction. The
 * tracking branch fails closed if a required source has not been provisioned.
 */
export async function withMembershipSourceMutation<T>(
  connection: ConnectionWrapper<unknown>,
  mutation: MembershipSourceMutation | null,
  write: () => Promise<T>,
  ctx: RequestContext = {}
): Promise<T> {
  if (!mutation || !isMembershipSourceTrackingActive()) return write();
  // Existing writers commonly carry the transaction in their request context.
  // The adapter receives that transaction separately and requires requestCtx
  // itself to be connection-free.
  const { connection: _connection, ...requestCtx } = ctx;
  return withMembershipPrimaryMutationContext(
    connection,
    (primary) => sources.mutate(mutation, write, primary),
    requestCtx
  );
}

/** Version every group whose REP/CIC rule is rewritten by a profile merge. */
export async function withMembershipProfileRuleReferenceMutation<T>(
  connection: ConnectionWrapper<unknown>,
  sourceProfileId: string,
  write: () => Promise<T>,
  ctx: RequestContext = {}
): Promise<T> {
  if (!isMembershipSourceTrackingActive()) return write();
  const { connection: _connection, ...requestCtx } = ctx;
  return withMembershipPrimaryMutationContext(
    connection,
    (primary) =>
      sources.mutateProfileRuleReferences(sourceProfileId, write, primary),
    requestCtx
  );
}

export function membershipProfileMutation(
  profileIds: readonly string[],
  dimensions: readonly MembershipSourceDimension[],
  reason: string
): MembershipSourceMutation {
  const ids = Array.from(new Set(profileIds.filter(Boolean))).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  if (!ids.length || ids.length * dimensions.length > 64 || ids.length > 128)
    return membershipGlobalMutation(dimensions, reason);
  const keys: MembershipSourceKey[] = ids.flatMap((target_id) =>
    dimensions.map((dimension) => ({ scope: 'PROFILE', target_id, dimension }))
  );
  return {
    keys,
    requests: ids.map((target_id) => ({
      scope: 'PROFILE',
      target_id,
      reason
    }))
  };
}

export function membershipGlobalMutation(
  dimensions: readonly MembershipSourceDimension[],
  reason: string
): MembershipSourceMutation {
  return {
    keys: dimensions.map((dimension) => ({
      scope: 'GLOBAL',
      target_id: '*',
      dimension
    })),
    requests: [{ scope: 'FULL', target_id: '*', reason }]
  };
}

export function membershipCatalogueMutation(
  changes: readonly MembershipGroupChange[],
  reason: string
): MembershipSourceMutation {
  if (!changes.length || changes.length > 128)
    throw new Error('Membership catalogue mutation requires 1 to 128 groups');
  return {
    keys: [MEMBERSHIP_CATALOG_KEY],
    group_changes: changes,
    requests: changes.map(({ group_id }) => ({
      scope: 'GROUP',
      target_id: group_id,
      reason
    }))
  };
}

/**
 * A multi-commit writer keeps a durable GLOBAL barrier until its whole
 * idempotent cycle succeeds. A crash before completion replays the same cycle.
 * Callers must derive jobId from the source range and make write() replay safe.
 */
export async function runMembershipGlobalSourceJob(
  jobId: string,
  dimensions: readonly MembershipSourceDimension[],
  reason: string,
  write: (ctx: RequestContext) => Promise<void>,
  ctx: RequestContext = {},
  options: {
    readonly atomicWrite?: boolean;
    readonly complete?: (ctx: RequestContext) => Promise<void>;
  } = {}
): Promise<void> {
  if (!isMembershipSourceTrackingActive()) {
    await write(ctx);
    await options.complete?.(ctx);
    return;
  }
  const identity = {
    job_id: jobId,
    keys: membershipGlobalMutation(dimensions, reason).keys
  };
  // Keep the TypeORM loop module out of API reader module initialization.
  // Only active tracked producer jobs need its dedicated advisory-lock handle.
  const { getDataSource } = await import('@/db');
  const runner = getDataSource().createQueryRunner();
  await runner.connect();
  const lockName = `membership-producer:${createHash('sha256').update(jobId).digest('hex').slice(0, 32)}`;
  let acquired = false;
  try {
    const lock: Array<{ acquired: number }> = await runner.query(
      'SELECT GET_LOCK(?, 0) acquired',
      [lockName]
    );
    acquired = Number(lock[0]?.acquired) === 1;
    if (!acquired)
      throw new Error('Membership producer cycle is already running');
    const started = await withMembershipPrimaryTransaction(
      dbSupplier(),
      async (primary) => {
        const current = await jobs.start(
          identity,
          { stage: 'STARTED', after_id: null },
          primary
        );
        return current.status === 'FAILED'
          ? jobs.resume(identity, current.progress, primary)
          : current;
      },
      ctx
    );
    if (started.status === 'COMPLETED') return;
    try {
      if (!options.atomicWrite) await write(ctx);
      await withMembershipPrimaryTransaction(
        dbSupplier(),
        (primary) =>
          jobs
            .complete(
              identity,
              started.progress,
              [{ scope: 'FULL', target_id: '*', reason }],
              async () => {
                if (options.atomicWrite) await write(primary);
                await options.complete?.(primary);
              },
              primary
            )
            .then(() => undefined),
        ctx
      );
    } catch (error) {
      try {
        await withMembershipPrimaryTransaction(
          dbSupplier(),
          (primary) =>
            jobs
              .fail(identity, started.progress, 'SOURCE_WRITE_FAILED', primary)
              .then(() => undefined),
          ctx
        );
      } catch {
        // A RUNNING or FAILED barrier remains authoritative until repair.
      }
      throw error;
    }
  } finally {
    if (acquired) {
      await runner.query('SELECT RELEASE_LOCK(?) released', [lockName]);
    }
    await runner.release();
  }
}
