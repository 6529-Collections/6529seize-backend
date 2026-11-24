import {
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { dropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import { sqlExecutor } from '@/sql-executor';
import { aWave } from '@/tests/fixtures/wave.fixture';

/**
 * Plain rows for the mint seed's waves and drops, as the other seeds write
 * waves (waves has no rebuilder yet). Each drop comes with the metrics its
 * creation writes in production. By default waves and drops also come with
 * the follows creating them writes: the creator's follow of the wave and its
 * ALL group, each author's follow of their drop. The follows are plain rows:
 * the subscriber count a wave follow adds in production
 * (wave_metrics.subscribers_count) isn't written. The personal rebuild
 * derives those follows from the waves index, so a seed that writes a wave
 * or drop after the personal import writes them too.
 */

/** Fixed, as the personal seed's, so a row either seed writes first is the same. */
export const SEEDED_AT = 1_767_225_600_000;

/**
 * Inserts the row's columns that the table has; a row already there stays.
 * Returns whether the row was new.
 */
export async function insertRow(
  table: string,
  row: Record<string, unknown>
): Promise<boolean> {
  const known = new Set(
    (
      await sqlExecutor.execute<{ name: string }>(
        `select column_name as name from information_schema.columns
         where table_schema = database() and table_name = :table`,
        { table }
      )
    ).map((column) => column.name)
  );
  const columns = Object.keys(row).filter((column) => known.has(column));
  const params = Object.fromEntries(
    columns.map((column) => {
      const value = row[column];
      return [
        column,
        value !== null && typeof value === 'object'
          ? JSON.stringify(value)
          : value
      ];
    })
  );
  const result = await sqlExecutor.execute(
    `insert ignore into ${table} (${columns.map((c) => `\`${c}\``).join(', ')})
     values (${columns.map((c) => `:${c}`).join(', ')})`,
    params
  );
  return sqlExecutor.getAffectedRows(result) > 0;
}

/** Set while one drop's metrics hold the clock; holds never overlap. */
let clockHeld = false;

/**
 * 6529.io's metrics for a created drop: the drop creation's own delta
 * (applyInsertedDropMetricsDelta), with the clock held at the drop's
 * created_at so the wave's latest drop time is the drop's, as when the drop
 * is posted. Drops are written one at a time; a second hold while one is in
 * place stops the seed, rather than leave the clock fake.
 */
async function applyCreatedDropMetrics(drop: {
  readonly id: string;
  readonly waveId: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly dropType: DropType;
}): Promise<void> {
  if (clockHeld) {
    throw new Error(
      `Drop ${drop.id}: another drop's metrics hold the clock; the seed writes drops one at a time`
    );
  }
  clockHeld = true;
  const realNow = Date.now;
  Date.now = () => drop.createdAt;
  try {
    await dropsDb.applyInsertedDropMetricsDelta(
      {
        wave_id: drop.waveId,
        author_id: drop.authorId,
        drop_type: drop.dropType
      },
      {}
    );
  } finally {
    Date.now = realNow;
    clockHeld = false;
  }
}

/**
 * The delta sets a wave's latest drop time whatever it was, so a drop
 * written after a newer one moves it back. Another seed's drops can come
 * between this seed's in a shared wave (the records wave), so the seed
 * checks once, at its end: each of its waves that has metrics must hold its
 * newest drop's time.
 */
export async function assertLatestDropTimes(
  waveIds: readonly string[]
): Promise<void> {
  if (!waveIds.length) return;
  const behind = await sqlExecutor.execute<{ wave_id: string }>(
    `select m.wave_id from ${WAVE_METRICS_TABLE} m
       join (select wave_id, max(created_at) as newest from ${DROPS_TABLE}
              where wave_id in (:waveIds) group by wave_id) d
         on d.wave_id = m.wave_id
      where m.latest_drop_timestamp <> d.newest`,
    { waveIds }
  );
  if (behind.length) {
    throw new Error(
      `The latest drop time of ${behind.map((row) => row.wave_id).join(', ')} isn't its newest drop's: the seed wrote a drop after a newer one`
    );
  }
}

/**
 * A one-part drop, with the metrics and the author's follow of it that
 * 6529.io's drop creation writes. A drop already there is left as it is.
 * The metrics come straight after the drop's own row; the part and the
 * follow after them are rows a rerun adds if they are missing.
 */
export async function insertDrop(drop: {
  readonly id: string;
  readonly waveId: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly dropType: DropType;
  readonly content: string;
  readonly authorFollows?: boolean;
}): Promise<void> {
  const created = await insertRow(DROPS_TABLE, {
    id: drop.id,
    wave_id: drop.waveId,
    author_id: drop.authorId,
    created_at: drop.createdAt,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: drop.dropType,
    signature: null,
    hide_link_preview: true
  });
  if (created) {
    await applyCreatedDropMetrics(drop);
  }
  await insertRow(DROPS_PARTS_TABLE, {
    drop_id: drop.id,
    drop_part_id: 1,
    content: drop.content,
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: drop.waveId
  });
  if (drop.authorFollows === false) return;
  await insertRow(IDENTITY_SUBSCRIPTIONS_TABLE, {
    subscriber_id: drop.authorId,
    target_id: drop.id,
    target_type: 'DROP',
    target_action: 'DROP_REPLIED',
    wave_id: drop.waveId,
    subscribed_to_all_drops: false
  });
}

/** A public wave named by its id, its description drop and its creator's follows. */
export async function insertWave(wave: {
  readonly id: string;
  readonly createdBy: string;
  readonly descriptionDropId: string;
  readonly creatorFollows?: boolean;
}): Promise<void> {
  const { serial_no: _serial, ...row } = aWave(
    {
      is_direct_message: false,
      created_by: wave.createdBy,
      created_at: SEEDED_AT,
      description_drop_id: wave.descriptionDropId
    },
    { id: wave.id, name: wave.id }
  );
  await insertRow(WAVES_TABLE, row);
  const follows = wave.creatorFollows !== false;
  if (follows) {
    await insertRow(IDENTITY_SUBSCRIPTIONS_TABLE, {
      subscriber_id: wave.createdBy,
      target_id: wave.id,
      target_type: 'WAVE',
      target_action: 'DROP_CREATED',
      wave_id: wave.id,
      subscribed_to_all_drops: false
    });
    await insertRow(WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE, {
      identity_id: wave.createdBy,
      wave_id: wave.id,
      mentioned_group: 'ALL'
    });
  }
  await insertDrop({
    id: wave.descriptionDropId,
    waveId: wave.id,
    authorId: wave.createdBy,
    createdAt: SEEDED_AT,
    dropType: DropType.CHAT,
    content: 'A wave for the rebuild check.',
    authorFollows: follows
  });
}
