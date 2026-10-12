import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  DROPS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { CompetitionRecord } from './competition.repository';
import { withNativeLegacyMirror } from './legacy-competition-mirror';
import { withoutLegacyCompetitionGetFacade } from './legacy-competition-get-facade';
import { CompetitionMigrationBackfill } from './competition-migration-backfill';

/** Identity consolidation keeps its accepted legacy semantics. Lock every
 * affected primary before the profile operation, and merge native state in
 * the same transaction. Frozen GET projection must never be the write source. */
export async function withLegacyCompetitionProfileMerge<T>(
  db: SqlExecutor,
  sources: readonly string[],
  target: string,
  action: () => Promise<T>,
  ctx: RequestContext
): Promise<T> {
  if (!sources.length) return action();
  if (!ctx.connection) throw new Error('Profile merge requires a transaction');
  const options = { wrappedConnection: ctx.connection };
  return withoutLegacyCompetitionGetFacade(async () => {
    const records = await db.execute<CompetitionRecord>(
      `select c.* from ${COMPETITIONS_TABLE} c where c.legacy_wave_id is not null and (
        exists(select 1 from ${DROPS_TABLE} d where d.wave_id=c.wave_id and d.author_id in (:sources)) or
        ${[DROP_VOTER_STATE_TABLE, DROPS_VOTES_CREDIT_SPENDINGS_TABLE, DROP_REAL_VOTER_VOTE_IN_TIME_TABLE, WINNER_DROP_VOTER_VOTES_TABLE].map((table) => `exists(select 1 from ${table} v where v.wave_id=c.wave_id and v.voter_id in (:sources))`).join(' or ')} or
        exists(select 1 from ${COMPETITION_WINNER_VOTES_TABLE} v where v.competition_id=c.id and v.voter_profile_id in (:sources)))
        order by c.id for update`,
      { sources },
      options
    );
    const native = records.filter((record) => record.storage_mode === 'NATIVE');
    const run = async (index: number): Promise<T> => {
      const record = native[index];
      if (record)
        return withNativeLegacyMirror(db, record.id, ctx, () => run(index + 1));
      const result = await action();
      for (const competition of native)
        await reconcileProfile(db, competition, sources, target, ctx);
      return result;
    };
    return run(0);
  });
}

async function reconcileProfile(
  db: SqlExecutor,
  record: CompetitionRecord,
  sources: readonly string[],
  target: string,
  ctx: RequestContext
): Promise<void> {
  const options = { wrappedConnection: ctx.connection },
    params = { id: record.id, sources, target };
  const backfill = new CompetitionMigrationBackfill(db);
  // Native submissions to the migrated primary also have a compatibility
  // voter ledger, but their entry IDs are deterministic from their drop IDs.
  const drops = await db.execute<{ drop_id: string }>(
    `select distinct e.drop_id from ${COMPETITION_ENTRIES_TABLE} e where e.competition_id=:id and (e.submitter_id in (:sources) or exists(select 1 from ${COMPETITION_VOTES_TABLE} v where v.entry_id=e.id and v.voter_profile_id in (:sources))) order by e.drop_id limit 1001`,
    params,
    options
  );
  if (drops.length > 1000)
    throw new Error(
      'OWNED_EXCEPTION: profile consolidation exceeds bounded migrated cohort'
    );
  for (const drop of drops) {
    for (const source of sources)
      await backfill.vote(record, drop.drop_id, source, ctx);
    await backfill.vote(record, drop.drop_id, target, ctx);
  }
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
  for (const source of sources) {
    await db.execute(
      `insert into ${COMPETITION_WINNER_VOTES_TABLE} (competition_id,decision_id,entry_id,voter_profile_id,value)
      select archived.competition_id,archived.decision_id,archived.entry_id,:target,archived.value from ${COMPETITION_WINNER_VOTES_TABLE} archived where archived.competition_id=:id and archived.voter_profile_id=:source
      on duplicate key update value=${COMPETITION_WINNER_VOTES_TABLE}.value+values(value)`,
      { ...params, source },
      options
    );
    await db.execute(
      `delete from ${COMPETITION_WINNER_VOTES_TABLE} where competition_id=:id and voter_profile_id=:source`,
      { ...params, source },
      options
    );
  }
}
