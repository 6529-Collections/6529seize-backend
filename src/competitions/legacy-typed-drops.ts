import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  DROPS_TABLE
} from '@/constants/db-tables';
import { DropType } from '@/entities/IDrop';

/**
 * Entry statuses the `legacy_get_drops` view maps to a type of its own:
 * ACTIVE → PARTICIPATORY, WINNER → WINNER, WITHDRAWN/DISQUALIFIED → CHAT.
 * A drop with an entry in any other status keeps its stored type.
 */
const VIEW_MAPPED_ENTRY_STATUSES = `'ACTIVE','WINNER','WITHDRAWN','DISQUALIFIED'`;

/**
 * The rows `legacy_get_drops` returns for
 * `author_id in (:profileIds) and wave_id = :waveId and drop_type = <type>`,
 * read from base tables so the indexes apply. The view computes drop_type
 * from left-joined competition entries, which defeats the
 * (wave_id, drop_type, author_id) index: 166 ms warm and seconds on a cold
 * reader, against ~2 ms here.
 *
 * Same rows as the view:
 * - drops with an entry of the wave's native primary competition, by the
 *   entry status (ACTIVE → PARTICIPATORY, WINNER → WINNER);
 * - drops with no such entry in a view-mapped status, by their stored type.
 *
 * Returns `profile_id, drop_id`. Run it outside the legacy GET facade, so
 * the base tables are not rewritten to the views.
 */
export function legacyTypedDropsSql(
  dropType: DropType.PARTICIPATORY | DropType.WINNER,
  params: { profileIds: string; waveId: string }
): string {
  const status = dropType === DropType.WINNER ? 'WINNER' : 'ACTIVE';
  return `select d.author_id as profile_id, d.id as drop_id
      from ${COMPETITIONS_TABLE} c
      join ${COMPETITION_ENTRIES_TABLE} e on e.competition_id = c.id and e.status = '${status}'
      join ${DROPS_TABLE} d on d.id = e.drop_id and d.wave_id = c.legacy_wave_id
      where c.legacy_wave_id = ${params.waveId} and c.wave_id = c.legacy_wave_id
        and d.author_id in (${params.profileIds})
    union select d.author_id as profile_id, d.id as drop_id
      from ${DROPS_TABLE} d
      where d.author_id in (${params.profileIds}) and d.wave_id = ${params.waveId}
        and d.drop_type = '${dropType}'
        and not exists (
          select 1 from ${COMPETITIONS_TABLE} c
          join ${COMPETITION_ENTRIES_TABLE} e on e.competition_id = c.id
          where c.legacy_wave_id = d.wave_id and c.legacy_wave_id = c.wave_id
            and e.drop_id = d.id and e.status in (${VIEW_MAPPED_ENTRY_STATUSES}))`;
}
