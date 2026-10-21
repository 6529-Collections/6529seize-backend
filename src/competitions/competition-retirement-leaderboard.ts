import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  WAVES_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE
} from '@/constants';
import type { RequestContext } from '@/request.context';
import type { SqlExecutor } from '@/sql-executor';
import { legacyCompetitionEntryId } from './competition-id';

export type RetainedLeaderboardPublicationOptions = {
  readonly batchSize?: number;
  readonly onBatch?: (report: {
    competition_id: string;
    rows: number;
  }) => Promise<void>;
};
type Owner = { id: string; wave_id: string };
type SourceSnapshot = {
  drop_id: string;
  vote: string;
  vote_on_decision_time: string;
  timestamp: string;
  over_threshold_since_ms: string | null;
};

// These are the two publication branches of the frozen original-primary GET.
// A native weighted snapshot can already be public without a physical mirror.
const published = `original.drop_id is not null or (
  cast(coalesce(nullif(json_unquote(json_extract(c.decision_config,'$.time_lock_ms')),'null'),'0') as signed)>0
  and lb.updated_at>e.submitted_at)`;
const relations = `${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb
  join ${COMPETITIONS_TABLE} c on c.id=lb.competition_id
  join ${COMPETITION_ENTRIES_TABLE} e on e.id=lb.entry_id and e.competition_id=c.id
  left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} original
    on original.wave_id=c.wave_id and original.drop_id=e.drop_id`;
const missingEntry = `not exists(select 1 from ${COMPETITION_ENTRIES_TABLE} entry
  where entry.competition_id=:id and entry.drop_id=source.drop_id)`;

/** Explicit rolling preparation only. Retain accepted publications and orphan
 * snapshots without creating membership. Each bounded page releases its owner
 * lock before the next page; duplicate native snapshots must match exactly. */
export async function transferRetainedCompetitionLeaderboardPublication(
  db: SqlExecutor,
  competitionId?: string,
  ctx: RequestContext = {},
  options: RetainedLeaderboardPublicationOptions = {}
): Promise<{ competition_id: string; rows: number }[]> {
  if (ctx.connection)
    throw new Error(
      'Leaderboard transfer requires independent batch transactions'
    );
  const batchSize = options.batchSize ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error(
      'Leaderboard transfer batch size must be between 1 and 1000'
    );
  const timerName = 'transferRetainedCompetitionLeaderboardPublication';
  ctx.timer?.start(timerName);
  try {
    const owners = await db.execute<Owner>(
      `select c.id,c.wave_id from ${COMPETITIONS_TABLE} c join ${WAVES_TABLE} w on w.id=c.wave_id
       where c.storage_mode='NATIVE' and c.legacy_wave_id=c.wave_id
         and (:competitionId is null or c.id=:competitionId) order by c.id`,
      { competitionId: competitionId ?? null }
    );
    const reports: { competition_id: string; rows: number }[] = [];
    for (const owner of owners) {
      await retainActivePublications(db, owner, batchSize, ctx, options);
      const orphanRows = await retainOrphanSnapshots(
        db,
        owner,
        batchSize,
        ctx,
        options
      );
      const activeRows = await verifyActivePublications(db, owner);
      reports.push({ competition_id: owner.id, rows: activeRows + orphanRows });
    }
    return reports;
  } finally {
    ctx.timer?.stop(timerName);
  }
}

async function lockOwner(db: SqlExecutor, owner: Owner, ctx: RequestContext) {
  const locked = await db.oneOrNull<{ id: string }>(
    `select c.id from ${COMPETITIONS_TABLE} c join ${WAVES_TABLE} w on w.id=c.wave_id
     where c.id=:id and c.wave_id=:wave_id and c.storage_mode='NATIVE'
       and c.legacy_wave_id=c.wave_id for update`,
    owner,
    { wrappedConnection: ctx.connection }
  );
  if (!locked) throw new Error(`Competition ownership changed: ${owner.id}`);
}

async function retainActivePublications(
  db: SqlExecutor,
  owner: Owner,
  batchSize: number,
  ctx: RequestContext,
  options: RetainedLeaderboardPublicationOptions
) {
  let after: string | null = null;
  while (true) {
    const page = await db.executeNativeQueriesInTransaction(
      async (connection) => {
        const tx = { ...ctx, connection };
        await lockOwner(db, owner, tx);
        const rows = await db.execute<{
          entry_id: string;
          published_at: number | string;
        }>(
          `select lb.entry_id,coalesce(original.timestamp,lb.updated_at) as published_at
         from ${relations} where c.id=:id and e.status='ACTIVE'
           and lb.published_at is null and (${published})
           and (:after is null or lb.entry_id>:after)
         order by lb.entry_id limit :batchSize`,
          { id: owner.id, after, batchSize },
          { wrappedConnection: connection }
        );
        if (!rows.length) return rows;
        const values: Record<string, unknown> = {
          id: owner.id,
          entryIds: rows.map((row) => row.entry_id)
        };
        const cases = rows.map((row, index) => {
          values[`entry${index}`] = row.entry_id;
          values[`publication${index}`] = row.published_at;
          return `when :entry${index} then :publication${index}`;
        });
        await db.execute(
          `update ${COMPETITION_LEADERBOARD_ENTRIES_TABLE}
         set published_at=case entry_id ${cases.join(' ')} else published_at end
         where competition_id=:id and entry_id in (:entryIds) and published_at is null`,
          values,
          { wrappedConnection: connection }
        );
        return rows;
      }
    );
    if (!page.length) break;
    after = page[page.length - 1].entry_id;
    await options.onBatch?.({ competition_id: owner.id, rows: page.length });
    if (page.length < batchSize) break;
  }
}

function orphanSnapshot(
  owner: Owner,
  source: SourceSnapshot
): Record<string, string | null> {
  return {
    competition_id: owner.id,
    entry_id: legacyCompetitionEntryId(owner.id, source.drop_id),
    drop_id: source.drop_id,
    rating: source.vote,
    real_time_rating: source.vote,
    rank: null,
    submitted_at: source.timestamp,
    updated_at: source.timestamp,
    ordering_time: source.timestamp,
    decision_rating: source.vote_on_decision_time,
    published_at: source.timestamp,
    over_threshold_since: source.over_threshold_since_ms
  };
}

async function insertOrphanSnapshots(
  db: SqlExecutor,
  owner: Owner,
  source: SourceSnapshot[],
  ctx: RequestContext
) {
  const snapshots = source.map((row) => orphanSnapshot(owner, row));
  const entryIds = snapshots.map((row) => row.entry_id);
  const queryOptions = { wrappedConnection: ctx.connection };
  const collision = await db.oneOrNull<{ id: string }>(
    `select id from ${COMPETITION_ENTRIES_TABLE} where id in (:entryIds) limit 1`,
    { entryIds },
    queryOptions
  );
  if (collision)
    throw new Error(
      `Retained leaderboard identity has native membership: ${owner.id}`
    );
  const columns = Object.keys(snapshots[0]);
  await db.bulkInsert(
    COMPETITION_LEADERBOARD_ENTRIES_TABLE,
    snapshots,
    columns,
    ctx,
    { ignoreDuplicates: true }
  );
  const retained = await db.execute<Record<string, string | null>>(
    `select ${columns.map((column) => `cast(\`${column}\` as char) as \`${column}\``).join(',')}
     from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id and entry_id in (:entryIds)`,
    { id: owner.id, entryIds },
    queryOptions
  );
  const byEntry = new Map(retained.map((row) => [row.entry_id, row]));
  for (const expected of snapshots) {
    const actual = byEntry.get(expected.entry_id);
    if (
      !actual ||
      columns.some((column) => actual[column] !== expected[column])
    )
      throw new Error(
        `Retained orphan leaderboard parity failed for ${owner.id}:${expected.drop_id}`
      );
  }
}

async function retainOrphanSnapshots(
  db: SqlExecutor,
  owner: Owner,
  batchSize: number,
  ctx: RequestContext,
  options: RetainedLeaderboardPublicationOptions
): Promise<number> {
  let after: string | null = null;
  let copied = 0;
  while (true) {
    const page = await db.executeNativeQueriesInTransaction(
      async (connection) => {
        const tx = { ...ctx, connection };
        await lockOwner(db, owner, tx);
        const rows = await db.execute<SourceSnapshot>(
          `select source.drop_id,cast(source.vote as char) as vote,
         cast(source.vote_on_decision_time as char) as vote_on_decision_time,
         cast(source.timestamp as char) as timestamp,
         cast(source.over_threshold_since_ms as char) as over_threshold_since_ms
         from ${WAVE_LEADERBOARD_ENTRIES_TABLE} source where source.wave_id=:waveId and ${missingEntry}
           and (:after is null or source.drop_id>:after)
         order by source.drop_id limit :batchSize`,
          { id: owner.id, waveId: owner.wave_id, after, batchSize },
          { wrappedConnection: connection }
        );
        if (rows.length) await insertOrphanSnapshots(db, owner, rows, tx);
        return rows;
      }
    );
    if (!page.length) break;
    copied += page.length;
    after = page[page.length - 1].drop_id;
    await options.onBatch?.({ competition_id: owner.id, rows: page.length });
    if (page.length < batchSize) break;
  }
  const [source] = await db.execute<{ count: number | string }>(
    `select count(*) as count from ${WAVE_LEADERBOARD_ENTRIES_TABLE} source
     where source.wave_id=:waveId and ${missingEntry}`,
    { id: owner.id, waveId: owner.wave_id }
  );
  if (Number(source.count) !== copied)
    throw new Error(
      `Retained orphan leaderboard count parity failed for ${owner.id}`
    );
  return copied;
}

async function verifyActivePublications(
  db: SqlExecutor,
  owner: Owner
): Promise<number> {
  const [parity] = await db.execute<{
    rows: number | string;
    missing: number | string | null;
  }>(
    `select count(*) as \`rows\`,sum(lb.published_at is null) as missing
     from ${relations} where c.id=:id and e.status='ACTIVE' and (${published})`,
    { id: owner.id }
  );
  if (Number(parity.missing ?? 0) !== 0)
    throw new Error(
      `Retained leaderboard publication parity failed for ${owner.id}`
    );
  return Number(parity.rows);
}
