import { CompetitionExecutionMode } from '@/entities/ICompetition';
import {
  FreezeDecisionRef,
  isDecisionFrozen
} from '@/waves-freeze/waves-freeze';

export class CompetitionExecutionRouter {
  /**
   * Native execution (results, leaderboards, transitions, credit
   * reconciliation, curation resolution) runs for an ACTIVE competition,
   * except one the waves freeze holds: the chain imports it as it stood at
   * the freeze, so nothing here changes it afterwards.
   */
  public isNativeExecutionAllowed(
    record: {
      readonly execution_mode: CompetitionExecutionMode;
    } & FreezeDecisionRef
  ): boolean {
    return (
      record.execution_mode === CompetitionExecutionMode.ACTIVE &&
      !isDecisionFrozen(record)
    );
  }
}

export const competitionExecutionRouter = new CompetitionExecutionRouter();
