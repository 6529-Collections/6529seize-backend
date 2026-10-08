import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import {
  LEGACY_GET_SOURCE_TABLES,
  legacyGetView,
  withLegacyShadowGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { LEGACY_GET_BOOLEAN_FIELDS } from '@/competitions/legacy-competition-get-facade';
import { WAVES_TABLE, DROPS_TABLE } from '@/constants';
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
        const data = await db.execute<Record<string, unknown>>(
          `select * from \`${source}\` where ${filter} limit 10001`,
          { waveId },
          { wrappedConnection: ctx.connection }
        );
        if (data.length > 10000)
          throw new Error(
            `OWNED_EXCEPTION: full compatibility comparison limit exceeded for ${table}`
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
