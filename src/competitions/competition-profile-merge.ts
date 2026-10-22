import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_WINNER_VOTES_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { mergePendingVotingCreditRecipients } from '@/notifications/voting-credit-returns-profile-merge';

/** Consolidation locks native competitions before shared profile/drop changes. */
export async function withCompetitionProfileMerge<T>(
  db: SqlExecutor,
  sources: readonly string[],
  target: string,
  action: () => Promise<T>,
  ctx: RequestContext
): Promise<T> {
  if (!sources.length) return action();
  if (!ctx.connection) throw new Error('Profile merge requires a transaction');
  const options = { wrappedConnection: ctx.connection };
  const records = await db.execute<{ id: string }>(
    `select c.id from ${COMPETITIONS_TABLE} c where c.storage_mode='NATIVE' and (
      exists(select 1 from ${COMPETITION_ENTRIES_TABLE} e where e.competition_id=c.id and e.submitter_id in (:sources)) or
      exists(select 1 from ${COMPETITION_VOTES_TABLE} v where v.competition_id=c.id and v.voter_profile_id in (:sources)) or
      exists(select 1 from ${COMPETITION_VOTE_HISTORY_TABLE} v where v.competition_id=c.id and (v.voter_profile_id in (:sources) or v.submitter_id in (:sources))) or
      exists(select 1 from ${COMPETITION_SCORE_HISTORY_TABLE} v where v.competition_id=c.id and v.voter_profile_id in (:sources)) or
      exists(select 1 from ${COMPETITION_WINNER_VOTES_TABLE} v where v.competition_id=c.id and v.voter_profile_id in (:sources)))
      order by c.id for update`,
    { sources },
    options
  );
  await mergePendingVotingCreditRecipients(db, sources, target, ctx);
  const result = await action();
  for (const record of records) {
    const params = { id: record.id, sources, target };
    await db.execute(
      `update ${COMPETITION_ENTRIES_TABLE} set submitter_id=:target where competition_id=:id and submitter_id in (:sources)`,
      params,
      options
    );
    await db.execute(
      `update ${COMPETITION_VOTE_HISTORY_TABLE} set voter_profile_id=:target where competition_id=:id and voter_profile_id in (:sources)`,
      params,
      options
    );
    await db.execute(
      `update ${COMPETITION_VOTE_HISTORY_TABLE} set submitter_id=:target where competition_id=:id and submitter_id in (:sources)`,
      params,
      options
    );
    await db.execute(
      `update ${COMPETITION_SCORE_HISTORY_TABLE} set voter_profile_id=:target where competition_id=:id and voter_profile_id in (:sources)`,
      params,
      options
    );
    for (const source of sources.filter((id) => id !== target)) {
      for (const table of [
        COMPETITION_VOTES_TABLE,
        COMPETITION_WINNER_VOTES_TABLE
      ]) {
        const columns =
          table === COMPETITION_VOTES_TABLE
            ? 'id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at'
            : 'competition_id,decision_id,entry_id,voter_profile_id,value';
        const values =
          table === COMPETITION_VOTES_TABLE
            ? 'uuid(),source_vote.competition_id,source_vote.entry_id,:target,source_vote.value,source_vote.credit_spent,source_vote.created_at,source_vote.updated_at'
            : 'source_vote.competition_id,source_vote.decision_id,source_vote.entry_id,:target,source_vote.value';
        const spending =
          table === COMPETITION_VOTES_TABLE
            ? `,credit_spent=abs(${table}.value)`
            : '';
        await db.execute(
          `insert into ${table} (${columns}) select ${values} from ${table} source_vote where source_vote.competition_id=:id and source_vote.voter_profile_id=:source on duplicate key update value=${table}.value+values(value)${spending}`,
          { ...params, source },
          options
        );
        await db.execute(
          `delete from ${table} where competition_id=:id and voter_profile_id=:source`,
          { ...params, source },
          options
        );
      }
    }
  }
  return result;
}
