import { CONSOLIDATED_WALLETS_TDH_TABLE, IDENTITIES_TABLE } from '@/constants';
import { competitionMainStageRepository } from '@/competitions/competition-main-stage.repository';
import { env } from '@/env';
import { metricsRecorder } from '@/metrics/MetricsRecorder';
import { numbers } from '@/numbers';
import { dbSupplier } from '@/sql-executor';

/**
 * The metrics a full TDH write records: TDH on Main Stage submissions,
 * consolidations formed and the profile count. Shared by tdhLoop and the
 * chain-day ingest.
 */
export async function recordTdhMetrics() {
  const mainStageWaveId = env.getStringOrNull(`MAIN_STAGE_WAVE_ID`);
  const tdhOnMainStageSubmissions =
    await competitionMainStageRepository.totalActiveVotes(mainStageWaveId, {});
  await metricsRecorder.recordTdhOnMainStageSubmissions(
    { tdhOnMainStageSubmissions },
    {}
  );
  if (mainStageWaveId) {
    const db = dbSupplier();
    await Promise.all([
      db
        .oneOrNull<{
          cnt: number;
        }>(
          `select count(*) as cnt from ${CONSOLIDATED_WALLETS_TDH_TABLE} where consolidation_key like ('%-%')`
        )
        .then(async (consolidationsFormedRow) => {
          const consolidationsFormed = numbers.parseNumberOrThrow(
            consolidationsFormedRow?.cnt ?? 0
          );
          await metricsRecorder.recordConsolidationsFormed(
            { consolidationsFormed },
            {}
          );
        }),
      db
        .oneOrNull<{
          cnt: number;
        }>(
          `select count(*) as cnt from ${IDENTITIES_TABLE} where normalised_handle is not null and normalised_handle not like 'id-0x%'`
        )
        .then(async (profileCountRow) => {
          const profileCount = numbers.parseNumberOrThrow(
            profileCountRow?.cnt ?? 0
          );
          await metricsRecorder.recordProfileCount({ profileCount }, {});
        })
    ]);
  }
}
