import {
  collectCompetitionPages,
  CompetitionRowLimitError
} from '@/competitions/competition-page';
import { competitionCreditService } from '@/competitions/competition-credit.service';
import {
  Competition,
  CompetitionEntry,
  CompetitionReader,
  CompetitionRoutingRecord,
  CompetitionVoter
} from '@/competitions/competition.types';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { WaveCreditScope } from '@/entities/IWave';
import { RequestContext } from '@/request.context';

export type CompetitionCreditParity = {
  readonly profile_id: string;
  readonly drop_id: string | null;
  readonly available: number;
  readonly spent: number;
  readonly remaining: number;
};

/** Candidate uses the public budget service; baseline reads legacy sources independently. */
export async function loadCompetitionCreditParity(
  reader: CompetitionReader,
  record: CompetitionRoutingRecord,
  competition: Competition,
  entries: readonly CompetitionEntry[],
  voters: readonly CompetitionVoter[],
  rowLimit: number,
  ctx: RequestContext
): Promise<CompetitionCreditParity[]> {
  const results: CompetitionCreditParity[] = [];
  const add = async (profileId: string, entry?: CompetitionEntry) => {
    if (results.length >= rowLimit) throw new CompetitionRowLimitError();
    const budget = await competitionCreditService.getBudget(
      competition,
      profileId,
      entry,
      ctx
    );
    if (budget.spent === null || budget.remaining === null)
      throw new Error('Parity requires a scoped credit budget');
    results.push({
      profile_id: profileId,
      drop_id: entry?.drop_id ?? null,
      available: budget.available,
      spent: budget.spent,
      remaining: budget.remaining
    });
  };
  if (competition.voting.credit_scope === WaveCreditScope.WAVE) {
    for (const voter of voters) await add(voter.profile_id);
  } else {
    for (const entry of entries) {
      if (entry.status !== CompetitionEntryStatus.ACTIVE) continue;
      const entryVoters = await collectCompetitionPages(
        (page) => reader.listVoters(record, page, entry.id),
        'ASC',
        rowLimit
      );
      for (const voter of entryVoters) await add(voter.profile_id, entry);
    }
  }
  return results.sort(
    (a, b) =>
      a.profile_id.localeCompare(b.profile_id) ||
      (a.drop_id ?? '').localeCompare(b.drop_id ?? '')
  );
}
