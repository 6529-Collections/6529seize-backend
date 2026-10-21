import * as Joi from 'joi';
import { GetCompetitionEntryContextsV3Request } from '@/api/generated/routes/operations';
import { ApiCompetitionEntryContextPage } from '@/api/generated/models/ApiCompetitionEntryContextPage';
import { ApiCompetitionEntry } from '@/api/generated/models/ApiCompetitionEntry';
import { ApiCompetitionDropVoteSummary } from '@/api/generated/models/ApiCompetitionDropVoteSummary';
import { toApiCompetitionAward } from './competition-award.mapper';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { competitionService } from '@/competitions/competition.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionInteractionRepository } from '@/competitions/competition-interaction.repository';
import { competitionEntrySummaryDb } from '@/competitions/competition-entry-summary.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { dropsDb } from '@/drops/drops.db';
import {
  getContext,
  toApiCompetition,
  toApiEntryPage
} from './competitions-v3.handlers';

type BatchSummary = Awaited<ReturnType<typeof competitionEntrySummaryDb.read>>;
type Profiles = Awaited<ReturnType<typeof identityFetcher.getOverviewsByIds>>;
function voteSummary(
  entry: ApiCompetitionEntry,
  timeLock: number | null,
  summary: BatchSummary,
  profiles: Profiles
): ApiCompetitionDropVoteSummary {
  const total = summary.totals.get(entry.id);
  const score = summary.scores.get(entry.id);
  const winner = entry.status === 'WINNER';
  const realtime = Number(total?.total ?? 0);
  const rating =
    winner || (timeLock ?? 0) > 0 ? Number(score?.rating ?? 0) : realtime;
  return {
    rating,
    realtime_rating: realtime,
    rating_prediction: winner ? rating : realtime,
    raters_count: Number(total?.count ?? 0),
    voters_count_available: !winner || Number(total?.snapshot_rows ?? 0) > 0,
    user_vote: Number(total?.user_vote ?? 0),
    rank: score?.rank == null ? entry.rank : Number(score.rank),
    over_threshold_since_ms:
      score?.over_threshold_since == null
        ? null
        : Number(score.over_threshold_since),
    top_raters: summary.voters
      .filter(
        (voter) => voter.entry_id === entry.id && profiles[voter.voter_id]
      )
      .map((voter) => ({
        profile: profiles[voter.voter_id],
        rating: Number(voter.vote)
      }))
  };
}

export async function handleGetCompetitionEntryContextsV3(
  req: GetCompetitionEntryContextsV3Request
): Promise<ApiCompetitionEntryContextPage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    Joi.object({
      wave_id: Joi.string().min(1).max(100).required(),
      competition_id: Joi.string().uuid().required()
    }).unknown(false)
  );
  const { entry_ids } = getValidatedByJoiOrThrow(
    req.query,
    // 50 canonical UUIDs plus 49 commas. The array schema validates each ID.
    Joi.object<{ entry_ids: string }>({
      entry_ids: Joi.string().min(1).max(1849).required()
    }).unknown(false)
  );
  const { ids } = getValidatedByJoiOrThrow(
    { ids: entry_ids.split(',') },
    Joi.object<{ ids: string[] }>({
      ids: Joi.array()
        .items(Joi.string().uuid())
        .min(1)
        .max(50)
        .unique()
        .required()
    })
  );
  const ctx = await getContext(req);
  const competition = await competitionService.getCompetition(
    wave_id,
    competition_id,
    ctx
  );
  const entries = await competitionRepository.findNativeEntriesByIds(
    competition_id,
    ids,
    ctx
  );
  const viewer = ctx.authenticationContext?.getActingAsId() ?? null;
  const drops = await dropsDb.getDropsByIds(
    entries.map((entry) => entry.drop_id),
    ctx.connection
  );
  const presentations = await contentModerationDb.getPresentations(
    drops,
    viewer,
    ctx.connection
  );
  const visibleDrops = new Set(
    drops
      .filter((drop) => {
        const state = presentations[drop.id];
        return (
          drop.wave_id === wave_id &&
          (!state ||
            (state.moderation.can_view &&
              !state.viewer.author_blocked &&
              !state.viewer.drop_hidden))
        );
      })
      .map((drop) => drop.id)
  );
  const visible = entries.filter((entry) => visibleDrops.has(entry.drop_id));
  const apiCompetition = toApiCompetition(competition);
  if (!visible.length) return { competition: apiCompetition, data: [] };
  const [summary, page, awards] = await Promise.all([
    competitionEntrySummaryDb.read(
      competition_id,
      visible.map((entry) => entry.id),
      viewer,
      ctx
    ),
    toApiEntryPage({ data: visible, next_cursor: null, has_more: false }, ctx),
    competitionInteractionRepository.awards(
      { id: competition_id },
      0,
      0,
      ctx,
      visible.map((entry) => entry.id)
    )
  ]);
  const profiles = await identityFetcher.getOverviewsByIds(
    summary.voters.map((voter) => voter.voter_id),
    ctx
  );
  return {
    competition: apiCompetition,
    data: page.data.map((entry) => {
      return {
        entry,
        awards: awards
          .filter((award) => award.entry_id === entry.id)
          .map(toApiCompetitionAward),
        vote_summary: voteSummary(
          entry,
          competition.decisions.time_lock_ms,
          summary,
          profiles
        )
      };
    })
  };
}
