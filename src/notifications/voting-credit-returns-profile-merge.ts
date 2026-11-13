import {
  VOTING_CREDIT_RELEASES_TABLE,
  VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE
} from '@/constants';
import type { RequestContext } from '@/request.context';
import type { SqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';

/** Run before moving existing notifications, inside the profile merge transaction. */
export async function mergePendingVotingCreditRecipients(
  db: SqlExecutor,
  sourceProfileIds: readonly string[],
  target: string,
  ctx: RequestContext
): Promise<void> {
  const sources = sourceProfileIds.filter((id) => id !== target);
  if (!sources.length) return;
  if (!ctx.connection)
    throw new Error('Pending credit-return transfer requires a transaction');
  const options = { wrappedConnection: ctx.connection };
  const findReleases = `select r.id from ${VOTING_CREDIT_RELEASES_TABLE} r
     where r.completed_at is null and exists (
       select 1 from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE} p
       where p.release_id=r.id and p.voter_profile_id in (:sources))
     order by r.id`;
  // Consolidation may already have a REPEATABLE READ snapshot. Include both
  // current primary data and this transaction's own changes, without locking
  // the pending index or unrelated releases. The caller holds competition locks.
  const candidates = await Promise.all([
    db.execute<{ id: string }>(
      findReleases,
      { sources },
      {
        forcePool: DbPoolName.WRITE
      }
    ),
    db.execute<{ id: string }>(findReleases, { sources }, options)
  ]);
  const ids = Array.from(new Set(candidates.flat().map(({ id }) => id)));
  if (!ids.length) return;
  // A worker already delivering this release commits before notification IDs
  // are merged; otherwise it sees the transferred recipients after this commit.
  const releases = await db.execute<{ id: string }>(
    `select id from ${VOTING_CREDIT_RELEASES_TABLE} force index (primary)
     where id in (:ids) and completed_at is null order by id for update`,
    { ids },
    options
  );
  if (!releases.length) return;
  const params = { ids: releases.map(({ id }) => id), sources, target };
  await db.execute(
    `insert into ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}
       (release_id,voter_profile_id,amount)
     select release_id,:target,sum(amount)
     from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}
     where release_id in (:ids) and voter_profile_id in (:sources)
     group by release_id
     on duplicate key update amount=${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}.amount+values(amount)`,
    params,
    options
  );
  await db.execute(
    `delete from ${VOTING_CREDIT_RELEASE_RECIPIENTS_TABLE}
     where release_id in (:ids) and voter_profile_id in (:sources)`,
    params,
    options
  );
  // The retained profile may sort before the previous cursor. Delivered rows
  // have already been deleted, so restarting cannot recreate delivered credit.
  await db.execute(
    `update ${VOTING_CREDIT_RELEASES_TABLE} set after_profile_id='' where id in (:ids)`,
    params,
    options
  );
}
