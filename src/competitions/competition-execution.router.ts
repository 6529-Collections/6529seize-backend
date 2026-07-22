import { appFeatures, AppFeatures } from '@/app-features';
import {
  CompetitionExecutionMode,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { RequestContext } from '@/request.context';
import {
  competitionRepository,
  CompetitionRepository
} from '@/competitions/competition.repository';

export class CompetitionExecutionRouter {
  public constructor(
    private readonly repository: CompetitionRepository,
    private readonly features: AppFeatures
  ) {}

  public async shouldUseLegacyWaveExecution(
    waveId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const records = await this.repository.listCompetitionRecordsForWave(
      waveId,
      ctx
    );
    const primary = records.find((record) => record.legacy_wave_id === waveId);
    if (!primary) {
      // A rolling deployment or a just-created legacy wave may briefly precede
      // its additive mapping. Existing execution remains authoritative.
      return true;
    }
    return (
      primary.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER &&
      primary.execution_mode === CompetitionExecutionMode.ACTIVE
    );
  }

  public isNativeExecutionAllowed(record: {
    readonly storage_mode: CompetitionStorageMode;
    readonly execution_mode: CompetitionExecutionMode;
  }): boolean {
    return (
      this.features.isNativeCompetitionExecutionEnabled() &&
      record.storage_mode === CompetitionStorageMode.NATIVE &&
      record.execution_mode === CompetitionExecutionMode.ACTIVE
    );
  }
}

export const competitionExecutionRouter = new CompetitionExecutionRouter(
  competitionRepository,
  appFeatures
);
