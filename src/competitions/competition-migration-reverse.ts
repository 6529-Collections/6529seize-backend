import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import {
  COMPETITION_ENTRIES_TABLE,
  DROPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  LEGACY_GET_SOURCE_TABLES,
  legacyGetView
} from '@/competitions/legacy-competition-get-facade';
import { withNativeLegacyMirror } from '@/competitions/legacy-competition-mirror';

function verifiedColumn(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value))
    throw new Error('OWNED_EXCEPTION: unsafe reverse reconciliation column');
  return value;
}

function reverseCopyFilter(table: string): string {
  if (table === WAVES_TABLE) return 'id=:waveId';
  if (table === DROPS_TABLE)
    return `wave_id=:waveId and id in (select drop_id from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id)`;
  return 'wave_id=:waveId';
}
async function assertReversePrimaryDropTypes(
  db: SqlExecutor,
  id: string,
  waveId: string,
  ctx: RequestContext
): Promise<void> {
  const timerName = 'assertReversePrimaryDropTypes';
  ctx.timer?.start(timerName);
  try {
    const nativeCreated = await db.oneOrNull<{ id: string }>(
      `select d.id from ${DROPS_TABLE} d join ${COMPETITION_ENTRIES_TABLE} e on e.drop_id=d.id
       where e.competition_id=:id and d.wave_id=:waveId and d.drop_type='COMPETITION' limit 1`,
      { id, waveId },
      { wrappedConnection: ctx.connection }
    );
    if (nativeCreated)
      throw new Error(
        'OWNED_EXCEPTION: reverse reconciliation cannot change native-created primary drop types; retain native ownership for reviewed repair'
      );
  } finally {
    ctx.timer?.stop(timerName);
  }
}

export type ReverseCheckpoint = {
  index: number;
  phase: 'PRUNE' | 'COPY';
  cursor: string | null;
};

/** Native ownership is retained throughout preparation. Each batch holds the
 * same ownership lock as commands; a final independent comparison is required
 * because native writes can occur between these bounded transactions. */
export async function reconcileLegacyBatch(
  db: SqlExecutor,
  id: string,
  waveId: string,
  checkpoint: ReverseCheckpoint,
  limit: number,
  ctx: RequestContext
): Promise<ReverseCheckpoint> {
  const table = LEGACY_GET_SOURCE_TABLES[checkpoint.index];
  if (!table) throw new Error('Invalid reverse reconciliation checkpoint');
  const view = legacyGetView(table);
  const options = { wrappedConnection: ctx.connection };
  const primary = await db.execute<{ COLUMN_NAME: string }>(
    `select COLUMN_NAME from information_schema.KEY_COLUMN_USAGE
     where TABLE_SCHEMA=database() and TABLE_NAME=:table and CONSTRAINT_NAME='PRIMARY'
     order by ORDINAL_POSITION`,
    { table },
    options
  );
  if (!primary.length)
    throw new Error('Reverse reconciliation requires a stable source key');
  const keys = primary.map((row) => verifiedColumn(row.COLUMN_NAME));
  const filter = table === WAVES_TABLE ? 'id=:waveId' : 'wave_id=:waveId';
  const equal = keys
    .map((key) => `v.\`${key}\` <=> s.\`${key}\``)
    .join(' and ');
  return withNativeLegacyMirror(db, id, ctx, async () => {
    if (checkpoint.phase === 'PRUNE') {
      // Hub content is shared. Competition withdrawal never deletes a drop.
      if (table === WAVES_TABLE || table === DROPS_TABLE)
        return { ...checkpoint, phase: 'COPY', cursor: null };
      const stale = await db.execute<Record<string, unknown>>(
        `select ${keys.map((key) => `s.\`${key}\``).join(',')} from \`${table}\` s
         where s.${filter} and not exists(select 1 from \`${view}\` v where ${equal})
         order by ${keys.map((key) => `s.\`${key}\``).join(',')} limit :limit`,
        { waveId, limit },
        options
      );
      for (const row of stale) {
        await db.execute(
          `delete from \`${table}\` where ${keys.map((key) => `\`${key}\`=:${key}`).join(' and ')}`,
          row,
          options
        );
      }
      return stale.length === limit
        ? checkpoint
        : { ...checkpoint, phase: 'COPY', cursor: null };
    }
    // Only materialize this primary's entry projection. Shared chat and sibling
    // native COMPETITION drops are immutable source content, not rollback data.
    if (table === DROPS_TABLE)
      await assertReversePrimaryDropTypes(db, id, waveId, ctx);
    const copyFilter = reverseCopyFilter(table);
    const cursor =
      checkpoint.cursor === null
        ? null
        : (JSON.parse(checkpoint.cursor) as unknown[]);
    const keyFilter =
      cursor === null
        ? ''
        : `and (${keys.map((key) => `\`${key}\``).join(',')}) > (${keys.map((_, index) => `:key${index}`).join(',')})`;
    const rows = await db.execute<Record<string, unknown>>(
      `select * from \`${view}\` where ${copyFilter} ${keyFilter}
       order by ${keys.map((key) => `\`${key}\``).join(',')} limit :limit`,
      {
        id,
        waveId,
        limit,
        ...Object.fromEntries(
          (cursor ?? []).map((value, index) => [`key${index}`, value])
        )
      },
      options
    );
    for (const row of rows) {
      const columns = Object.keys(row).map(verifiedColumn);
      const values = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value
        ])
      );
      await db.execute(
        `insert into \`${table}\` (${columns.map((column) => `\`${column}\``).join(',')})
         values (${columns.map((column) => `:${column}`).join(',')}) on duplicate key update
         ${columns
           .filter((column) => !keys.includes(column))
           .map((column) => `\`${column}\`=values(\`${column}\`)`)
           .join(',')}`,
        values,
        options
      );
    }
    return rows.length === limit
      ? {
          ...checkpoint,
          cursor: JSON.stringify(keys.map((key) => rows[rows.length - 1][key]))
        }
      : { index: checkpoint.index + 1, phase: 'PRUNE', cursor: null };
  });
}
