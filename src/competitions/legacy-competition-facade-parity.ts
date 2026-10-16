import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import {
  LEGACY_GET_SOURCE_TABLES,
  legacyGetView,
  withLegacyShadowGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { LEGACY_GET_BOOLEAN_FIELDS } from '@/competitions/legacy-competition-get-facade';
import {
  WAVES_TABLE,
  DROPS_TABLE,
  COMPETITION_ENTRIES_TABLE
} from '@/constants';
import { competitionPayloadHash } from '@/competitions/competition-command-identity';

function normalize(value: unknown): unknown {
  if (typeof value === 'string' && /^[{[]/.test(value)) {
    try {
      return normalize(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        LEGACY_GET_BOOLEAN_FIELDS.has(key) && item !== null
          ? Boolean(Number(item))
          : normalize(item)
      ])
    );
  return value;
}

/** The view can expose a participation/winner drop only from a source drop of
 * those types or an ACTIVE/WINNER native entry. Keep both sets, including a
 * corrupt native entry mapped to a CHAT drop; source-only keys would hide it.
 * Driving the view by these keys avoids projecting the wave's entire chat.
 * Both UNION keys come from drops.id to retain its exact type and collation. */
export function readLegacyDropFacadeForComparison(
  db: SqlExecutor,
  id: string,
  waveId: string,
  ctx: RequestContext
): Promise<Record<string, unknown>[]> {
  return db.execute<Record<string, unknown>>(
    `select projected.* from (
       select d.id from ${DROPS_TABLE} d where d.wave_id=:waveId and d.drop_type in ('PARTICIPATORY','WINNER')
       union
       select d.id from ${COMPETITION_ENTRIES_TABLE} e join ${DROPS_TABLE} d on d.id=e.drop_id
       where e.competition_id=:id and e.status in ('ACTIVE','WINNER') and d.wave_id=:waveId
     ) candidate_keys straight_join ${legacyGetView(DROPS_TABLE)} projected on projected.id=candidate_keys.id
     where projected.wave_id=:waveId and projected.drop_type in ('PARTICIPATORY','WINNER')`,
    { id, waveId },
    { wrappedConnection: ctx.connection }
  );
}

/** Relational parity proves the input to the unchanged frozen auth, visibility,
 * pagination, status and wire mappers, including every column they can select.
 * Unrelated hub chat and historical retention remain shared read-only inputs.
 * No truncated comparison can be recorded as a full window. */
export async function compareLegacyFacade(
  db: SqlExecutor,
  id: string,
  waveId: string,
  ctx: RequestContext
) {
  return withLegacyShadowGetFacade(db, id, ctx, async () => {
    const categories = [];
    for (const table of LEGACY_GET_SOURCE_TABLES) {
      const filter =
        table === WAVES_TABLE
          ? 'id=:waveId'
          : table === DROPS_TABLE
            ? "wave_id=:waveId and drop_type in ('PARTICIPATORY','WINNER')"
            : 'wave_id=:waveId';
      const rows = async (source: string) => {
        const data =
          table === DROPS_TABLE && source === legacyGetView(DROPS_TABLE)
            ? await readLegacyDropFacadeForComparison(db, id, waveId, ctx)
            : await db.execute<Record<string, unknown>>(
                `select * from \`${source}\` where ${filter}`,
                { waveId },
                { wrappedConnection: ctx.connection }
              );
        return data
          .map(normalize)
          .map(competitionPayloadHash)
          .sort((a, b) => a.localeCompare(b));
      };
      categories.push({
        category: `frozen_relation:${table}`,
        baselineHash: competitionPayloadHash(await rows(table)),
        candidateHash: competitionPayloadHash(await rows(legacyGetView(table)))
      });
    }
    return categories;
  });
}
