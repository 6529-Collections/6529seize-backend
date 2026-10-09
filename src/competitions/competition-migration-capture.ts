import { withMigrationSchemaConnection } from './competition-migration-schema';
import { createHash } from 'node:crypto';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_MIGRATIONS_TABLE,
  COMPETITION_MIGRATION_CHANGES_TABLE,
  COMPETITION_LEGACY_MIRROR_PERMITS_TABLE,
  WAVES_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_MENTIONED_GROUPS_TABLE,
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
} from '@/constants';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';

export const MIGRATION_CONTENT_TABLES = [
  DROPS_PARTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_MENTIONED_GROUPS_TABLE
] as const;
export function isMigrationContentTable(table: string): boolean {
  return MIGRATION_CONTENT_TABLES.some((source) => source === table);
}

export const MIGRATION_SOURCE_TABLES = [
  ...MIGRATION_CONTENT_TABLES,
  WAVES_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  DROPS_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  DROP_RANK_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
] as const;
const EVENTS = ['INSERT', 'UPDATE', 'DELETE'] as const;
const CAPTURE_VERSION = 'legacy-migration-capture-v1';

function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value))
    throw new Error('Unsafe capture identifier');
  return `\`${value}\``;
}
export function migrationTriggerName(table: string, operation: string): string {
  const suffix = createHash('sha256')
    .update(`${CAPTURE_VERSION}:${table}:${operation}`)
    .digest('hex')
    .slice(0, 16);
  return `competition_capture_${suffix}`;
}
function image(columns: readonly string[], row: 'OLD' | 'NEW'): string {
  return `JSON_OBJECT(${columns.map((column) => `'${column}', ${row}.${identifier(column)}`).join(', ')})`;
}
function capturesCompetition(
  table: string,
  operation: string,
  columns: readonly string[]
): string {
  if (isMigrationContentTable(table))
    return `exists(select 1 from ${DROPS_TABLE} where id=${operation === 'DELETE' ? 'OLD' : 'NEW'}.drop_id and drop_type in ('PARTICIPATORY','WINNER'))`;
  if (table === DROPS_TABLE) {
    const rows =
      operation === 'UPDATE'
        ? ['OLD', 'NEW']
        : [operation === 'DELETE' ? 'OLD' : 'NEW'];
    return `(${rows.map((row) => `${row}.drop_type in ('PARTICIPATORY', 'WINNER')`).join(' or ')})`;
  }
  if (table !== WAVES_TABLE || operation !== 'UPDATE') return 'true';
  const competitionColumns = columns.filter((column) =>
    /^(name|updated_at|type|participation_|voting_|decisions_|next_decision_time|winning_|max_winners|time_lock_ms|max_votes_per_identity_to_drop|forbid_negative_votes|submission_type|identity_submission_)/.test(
      column
    )
  );
  return `(${competitionColumns.map((column) => `not (OLD.${identifier(column)} <=> NEW.${identifier(column)})`).join(' or ')})`;
}

/** DDL runs only during additive schema deployment. No competition is enrolled. */
export async function installMigrationCapture(
  db: SqlExecutor = dbSupplier()
): Promise<void> {
  await withMigrationSchemaConnection(db, async ({ connection }) => {
    const options = { wrappedConnection: connection };
    for (const table of MIGRATION_SOURCE_TABLES) {
      const columns = await db.execute<{ COLUMN_NAME: string }>(
        'select COLUMN_NAME from information_schema.COLUMNS where TABLE_SCHEMA = database() and TABLE_NAME = :table order by ORDINAL_POSITION asc',
        { table },
        options
      );
      if (!columns.length)
        throw new Error(`Missing migration source schema: ${table}`);
      const names = columns.map((column) => column.COLUMN_NAME);
      for (const operation of EVENTS) {
        const name = migrationTriggerName(table, operation);
        const [existing] = await db.execute<{ ACTION_STATEMENT: string }>(
          'select ACTION_STATEMENT from information_schema.TRIGGERS where TRIGGER_SCHEMA = database() and TRIGGER_NAME = :name',
          { name },
          options
        );
        const statement = migrationCaptureStatement(table, operation, names);
        if (existing) {
          if (
            existing.ACTION_STATEMENT.replace(/\s+/g, ' ').trim() !==
            statement.replace(/\s+/g, ' ').trim()
          )
            throw new Error(
              `Migration capture schema drift: ${name}; deploy a versioned replacement`
            );
          continue;
        }
        await db.execute(
          `create trigger ${identifier(name)} after ${operation} on ${identifier(table)} for each row ${statement}`,
          {},
          options
        );
      }
    }
  });
}

export function migrationCaptureStatement(
  table: string,
  operation: string,
  columns: readonly string[]
): string {
  if (
    !MIGRATION_SOURCE_TABLES.some((source) => source === table) ||
    !EVENTS.some((event) => event === operation)
  )
    throw new Error('Unsupported capture source');
  const row = operation === 'DELETE' ? 'OLD' : 'NEW';
  const waveOf = (source: 'OLD' | 'NEW') =>
    isMigrationContentTable(table)
      ? `(select wave_id from ${DROPS_TABLE} where id=${source}.drop_id)`
      : `${source}.${identifier(table === WAVES_TABLE ? 'id' : 'wave_id')}`;
  const wave = waveOf(row);
  const before = operation === 'INSERT' ? 'null' : image(columns, 'OLD');
  const after = operation === 'DELETE' ? 'null' : image(columns, 'NEW');
  const sharedDropMutation =
    table === DROPS_TABLE
      ? operation === 'UPDATE'
        ? '(OLD.drop_type <=> NEW.drop_type) and (OLD.wave_id <=> NEW.wave_id) and (OLD.id <=> NEW.id)'
        : operation === 'DELETE'
          ? `not exists(select 1 from ${COMPETITION_ENTRIES_TABLE} where competition_id=competition_id_value and drop_id=OLD.id)`
          : 'false'
      : 'false';
  const keyMoved =
    table === DROPS_TABLE
      ? `not (OLD.id <=> NEW.id) or not (${waveOf('OLD')} <=> ${waveOf('NEW')})`
      : `not (${waveOf('OLD')} <=> ${waveOf('NEW')})`;
  return `BEGIN
    DECLARE owner_mode varchar(32) DEFAULT null;
    DECLARE competition_id_value varchar(36) DEFAULT null;
    DECLARE watermark_value bigint DEFAULT null;
    ${operation === 'UPDATE' ? `IF (${keyMoved}) AND EXISTS (select 1 from ${COMPETITION_MIGRATIONS_TABLE} where wave_id in (${waveOf('OLD')},${waveOf('NEW')})) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='COMPETITION_SOURCE_KEY_MOVE_REQUIRES_REPAIR'; END IF;` : ''}
    IF ${capturesCompetition(table, operation, columns)} AND EXISTS (select 1 from ${COMPETITION_MIGRATIONS_TABLE} where wave_id = ${wave}) THEN
      select id, storage_mode into competition_id_value, owner_mode from ${COMPETITIONS_TABLE} where legacy_wave_id = ${wave} for update;
      IF owner_mode = 'NATIVE' AND NOT (${sharedDropMutation}) AND NOT EXISTS (select 1 from ${COMPETITION_LEGACY_MIRROR_PERMITS_TABLE} where connection_id=connection_id() and competition_id=competition_id_value) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'COMPETITION_NATIVE_OWNER_RETRY';
      END IF;
      IF owner_mode = 'LEGACY_ADAPTER' THEN
        update ${COMPETITION_MIGRATIONS_TABLE} set source_watermark = source_watermark + 1, updated_at = unix_timestamp(current_timestamp(3)) * 1000 where competition_id = competition_id_value;
        select source_watermark into watermark_value from ${COMPETITION_MIGRATIONS_TABLE} where competition_id = competition_id_value;
        insert into ${COMPETITION_MIGRATION_CHANGES_TABLE} (competition_id, watermark, source_table, operation, before_row, after_row, occurred_at)
          values (competition_id_value, watermark_value, '${table}', '${operation}', ${before}, ${after}, unix_timestamp(current_timestamp(3)) * 1000);
      END IF;
    END IF;
  END`;
}

export async function migrationCaptureHealthy(
  db: SqlExecutor,
  ctx: RequestContext
): Promise<boolean> {
  const rows = await db.execute<{
    TRIGGER_NAME: string;
    EVENT_OBJECT_TABLE: string;
    EVENT_MANIPULATION: string;
    ACTION_STATEMENT: string;
    ACTION_TIMING: string;
  }>(
    "select TRIGGER_NAME,EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_STATEMENT,ACTION_TIMING from information_schema.TRIGGERS where TRIGGER_SCHEMA=database() and TRIGGER_NAME like 'competition_capture_%'",
    {},
    { wrappedConnection: ctx.connection }
  );
  const schema = await db.execute<{ TABLE_NAME: string; COLUMN_NAME: string }>(
    'select TABLE_NAME,COLUMN_NAME from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME in (:tables) order by TABLE_NAME,ORDINAL_POSITION',
    { tables: MIGRATION_SOURCE_TABLES },
    { wrappedConnection: ctx.connection }
  );
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  for (const table of MIGRATION_SOURCE_TABLES) {
    const columns = schema.filter((column) => column.TABLE_NAME === table);
    if (!columns.length) return false;
    for (const operation of EVENTS) {
      const row = rows.find(
        (item) => item.TRIGGER_NAME === migrationTriggerName(table, operation)
      );
      if (
        !row ||
        row.EVENT_OBJECT_TABLE !== table ||
        row.EVENT_MANIPULATION !== operation ||
        row.ACTION_TIMING !== 'AFTER' ||
        normalize(row.ACTION_STATEMENT) !==
          normalize(
            migrationCaptureStatement(
              table,
              operation,
              columns.map((item) => item.COLUMN_NAME)
            )
          )
      )
        return false;
    }
  }
  return true;
}
