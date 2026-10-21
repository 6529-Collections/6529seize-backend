import {
  COMPETITIONS_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import {
  legacyCompetitionDistributionItemId,
  legacyCompetitionOutcomeId
} from './competition-id';

type SourceItem = {
  outcome_position: number;
  position: number;
  amount: string | null;
  description: string | null;
};
export type RetainedDistributionTransferOptions = {
  readonly batchSize?: number;
  readonly onBatch?: (progress: {
    competition_id: string;
    rows: number;
    after: { outcome_position: number; position: number };
  }) => Promise<void>;
};

/** Preserve the old GET's parentless children without creating a parent outcome.
 * Existing canonical native children are authoritative. Each source keyset page
 * commits independently; reruns retain deterministic original scoped identities. */
export async function transferRetainedCompetitionDistributions(
  db: SqlExecutor,
  competitionId?: string,
  ctx: RequestContext = {},
  options: RetainedDistributionTransferOptions = {}
): Promise<{ competition_id: string; rows: number }[]> {
  if (ctx.connection)
    throw new Error(
      'Distribution transfer requires independent batch transactions'
    );
  const batchSize = options.batchSize ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error(
      'Distribution transfer batch size must be between 1 and 1000'
    );
  const owners = await db.execute<{ id: string; wave_id: string }>(
    `SELECT c.id,c.wave_id FROM ${COMPETITIONS_TABLE} c JOIN ${WAVES_TABLE} w ON w.id=c.wave_id
     WHERE c.storage_mode='NATIVE' AND c.legacy_wave_id=c.wave_id
       AND (:competitionId IS NULL OR c.id=:competitionId) ORDER BY c.id`,
    { competitionId: competitionId ?? null }
  );
  const reports: { competition_id: string; rows: number }[] = [];
  for (const owner of owners) {
    let after: { outcome_position: number; position: number } | null = null;
    while (true) {
      const page = await db.executeNativeQueriesInTransaction(
        async (connection) => {
          const queryOptions = { wrappedConnection: connection };
          const params = {
            id: owner.id,
            waveId: owner.wave_id,
            batchSize,
            afterOutcome: after?.outcome_position ?? null,
            afterPosition: after?.position ?? null
          };
          const locked = await db.oneOrNull<{ id: string }>(
            `SELECT id FROM ${COMPETITIONS_TABLE} WHERE id=:id AND storage_mode='NATIVE'
           AND legacy_wave_id=wave_id AND wave_id=:waveId FOR UPDATE`,
            params,
            queryOptions
          );
          if (!locked)
            throw new Error(`Competition ownership changed: ${owner.id}`);
          const rows = await db.execute<SourceItem>(
            `SELECT source.wave_outcome_position AS outcome_position,source.wave_outcome_distribution_item_position AS position,
             CAST(source.amount AS CHAR) AS amount,source.description
           FROM ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} source
           WHERE source.wave_id=:waveId AND NOT EXISTS(SELECT 1 FROM ${COMPETITION_OUTCOMES_TABLE} parent
             WHERE parent.competition_id=:id AND parent.position=source.wave_outcome_position)
             AND (:afterOutcome IS NULL OR source.wave_outcome_position>:afterOutcome
               OR (source.wave_outcome_position=:afterOutcome AND source.wave_outcome_distribution_item_position>:afterPosition))
           ORDER BY source.wave_outcome_position,source.wave_outcome_distribution_item_position LIMIT :batchSize`,
            params,
            queryOptions
          );
          if (!rows.length) return rows;
          const native = rows.map((row) => {
            const outcomeId = legacyCompetitionOutcomeId(
              owner.id,
              Number(row.outcome_position)
            );
            return {
              id: legacyCompetitionDistributionItemId(
                outcomeId,
                Number(row.position)
              ),
              competition_id: owner.id,
              outcome_id: outcomeId,
              outcome_position: Number(row.outcome_position),
              position: Number(row.position),
              amount: row.amount,
              description: row.description
            };
          });
          await db.bulkUpsert(
            COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
            native,
            [
              'id',
              'competition_id',
              'outcome_id',
              'outcome_position',
              'position',
              'amount',
              'description'
            ],
            ['outcome_position', 'amount', 'description'],
            { ...ctx, connection }
          );
          const retained = await db.execute<
            SourceItem & { id: string; outcome_id: string }
          >(
            `SELECT id,outcome_id,outcome_position,position,CAST(amount AS CHAR) AS amount,description
           FROM ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE} WHERE competition_id=:id AND id IN (:ids)`,
            { id: owner.id, ids: native.map((row) => row.id) },
            queryOptions
          );
          const byId = new Map(retained.map((row) => [row.id, row]));
          for (const expected of native) {
            const actual = byId.get(expected.id);
            if (
              !actual ||
              actual.outcome_id !== expected.outcome_id ||
              Number(actual.outcome_position) !== expected.outcome_position ||
              Number(actual.position) !== expected.position ||
              actual.amount !== expected.amount ||
              actual.description !== expected.description
            )
              throw new Error(
                `Retained distribution parity failed for ${owner.id}`
              );
          }
          return rows;
        }
      );
      if (!page.length) break;
      const last = page.at(-1)!;
      after = {
        outcome_position: Number(last.outcome_position),
        position: Number(last.position)
      };
      await options.onBatch?.({
        competition_id: owner.id,
        rows: page.length,
        after
      });
      if (page.length < batchSize) break;
    }
    const [counts] = await db.execute<{
      source_count: number | string;
      target_count: number | string;
    }>(
      `SELECT (SELECT COUNT(*) FROM ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} source WHERE source.wave_id=:waveId
        AND NOT EXISTS(SELECT 1 FROM ${COMPETITION_OUTCOMES_TABLE} parent WHERE parent.competition_id=:id
          AND parent.position=source.wave_outcome_position)) AS source_count,
       (SELECT COUNT(*) FROM ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE} child WHERE child.competition_id=:id
        AND child.outcome_position IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${COMPETITION_OUTCOMES_TABLE} parent
          WHERE parent.competition_id=:id AND parent.position=child.outcome_position)) AS target_count`,
      { id: owner.id, waveId: owner.wave_id }
    );
    if (Number(counts.source_count) !== Number(counts.target_count))
      throw new Error(
        `Retained distribution count parity failed for ${owner.id}`
      );
    reports.push({
      competition_id: owner.id,
      rows: Number(counts.source_count)
    });
  }
  return reports;
}
