import { appFeatures } from '@/app-features';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { competitionCreditService } from '@/competitions/competition-credit.service';
import { Competition } from '@/competitions/competition.types';
import { reducedNativeVotes } from '@/competitions/native-competition-runtime.helpers';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { WaveCreditType } from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { VoterRating } from './rep-ratings-removal.db';

/** What removing the ratings would do to the votes of one competition. */
export interface OvervoteCompetitionPreview {
  readonly competition_id: string;
  readonly wave_id: string;
  readonly wave_name: string | null;
  readonly credit_scope: string;
  /** The REP category the competition counts; null counts every category. */
  readonly credit_category: string | null;
  readonly voters_losing_votes: number;
  /** Votes (one per voter and entry) that would be lowered. */
  readonly votes_reduced: number;
  /** Total vote weight taken away: the sum of |old| - |new|. */
  readonly weight_removed: number;
}

export interface OvervotePreview {
  /**
   * FEATURE_DROP_OVERVOTE_REVOCATION. When false an APPLY run lowers no
   * votes, as no other REP decrease does.
   */
  readonly revocation_enabled: boolean;
  /** Targets losing REP that vote in an active competition. */
  readonly voters_checked: number;
  /** Distinct voters who would lose votes in at least one competition. */
  readonly voters_losing_votes: number;
  readonly votes_reduced: number;
  readonly weight_removed: number;
  /** Competitions where votes would be lowered, most weight first. */
  readonly competitions: OvervoteCompetitionPreview[];
}

type VoterChange = {
  readonly votesReduced: number;
  readonly weightRemoved: number;
};

export interface OvervotePreviewDeps {
  readonly findCandidateCompetitions: (
    afterId: string,
    limit: number,
    voterProfileId: string,
    ctx: RequestContext
  ) => Promise<string[]>;
  readonly readCompetition: (
    competitionId: string,
    ctx: RequestContext
  ) => Promise<Competition | null>;
  readonly getAvailableCredit: (
    competition: Competition,
    voterProfileId: string,
    ctx: RequestContext
  ) => Promise<number>;
  readonly getVoterActiveVotes: (
    competitionId: string,
    voterProfileId: string,
    ctx: RequestContext
  ) => Promise<{ entryId: string; value: number }[]>;
  readonly findWaveName: (
    waveId: string,
    ctx: RequestContext
  ) => Promise<string | null>;
  readonly inReadTransaction: <T>(
    fn: (ctx: RequestContext) => Promise<T>
  ) => Promise<T>;
  readonly isRevocationEnabled: () => boolean;
}

const CANDIDATE_PAGE = 100;

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Whether removing the rater's REP lowers the voting credit of this
 * competition: the same test revokeRepBasedDropOverVotes applies before it
 * reconciles a voter.
 */
function countsRemovedRep(
  competition: Competition | null,
  rater: string
): competition is Competition {
  return (
    !!competition &&
    competition.voting.credit_type === WaveCreditType.REP &&
    competition.execution_mode === 'ACTIVE' &&
    competition.lifecycle === 'PUBLISHED' &&
    (competition.voting.credit_creditor === null ||
      competition.voting.credit_creditor === rater)
  );
}

function removedForCompetition(
  competition: Competition,
  removedByCategory: Map<string, number>
): number {
  const category = competition.voting.credit_category;
  if (category === null) {
    return Array.from(removedByCategory.values()).reduce(
      (acc, it) => acc + it,
      0
    );
  }
  return removedByCategory.get(category) ?? 0;
}

function groupByVoter(
  ratings: VoterRating[]
): Map<string, Map<string, number>> {
  const byVoter = new Map<string, Map<string, number>>();
  for (const rating of ratings) {
    const categories =
      byVoter.get(rating.matter_target_id) ?? new Map<string, number>();
    categories.set(
      rating.matter_category,
      (categories.get(rating.matter_category) ?? 0) + rating.rating
    );
    byVoter.set(rating.matter_target_id, categories);
  }
  return byVoter;
}

/**
 * Reports, without writing anything, the votes that removing one rater's
 * REP ratings would take away: for each voter losing REP, each active REP
 * competition it votes in is read with its current credit, the removed REP
 * is subtracted, and the votes are reduced as credit reconciliation reduces
 * them (reducedNativeVotes). The APPLY run reconciles after each category,
 * so a voter who loses REP in several categories counted by one competition
 * can end a vote or two of rounding away from this figure.
 */
export class RepRatingsRemovalOvervotePreview {
  constructor(private readonly deps: OvervotePreviewDeps) {}

  async preview(
    rater: string,
    voterRatings: VoterRating[]
  ): Promise<OvervotePreview> {
    const byVoter = groupByVoter(voterRatings);
    const byCompetition = new Map<
      string,
      { competition: Competition; voters: number; changes: VoterChange }
    >();
    const losingVoters = new Set<string>();
    // Read once each: most candidates of most voters are the same few
    // competitions, and most do not count REP at all.
    const read = new Map<string, Competition | null>();
    const voters = Array.from(byVoter.keys()).sort((a, b) =>
      compareStrings(a, b)
    );
    for (const voter of voters) {
      const removed = byVoter.get(voter)!;
      for (const competitionId of await this.candidates(voter)) {
        const known = read.get(competitionId);
        if (read.has(competitionId) && !countsRemovedRep(known ?? null, rater))
          continue;
        const result = await this.deps.inReadTransaction((ctx) =>
          this.previewVoter(competitionId, voter, rater, removed, read, ctx)
        );
        if (!result) continue;
        losingVoters.add(voter);
        const current = byCompetition.get(competitionId) ?? {
          competition: result.competition,
          voters: 0,
          changes: { votesReduced: 0, weightRemoved: 0 }
        };
        byCompetition.set(competitionId, {
          competition: result.competition,
          voters: current.voters + 1,
          changes: {
            votesReduced:
              current.changes.votesReduced + result.change.votesReduced,
            weightRemoved:
              current.changes.weightRemoved + result.change.weightRemoved
          }
        });
      }
    }
    const competitions: OvervoteCompetitionPreview[] = [];
    for (const [id, entry] of Array.from(byCompetition.entries())) {
      competitions.push({
        competition_id: id,
        wave_id: entry.competition.wave_id,
        wave_name: await this.deps.inReadTransaction((ctx) =>
          this.deps.findWaveName(entry.competition.wave_id, ctx)
        ),
        credit_scope: entry.competition.voting.credit_scope,
        credit_category: entry.competition.voting.credit_category,
        voters_losing_votes: entry.voters,
        votes_reduced: entry.changes.votesReduced,
        weight_removed: entry.changes.weightRemoved
      });
    }
    competitions.sort(
      (a, b) =>
        b.weight_removed - a.weight_removed ||
        compareStrings(a.competition_id, b.competition_id)
    );
    return {
      revocation_enabled: this.deps.isRevocationEnabled(),
      voters_checked: voters.length,
      voters_losing_votes: losingVoters.size,
      votes_reduced: competitions.reduce(
        (acc, it) => acc + it.votes_reduced,
        0
      ),
      weight_removed: competitions.reduce(
        (acc, it) => acc + it.weight_removed,
        0
      ),
      competitions
    };
  }

  /** Active, published competitions where the voter has active votes. */
  private async candidates(voter: string): Promise<string[]> {
    const ids: string[] = [];
    let afterId = '';
    for (;;) {
      const page = await this.deps.findCandidateCompetitions(
        afterId,
        CANDIDATE_PAGE,
        voter,
        {}
      );
      ids.push(...page);
      if (page.length < CANDIDATE_PAGE) return ids;
      afterId = page[page.length - 1];
    }
  }

  private async previewVoter(
    competitionId: string,
    voter: string,
    rater: string,
    removedByCategory: Map<string, number>,
    read: Map<string, Competition | null>,
    ctx: RequestContext
  ): Promise<{ competition: Competition; change: VoterChange } | null> {
    if (!read.has(competitionId)) {
      read.set(
        competitionId,
        await this.deps.readCompetition(competitionId, ctx)
      );
    }
    const competition = read.get(competitionId) ?? null;
    if (!countsRemovedRep(competition, rater)) return null;
    const removed = removedForCompetition(competition, removedByCategory);
    if (removed <= 0) return null;
    const available = await this.deps.getAvailableCredit(
      competition,
      voter,
      ctx
    );
    const votes = await this.deps.getVoterActiveVotes(
      competitionId,
      voter,
      ctx
    );
    const after = new Map(
      reducedNativeVotes(
        votes,
        available - removed,
        competition.voting.credit_scope
      ).map((vote) => [vote.entryId, vote.value])
    );
    let votesReduced = 0;
    let weightRemoved = 0;
    for (const vote of votes) {
      const value = after.get(vote.entryId) ?? vote.value;
      if (value === vote.value) continue;
      votesReduced++;
      weightRemoved += Math.abs(vote.value) - Math.abs(value);
    }
    return votesReduced
      ? { competition, change: { votesReduced, weightRemoved } }
      : null;
  }
}

export const repRatingsRemovalOvervotePreview =
  new RepRatingsRemovalOvervotePreview({
    findCandidateCompetitions: (afterId, limit, voter, ctx) =>
      nativeCompetitionRuntimeRepository.findOvervoteCandidateCompetitions(
        afterId,
        limit,
        voter,
        ctx
      ),
    readCompetition: (id, ctx) =>
      nativeCompetitionRuntimeRepository.readCompetition(id, ctx),
    getAvailableCredit: async (competition, voter, ctx) =>
      (
        await competitionCreditService.getBudget(
          competition,
          voter,
          undefined,
          ctx
        )
      ).available,
    getVoterActiveVotes: (id, voter, ctx) =>
      nativeCompetitionRuntimeRepository.getVoterActiveVotes(id, voter, ctx),
    findWaveName: async (waveId, ctx) =>
      (await wavesApiDb.findById(waveId, ctx.connection))?.name ?? null,
    inReadTransaction: (fn) =>
      sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        fn({ connection })
      ),
    isRevocationEnabled: () => appFeatures.isDropOvervoteRevocationEnabled()
  });
