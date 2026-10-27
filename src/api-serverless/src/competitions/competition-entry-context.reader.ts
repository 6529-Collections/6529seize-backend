import { ApiCompetitionEntryContextPage } from '@/api/generated/models/ApiCompetitionEntryContextPage';
import { ApiCompetitionEntry } from '@/api/generated/models/ApiCompetitionEntry';
import { ApiCompetitionDropVoteSummary } from '@/api/generated/models/ApiCompetitionDropVoteSummary';
import { ApiDropV2 } from '@/api/generated/models/ApiDropV2';
import { ApiSubmissionDropStatus } from '@/api/generated/models/ApiSubmissionDropStatus';
import { apiDropMapper } from '@/api/drops/api-drop.mapper';
import { toApiCompetitionAward } from './competition-award.mapper';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { competitionService } from '@/competitions/competition.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionInteractionRepository } from '@/competitions/competition-interaction.repository';
import { competitionEntrySummaryDb } from '@/competitions/competition-entry-summary.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { dropsDb } from '@/drops/drops.db';
import { RequestContext } from '@/request.context';
import { toApiCompetition, toApiEntryPage } from './competition-api.mapper';

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

function applyNativeVoting(
  drop: ApiDropV2 | undefined,
  entry: ApiCompetitionEntry,
  vote_summary: ApiCompetitionDropVoteSummary,
  canVote: boolean,
  viewer: string | null,
  hasMetadata: boolean,
  additionalActionPromised: boolean | null | undefined
) {
  if (drop) {
    drop.submission_context = {
      status:
        entry.status === 'WINNER'
          ? ApiSubmissionDropStatus.Winner
          : ApiSubmissionDropStatus.Active,
      has_metadata: hasMetadata,
      ...(additionalActionPromised == null
        ? {}
        : { is_additional_action_promised: additionalActionPromised }),
      ...(entry.won_at === null ? {} : { won_at: entry.won_at }),
      ...(entry.meme_card_id == null
        ? {}
        : { meme_card_id: entry.meme_card_id }),
      voting: {
        is_open: entry.status === 'ACTIVE' && canVote,
        total_votes_given: vote_summary.realtime_rating,
        current_calculated_vote: vote_summary.rating,
        predicted_final_vote: vote_summary.rating_prediction,
        voters_count: vote_summary.raters_count,
        voters_count_available: vote_summary.voters_count_available,
        place: vote_summary.rank ?? 0,
        ...(viewer
          ? {
              context_profile_context: {
                can_vote: entry.status === 'ACTIVE' && canVote,
                current: vote_summary.user_vote,
                min: vote_summary.user_vote,
                max: vote_summary.user_vote
              }
            }
          : {})
      }
    };
  }
}

export async function readCompetitionEntryContexts(
  wave_id: string,
  competition_id: string,
  ids: string[],
  ctx: RequestContext,
  includeCards = false
): Promise<ApiCompetitionEntryContextPage> {
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
  const visibleDropEntities = drops.filter((drop) => visibleDrops.has(drop.id));
  const additionalActionByDrop = new Map(
    visibleDropEntities.map((drop) => [
      drop.id,
      drop.is_additional_action_promised
    ])
  );
  const [summary, page, awards, displayDrops, metadata] = await Promise.all([
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
    ),
    includeCards
      ? apiDropMapper.mapDrops(visibleDropEntities, ctx, {
          includeSubmissionVoting: false
        })
      : Promise.resolve<Record<string, ApiDropV2>>({}),
    includeCards
      ? dropsDb.findMetadataByDropIds(
          visibleDropEntities.map((drop) => drop.id),
          ctx.connection
        )
      : Promise.resolve([])
  ]);
  const profiles = await identityFetcher.getOverviewsByIds(
    summary.voters.map((voter) => voter.voter_id),
    ctx
  );
  const metadataByDrop = new Map<string, typeof metadata>();
  for (const item of metadata) {
    const items = metadataByDrop.get(item.drop_id) ?? [];
    items.push(item);
    metadataByDrop.set(item.drop_id, items);
  }
  return {
    competition: apiCompetition,
    data: page.data.map((entry) => {
      const vote_summary = voteSummary(
        entry,
        competition.decisions.time_lock_ms,
        summary,
        profiles
      );
      const candidate = displayDrops[entry.drop_id];
      const canDisplay =
        candidate &&
        candidate.moderation?.can_view !== false &&
        !candidate.viewer_context?.author_blocked &&
        !candidate.viewer_context?.drop_hidden;
      const drop = canDisplay ? candidate : undefined;
      const dropMetadata = metadataByDrop.get(entry.drop_id) ?? [];
      applyNativeVoting(
        drop,
        entry,
        vote_summary,
        apiCompetition.permissions.vote,
        viewer,
        dropMetadata.length > 0,
        additionalActionByDrop.get(entry.drop_id)
      );
      return {
        entry,
        ...(includeCards && drop
          ? {
              drop,
              metadata: dropMetadata.map(({ data_key, data_value }) => ({
                data_key,
                data_value
              }))
            }
          : {}),
        awards: awards
          .filter((award) => award.entry_id === entry.id)
          .map(toApiCompetitionAward),
        vote_summary
      };
    })
  };
}
