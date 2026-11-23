import {
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { sqlExecutor } from '@/sql-executor';
import { aWave } from '@/tests/fixtures/wave.fixture';

/**
 * Plain rows for the mint seed's waves and drops, as the other seeds write
 * waves (waves has no rebuilder yet). By default they come with what
 * creating them writes in production: the creator's follow of the wave and
 * its ALL group, each author's follow of their drop. The personal rebuild
 * derives those follows from the waves index, so a seed that writes a wave
 * or drop after the personal import writes them too.
 */

/** Fixed, as the personal seed's, so a row either seed writes first is the same. */
export const SEEDED_AT = 1_767_225_600_000;

/** Inserts the row's columns that the table has; a row already there stays. */
export async function insertRow(
  table: string,
  row: Record<string, unknown>
): Promise<void> {
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
  await sqlExecutor.execute(
    `insert ignore into ${table} (${columns.map((c) => `\`${c}\``).join(', ')})
     values (${columns.map((c) => `:${c}`).join(', ')})`,
    params
  );
}

/** A one-part drop and its author's follow of it. */
export async function insertDrop(drop: {
  readonly id: string;
  readonly waveId: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly dropType: DropType;
  readonly content: string;
  readonly authorFollows?: boolean;
}): Promise<void> {
  await insertRow(DROPS_TABLE, {
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
