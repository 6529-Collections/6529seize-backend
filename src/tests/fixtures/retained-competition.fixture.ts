/** Historical source shapes exist only in disposable contract fixtures. These
 * helpers seed accepted native snapshots; no deployment or application imports them. */
import type { SqlExecutor } from '@/sql-executor';
import { sqlExecutor } from '@/sql-executor';
import {
  RETIRED_COMPETITION_COLUMNS,
  RETIRED_COMPETITION_TABLES
} from '@/competitions/retired-competition-storage';
import {
  legacyCompetitionEntryId,
  legacyCompetitionOutcomeId,
  legacyCompetitionDistributionItemId
} from '@/competitions/competition-id';

const historical = require('./retired-competition-schema.fixture.json') as {
  definitions: string[];
  columns: Record<string, { name: string; definition: string }[]>;
};

function assertDisposable() {
  if (
    process.env.NODE_ENV !== 'local' ||
    !process.env.DB_NAME?.includes('_jest_worker_')
  )
    throw new Error(
      'Historical schema fixtures require a disposable Jest database'
    );
}

export async function installHistoricalCompetitionFixture() {
  assertDisposable();
  for (const statement of historical.definitions)
    await sqlExecutor.execute(
      statement.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')
    );
  for (const [table, columns] of Object.entries(historical.columns)) {
    const existing = await sqlExecutor.execute<{ name: string }>(
      'select COLUMN_NAME as name from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME=:table',
      { table }
    );
    for (const column of columns) {
      if (existing.some(({ name }) => name === column.name)) continue;
      const definition =
        column.name === 'storage_mode'
          ? "`storage_mode` varchar(32) NOT NULL DEFAULT 'NATIVE'"
          : column.definition;
      await sqlExecutor.execute(
        `alter table \`${table}\` add column ${definition}`
      );
    }
  }
}

export async function removeHistoricalCompetitionFixture() {
  assertDisposable();
  for (const table of RETIRED_COMPETITION_TABLES)
    await sqlExecutor.execute(`drop table if exists \`${table}\``);
  for (const [table, columns] of Object.entries(RETIRED_COMPETITION_COLUMNS)) {
    const existing = await sqlExecutor.execute<{ name: string }>(
      'select COLUMN_NAME as name from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME=:table',
      { table }
    );
    const retired = existing.filter(({ name }) => columns.includes(name));
    if (retired.length)
      await sqlExecutor.execute(
        `alter table \`${table}\` ${retired.map(({ name }) => `drop column \`${name}\``).join(',')}`
      );
  }
}

export function withHistoricalCompetitionFixture() {
  beforeEach(installHistoricalCompetitionFixture);
  afterEach(removeHistoricalCompetitionFixture);
}

export const historicalCompetitionFixture = {
  beforeSeed: installHistoricalCompetitionFixture,
  afterSeed: removeHistoricalCompetitionFixture
};

async function originalOwners(db: SqlExecutor, competitionId?: string) {
  assertDisposable();
  return db.execute<{ id: string; wave_id: string }>(
    `select id,wave_id from competitions where legacy_wave_id=wave_id
     and (:competitionId is null or id=:competitionId) order by id`,
    { competitionId: competitionId ?? null }
  );
}

export async function seedRetainedScoreFixture(
  db: SqlExecutor,
  competitionId?: string
) {
  for (const owner of await originalOwners(db, competitionId)) {
    for (const [table, kind, voter] of [
      ['drop_real_vote_in_time', 'AGGREGATE', "''"],
      ['drop_real_voter_vote_in_time', 'VOTER', 'source.voter_id']
    ]) {
      await db.execute(
        `insert ignore into competition_score_history
         (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at)
         select :id,:kind,source.id,e.id,source.drop_id,${voter},source.vote,source.timestamp
         from ${table} source left join competition_entries e on e.competition_id=:id and e.drop_id=source.drop_id
         where source.wave_id=:wave_id`,
        { ...owner, kind }
      );
    }
    await db.execute(
      `update profile_activity_logs set competition_id=:id where additional_data_2=:wave_id and type='DROP_VOTE_EDIT'`,
      owner
    );
  }
}

export async function seedRetainedDistributionFixture(
  db: SqlExecutor,
  competitionId?: string
) {
  const reports: { competition_id: string; rows: number }[] = [];
  for (const owner of await originalOwners(db, competitionId)) {
    const rows = await db.execute<{
      outcome_position: number;
      position: number;
      amount: number | null;
      description: string | null;
    }>(
      `select wave_outcome_position as outcome_position,wave_outcome_distribution_item_position as position,amount,description
       from wave_outcome_distribution_items source where wave_id=:wave_id and not exists
       (select 1 from competition_outcomes parent where parent.competition_id=:id and parent.position=source.wave_outcome_position)`,
      owner
    );
    for (const row of rows) {
      const outcomeId = legacyCompetitionOutcomeId(
        owner.id,
        row.outcome_position
      );
      await db.execute(
        `insert ignore into competition_outcome_distribution_items
         (id,competition_id,outcome_id,outcome_position,position,amount,description)
         values (:itemId,:id,:outcomeId,:outcome_position,:position,:amount,:description)`,
        {
          ...owner,
          ...row,
          itemId: legacyCompetitionDistributionItemId(outcomeId, row.position),
          outcomeId
        }
      );
    }
    reports.push({ competition_id: owner.id, rows: rows.length });
  }
  return reports;
}

export async function seedRetainedPublicationFixture(
  db: SqlExecutor,
  competitionId?: string
) {
  for (const owner of await originalOwners(db, competitionId)) {
    await db.execute(
      `update competition_leaderboard_entries lb join competition_entries e on e.id=lb.entry_id and e.competition_id=lb.competition_id
       join competitions c on c.id=lb.competition_id
       left join wave_leaderboard_entries source on source.wave_id=c.wave_id and source.drop_id=e.drop_id
       set lb.published_at=coalesce(source.timestamp,lb.updated_at)
       where c.id=:id and e.status='ACTIVE' and lb.published_at is null and
       (source.drop_id is not null or (cast(json_unquote(json_extract(c.decision_config,'$.time_lock_ms')) as signed)>0 and lb.updated_at>e.submitted_at))`,
      owner
    );
    const rows = await db.execute<{
      drop_id: string;
      vote: number;
      vote_on_decision_time: number;
      timestamp: number;
      over_threshold_since_ms: number | null;
    }>(
      `select source.* from wave_leaderboard_entries source where wave_id=:wave_id
       and not exists(select 1 from competition_entries e where e.competition_id=:id and e.drop_id=source.drop_id)`,
      owner
    );
    for (const row of rows)
      await db.execute(
        `insert ignore into competition_leaderboard_entries
         (competition_id,entry_id,drop_id,rating,real_time_rating,submitted_at,updated_at,ordering_time,decision_rating,published_at,over_threshold_since)
         values (:id,:entryId,:drop_id,:vote,:vote,:timestamp,:timestamp,:timestamp,:vote_on_decision_time,:timestamp,:over_threshold_since_ms)`,
        {
          ...owner,
          ...row,
          entryId: legacyCompetitionEntryId(owner.id, row.drop_id)
        }
      );
  }
}
