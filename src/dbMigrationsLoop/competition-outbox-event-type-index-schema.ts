import type { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { COMPETITION_OUTBOX_TABLE } from '@/constants';
import { COMPETITION_OUTBOX_EVENT_TYPE_INDEX } from '@/entities/ICompetitionRuntime';
import { applyOnlineIndex } from './online-index-schema';

/**
 * Adds the (competition_id, event_type) index on competition_outbox, so the
 * outbox reads that filter one competition's events by type (listHistory's
 * score resets, entry origin checks) read only those events instead of
 * decoding the competition's whole outbox. event_type is a VIRTUAL generated
 * column that a full-scope schema sync adds; this step only adds the index,
 * online, and refuses to run before the column exists.
 */
export async function applyCompetitionOutboxEventTypeIndexSchema(
  source: DataSource = getDataSource()
): Promise<number> {
  const rows: { expression: string | null }[] = await source.query(
    `SELECT generation_expression AS expression FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'event_type'`,
    [COMPETITION_OUTBOX_TABLE]
  );
  if (!rows.length || !rows[0].expression)
    throw new Error(
      'competition_outbox.event_type is missing; run a full-scope schema sync first'
    );
  return applyOnlineIndex(
    {
      table: COMPETITION_OUTBOX_TABLE,
      index: COMPETITION_OUTBOX_EVENT_TYPE_INDEX,
      columns: ['competition_id', 'event_type'],
      label: 'Competition outbox event type index'
    },
    source
  );
}
