import { competitionDropVotesDb } from '@/competitions/competition-drop-votes.db';
import {
  Competition,
  CompetitionEntry
} from '@/competitions/competition.types';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { ApiCompetitionDropVoteSummary } from '@/api/generated/models/ApiCompetitionDropVoteSummary';
import { ApiDropVotersPage } from '@/api/generated/models/ApiDropVotersPage';
import { ApiDropVoteEditLog } from '@/api/generated/models/ApiDropVoteEditLog';
import { competitionEntryService } from './competition-entry.service';
import { RequestContext } from '@/request.context';
import { DropEntity } from '@/entities/IDrop';
import { NotFoundException } from '@/exceptions';
import { withoutLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';

export async function competitionDropVoteSummary(
  competition: Pick<Competition, 'decisions'>,
  entry: CompetitionEntry,
  ctx: RequestContext
): Promise<ApiCompetitionDropVoteSummary> {
  const [totals, score, voters] = await Promise.all([
    competitionDropVotesDb.totals(
      entry,
      ctx.authenticationContext?.getActingAsId() ?? null,
      ctx
    ),
    competitionDropVotesDb.score(entry, ctx),
    competitionDropVotesDb.voters(entry, 0, 5, 'DESC', ctx)
  ]);
  const profiles = await identityFetcher.getOverviewsByIds(
    voters.map((voter) => voter.voter_id),
    ctx
  );
  const rating =
    entry.status === 'WINNER' || (competition.decisions.time_lock_ms ?? 0) > 0
      ? (score?.rating ?? 0)
      : totals.total;
  const prediction =
    entry.status !== 'WINNER' && (competition.decisions.time_lock_ms ?? 0) > 0
      ? (score?.decision_rating ?? rating)
      : rating;
  return {
    rating,
    over_threshold_since_ms: score?.over_threshold_since ?? null,
    realtime_rating: totals.total,
    rating_prediction: prediction,
    raters_count: totals.count,
    voters_count_available: totals.voters_count_available,
    user_vote: totals.user_vote,
    rank: score?.rank ?? entry.rank,
    top_raters: voters
      .filter((voter) => profiles[voter.voter_id])
      .map((voter) => ({
        profile: profiles[voter.voter_id],
        rating: Number(voter.vote)
      }))
  };
}
async function visibleContext(drop: DropEntity, ctx: RequestContext) {
  const { entry, competition } = await withoutLegacyCompetitionGetFacade(() =>
    competitionEntryService.getDropContext(drop.wave_id, drop.id, ctx)
  );
  if (!entry || !competition)
    throw new NotFoundException('Decision entry not found');
  return { entry, competition };
}
export async function competitionDropVoters(
  drop: DropEntity,
  params: { page: number; page_size: number; sort_direction: string },
  ctx: RequestContext
): Promise<ApiDropVotersPage> {
  const { entry } = await visibleContext(drop, ctx);
  const [rows, totals] = await Promise.all([
    competitionDropVotesDb.voters(
      entry,
      (params.page - 1) * params.page_size,
      params.page_size,
      params.sort_direction,
      ctx
    ),
    competitionDropVotesDb.totals(entry, null, ctx)
  ]);
  const profiles = await identityFetcher.getApiIdentityOverviewsByIds(
    rows.map((row) => row.voter_id),
    ctx
  );
  return {
    page: params.page,
    count: totals.count,
    next: totals.count > params.page * params.page_size,
    data: rows.map((row) => ({
      voter: profiles[row.voter_id],
      vote: Number(row.vote)
    }))
  };
}
export async function competitionDropVoteLogs(
  drop: DropEntity,
  params: { offset: number; limit: number; sort_direction: string },
  ctx: RequestContext
): Promise<ApiDropVoteEditLog[]> {
  const { entry } = await visibleContext(drop, ctx);
  const rows = await competitionDropVotesDb.logs(
    entry,
    params.offset,
    params.limit,
    params.sort_direction,
    ctx
  );
  const profiles = await identityFetcher.getApiIdentityOverviewsByIds(
    rows.map((row) => row.voter_profile_id),
    ctx
  );
  return rows.map((row) => ({
    id: row.id,
    old_vote: Number(row.old_vote),
    new_vote: Number(row.new_vote),
    created_at: Number(row.created_at),
    voter: profiles[row.voter_profile_id]
  }));
}

export async function competitionDropVoteDistribution(
  drop: DropEntity,
  ctx: RequestContext
) {
  const { entry, competition } = await visibleContext(drop, ctx);
  if (competition.type !== 'RANK' || entry.status !== 'ACTIVE') return [];
  return competitionDropVotesDb.distribution(entry, ctx);
}

export async function competitionDropVotersCsv(
  drop: DropEntity,
  ctx: RequestContext
) {
  const { entry } = await visibleContext(drop, ctx);
  const rows = await competitionDropVotesDb.allVoters(entry, ctx);
  const profiles = rows.length
    ? await identityFetcher.getApiIdentityOverviewsByIds(
        rows.map((row) => row.voter_id),
        ctx
      )
    : {};
  return rows.map((row) => {
    const voter = profiles[row.voter_id];
    return {
      handle: voter?.handle ?? '',
      level: voter?.level ?? 0,
      primary_address: voter?.primary_address ?? '',
      vote: Number(row.vote)
    };
  });
}
