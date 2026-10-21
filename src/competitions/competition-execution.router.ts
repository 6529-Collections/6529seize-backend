import {
  CompetitionExecutionMode,
  CompetitionStorageMode
} from '@/entities/ICompetition';

export class CompetitionExecutionRouter {
  public isNativeExecutionAllowed(record: {
    readonly storage_mode: CompetitionStorageMode;
    readonly execution_mode: CompetitionExecutionMode;
  }): boolean {
    return (
      record.storage_mode === CompetitionStorageMode.NATIVE &&
      record.execution_mode === CompetitionExecutionMode.ACTIVE
    );
  }
}

export const competitionExecutionRouter = new CompetitionExecutionRouter();
