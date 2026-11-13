import { CompetitionExecutionMode } from '@/entities/ICompetition';

export class CompetitionExecutionRouter {
  public isNativeExecutionAllowed(record: {
    readonly execution_mode: CompetitionExecutionMode;
  }): boolean {
    return record.execution_mode === CompetitionExecutionMode.ACTIVE;
  }
}

export const competitionExecutionRouter = new CompetitionExecutionRouter();
