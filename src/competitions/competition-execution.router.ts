import { CompetitionExecutionMode } from '@/entities/ICompetition';
import { RequestContext } from '@/request.context';
import { FreezeDecisionRef } from '@/waves-freeze/waves-freeze';
import { isDecisionFrozenNow } from '@/waves-freeze/waves-freeze-scope';

export class CompetitionExecutionRouter {
  /**
   * Native execution (results, leaderboards, transitions, credit
   * reconciliation, curation resolution) runs for an ACTIVE competition,
   * except one the waves freeze holds (a decision of a wave that moves to
   * the 6529 chain): the chain imports it as it stood at the freeze, so
   * nothing here changes it afterwards. Decisions of waves that stay on
   * 6529.io keep running. `ctx` is the caller's lock or transaction.
   */
  public async isNativeExecutionAllowed(
    record: {
      readonly execution_mode: CompetitionExecutionMode;
    } & FreezeDecisionRef,
    ctx: RequestContext
  ): Promise<boolean> {
    return (
      record.execution_mode === CompetitionExecutionMode.ACTIVE &&
      !(await isDecisionFrozenNow(record, ctx))
    );
  }
}

export const competitionExecutionRouter = new CompetitionExecutionRouter();
