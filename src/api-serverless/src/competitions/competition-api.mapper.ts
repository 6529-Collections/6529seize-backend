import { ApiCompetition } from '@/api/generated/models/ApiCompetition';
import { ApiCompetitionCapability } from '@/api/generated/models/ApiCompetitionCapability';
import { ApiCompetitionComputedPhase } from '@/api/generated/models/ApiCompetitionComputedPhase';
import { ApiCompetitionLifecycle } from '@/api/generated/models/ApiCompetitionLifecycle';
import { ApiCompetitionType } from '@/api/generated/models/ApiCompetitionType';
import { ApiCompetitionParticipationConfigRequiredMediaEnum } from '@/api/generated/models/ApiCompetitionParticipationConfig';
import { ApiCompetitionEntry } from '@/api/generated/models/ApiCompetitionEntry';
import { ApiCompetitionEntryPage } from '@/api/generated/models/ApiCompetitionEntryPage';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { memeCardDropMappingsDb } from '@/minting-claims/meme-card-drop-mappings.db';
import { PublicCompetition } from '@/competitions/competition.service';
import {
  CompetitionEntry,
  CompetitionPage
} from '@/competitions/competition.types';
import { RequestContext } from '@/request.context';
import { NotFoundException } from '@/exceptions';
import { enums } from '@/enums';
import {
  anonymousCompetitionAuthor,
  competitionAnonymityService
} from '@/competitions/competition-anonymity';

export function toApiCompetition(
  competition: PublicCompetition
): ApiCompetition {
  const { presentation, ...details } = competition;
  return {
    ...details,
    type: enums.resolveOrThrow(ApiCompetitionType, competition.type),
    lifecycle: enums.resolveOrThrow(
      ApiCompetitionLifecycle,
      competition.lifecycle
    ),
    computed_phase: enums.resolveOrThrow(
      ApiCompetitionComputedPhase,
      competition.computed_phase
    ),
    participation: {
      ...competition.participation,
      required_metadata: [...competition.participation.required_metadata],
      required_media: competition.participation.required_media.map((media) =>
        enums.resolveOrThrow(
          ApiCompetitionParticipationConfigRequiredMediaEnum,
          media
        )
      )
    },
    voting: {
      ...competition.voting,
      credit_nfts: [...competition.voting.credit_nfts]
    },
    outcome_config: [...competition.outcome_config],
    capabilities: competition.capabilities.map((capability) =>
      enums.resolveOrThrow(ApiCompetitionCapability, capability)
    ),
    ...(presentation ? { presentation: [...presentation] } : {})
  };
}

export async function toApiEntry(
  entry: CompetitionEntry,
  ctx: RequestContext
): Promise<ApiCompetitionEntry> {
  const submitters = await identityFetcher.getOverviewsByIds(
    [entry.submitter_id],
    ctx
  );
  const submitter = submitters[entry.submitter_id];
  if (!submitter) {
    throw new NotFoundException(`Entry submitter not found`);
  }
  const { submitter_id: _submitterId, ...data } = entry;
  const hiddenDropIds = await competitionAnonymityService.hiddenDropIds(
    [entry.drop_id],
    ctx
  );
  const memeCardIds = await memeCardDropMappingsDb.findMemeCardIdsByEntryIds(
    entry.competition_id,
    [entry.id],
    ctx
  );
  return {
    ...data,
    submitter: hiddenDropIds.has(entry.drop_id)
      ? anonymousCompetitionAuthor(submitter, entry.drop_id)
      : submitter,
    meme_card_id: memeCardIds[entry.id] ?? null
  } as unknown as ApiCompetitionEntry;
}

export async function toApiEntryPage(
  page: CompetitionPage<CompetitionEntry>,
  ctx: RequestContext
): Promise<ApiCompetitionEntryPage> {
  const profileIds = Array.from(
    new Set(page.data.map((it) => it.submitter_id))
  );
  const submitters = await identityFetcher.getOverviewsByIds(profileIds, ctx);
  const hiddenDropIds = await competitionAnonymityService.hiddenDropIds(
    page.data.map((entry) => entry.drop_id),
    ctx
  );
  const memeCardIds = page.data.length
    ? await memeCardDropMappingsDb.findMemeCardIdsByEntryIds(
        page.data[0].competition_id,
        page.data.map((entry) => entry.id),
        ctx
      )
    : {};
  return {
    ...page,
    data: page.data.map((entry) => {
      const submitter = submitters[entry.submitter_id];
      if (!submitter) throw new NotFoundException(`Entry submitter not found`);
      const { submitter_id: _submitterId, ...data } = entry;
      return {
        ...data,
        submitter: hiddenDropIds.has(entry.drop_id)
          ? anonymousCompetitionAuthor(submitter, entry.drop_id)
          : submitter,
        meme_card_id: memeCardIds[entry.id] ?? null
      } as unknown as ApiCompetitionEntry;
    })
  };
}
