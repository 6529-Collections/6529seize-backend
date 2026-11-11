import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  DROPS_TABLE
} from '@/constants/db-tables';
import { DropType } from '@/entities/IDrop';
import { LEGACY_NATIVE_PRIMARY_SQL } from '@/competitions/legacy-competition-get-facade';

/**
 * Entry statuses the `legacy_get_drops` view maps to a type of its own:
 * ACTIVE → PARTICIPATORY, WINNER → WINNER, WITHDRAWN/DISQUALIFIED → CHAT.
 * A drop with an entry in any other status keeps its stored type.
 */
export const VIEW_MAPPED_ENTRY_STATUSES = `'ACTIVE','WINNER','WITHDRAWN','DISQUALIFIED'`;

/**
 * Drops `d` shown by an entry of their wave's native primary competition
 * with `statuses`, through competitions `c` and entries `e`.
 */
function nativeEntryDropsFrom(statuses: string): string {
  return `${COMPETITIONS_TABLE} c
      join ${COMPETITION_ENTRIES_TABLE} e on e.competition_id = c.id and e.status in (${statuses})
      join ${DROPS_TABLE} d on d.id = e.drop_id and d.wave_id = c.legacy_wave_id`;
}

/** `d` has no native entry the view maps to a type of its own. */
const NO_VIEW_MAPPED_ENTRY = `not exists (
          select 1 from ${COMPETITIONS_TABLE} c
          join ${COMPETITION_ENTRIES_TABLE} e on e.competition_id = c.id
          where c.legacy_wave_id = d.wave_id and ${LEGACY_NATIVE_PRIMARY_SQL}
            and e.drop_id = d.id and e.status in (${VIEW_MAPPED_ENTRY_STATUSES}))`;

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
      from ${nativeEntryDropsFrom(`'${status}'`)}
      where c.legacy_wave_id = ${params.waveId} and ${LEGACY_NATIVE_PRIMARY_SQL}
        and d.author_id in (${params.profileIds})
    union select d.author_id as profile_id, d.id as drop_id
      from ${DROPS_TABLE} d
      where d.author_id in (${params.profileIds}) and d.wave_id = ${params.waveId}
        and d.drop_type = '${dropType}'
        and ${NO_VIEW_MAPPED_ENTRY}`;
}

/**
 * CTE `participant_candidates` (column `id`, distinct): a superset of the
 * drops `legacy_get_drops` calls PARTICIPATORY in the waves matched by
 * `wave_id <waveFilter>` (for example `= :wave_id`, or
 * `IN (SELECT wave_id FROM needed_waves)`), read through indexes instead of
 * walking every drop of those waves. The view calls a drop PARTICIPATORY when
 * it has an ACTIVE entry in its wave's native primary competition, or when it
 * has no entry in another view-mapped status and its stored type is
 * PARTICIPATORY; the first set comes from the competition's entries, the
 * second from the (wave_id, drop_type, …) index.
 *
 * Join it to the view by id and keep the view's own drop_type and wave
 * filters: the view decides membership, so the rows are exactly the view's
 * participatory drops of those waves, with any column the view has.
 *
 * Run the statement with withoutLegacyCompetitionGetFacade and name every
 * view it needs explicitly: inside the API's facade scope the executor
 * rewrites a base `drops` after FROM into its view, which would turn the
 * indexed candidate read back into a walk over every drop of the wave.
 */
export function legacyParticipantCandidatesCte(waveFilter: string): string {
  return `participant_candidates AS (
      SELECT e.drop_id AS id
      FROM ${COMPETITION_ENTRIES_TABLE} e
      JOIN ${COMPETITIONS_TABLE} c
        ON c.id = e.competition_id AND ${LEGACY_NATIVE_PRIMARY_SQL}
      WHERE c.legacy_wave_id ${waveFilter}
        AND e.status = 'ACTIVE'
      UNION
      SELECT pd.id
      FROM ${DROPS_TABLE} pd
      WHERE pd.wave_id ${waveFilter}
        AND pd.drop_type = '${DropType.PARTICIPATORY}'
    )`;
}

/**
 * Per wave and author, whether `legacy_get_drops` has a PARTICIPATORY or a
 * WINNER drop by the author in the wave, for `wave_id in (:waveIds)` and
 * `author_id in (:authorIds)`, read from base tables so the indexes apply:
 * (wave_id, drop_type, author_id) for stored types, and the native primary
 * competition's (competition_id, status) entries. The view instead reads
 * every drop by the authors in the waves: 3.1 s for 15 authors in a 488k-drop
 * chat wave on the prod reader, against 0.04 ms here.
 *
 * Same rows as the view's, typed the same way (see legacyTypedDropsSql):
 * native entries by status (ACTIVE, WINNER), then stored PARTICIPATORY and
 * WINNER drops with no view-mapped native entry. Returns
 * `wave_id, author_id, is_participant, is_winner` (0/1). Run it outside the
 * legacy GET facade, so the base tables are not rewritten to the views.
 */
export function legacyAuthorWaveParticipationSql(params: {
  waveIds: string;
  authorIds: string;
}): string {
  return `select wave_id, author_id,
         max(case when drop_type = '${DropType.PARTICIPATORY}' then 1 else 0 end) as is_participant,
         max(case when drop_type = '${DropType.WINNER}' then 1 else 0 end) as is_winner
    from (
      select d.wave_id, d.author_id,
             case when e.status = 'WINNER' then '${DropType.WINNER}' else '${DropType.PARTICIPATORY}' end as drop_type
        from ${nativeEntryDropsFrom(`'ACTIVE','WINNER'`)}
        where c.legacy_wave_id in (${params.waveIds}) and ${LEGACY_NATIVE_PRIMARY_SQL}
          and d.author_id in (${params.authorIds})
      union all
      select d.wave_id, d.author_id, d.drop_type
        from ${DROPS_TABLE} d
        where d.wave_id in (${params.waveIds}) and d.author_id in (${params.authorIds})
          and d.drop_type in ('${DropType.PARTICIPATORY}', '${DropType.WINNER}')
          and ${NO_VIEW_MAPPED_ENTRY}
    ) typed
    group by wave_id, author_id`;
}
