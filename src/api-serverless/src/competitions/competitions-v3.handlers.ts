import { getAuthenticationContext } from '@/api/auth/auth';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { ApiCompetition } from '@/api/generated/models/ApiCompetition';
import { ApiCompetitionConfigVersionPage } from '@/api/generated/models/ApiCompetitionConfigVersionPage';
import { ApiCompetitionDecisionPage } from '@/api/generated/models/ApiCompetitionDecisionPage';
import { ApiCompetitionDistributionItemPage } from '@/api/generated/models/ApiCompetitionDistributionItemPage';
import { ApiCompetitionEntry } from '@/api/generated/models/ApiCompetitionEntry';
import { ApiCompetitionEntryPage } from '@/api/generated/models/ApiCompetitionEntryPage';
import { ApiCompetitionEntryVotePage } from '@/api/generated/models/ApiCompetitionEntryVotePage';
import { ApiCompetitionLeaderboardPage } from '@/api/generated/models/ApiCompetitionLeaderboardPage';
import { ApiCompetitionOutcomePage } from '@/api/generated/models/ApiCompetitionOutcomePage';
import { ApiCompetitionPage } from '@/api/generated/models/ApiCompetitionPage';
import { ApiCompetitionPausePage } from '@/api/generated/models/ApiCompetitionPausePage';
import { ApiCompetitionVoterPage } from '@/api/generated/models/ApiCompetitionVoterPage';
import { ApiWaveV3 } from '@/api/generated/models/ApiWaveV3';
import {
  GetCompetitionEntryV3Request,
  GetWaveCompetitionV3Request,
  GetWaveHubV3Request,
  ListCompetitionDecisionsV3Request,
  ListCompetitionEntriesV3Request,
  ListCompetitionEntryVotesV3Request,
  ListCompetitionLeaderboardV3Request,
  ListCompetitionOutcomesV3Request,
  ListCompetitionOutcomeDistributionV3Request,
  ListCompetitionPausesV3Request,
  ListCompetitionVersionsV3Request,
  ListCompetitionVotersV3Request,
  ListCompetitionWinnersV3Request,
  ListWaveCompetitionsV3Request
} from '@/api/generated/routes/operations';
import {
  CompetitionEntryStatus,
  CompetitionLifecycle
} from '@/entities/ICompetition';
import { NotFoundException } from '@/exceptions';
import {
  competitionService,
  CursorPageRequest,
  PublicCompetition
} from '@/competitions/competition.service';
import {
  CompetitionEntry,
  CompetitionPage
} from '@/competitions/competition.types';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';
import * as Joi from 'joi';

type WavePath = { readonly wave_id: string };
type CompetitionPath = WavePath & { readonly competition_id: string };
type EntryPath = CompetitionPath & { readonly entry_id: string };
type OutcomePath = CompetitionPath & { readonly outcome_id: string };

type CursorQuery = {
  readonly direction: 'ASC' | 'DESC';
  readonly cursor?: string;
  readonly limit: number;
};

const WavePathSchema: Joi.ObjectSchema<WavePath> = Joi.object({
  wave_id: Joi.string().trim().min(1).max(100).required()
});

const CompetitionPathSchema: Joi.ObjectSchema<CompetitionPath> =
  Joi.object<CompetitionPath>({
    wave_id: Joi.string().trim().min(1).max(100).required(),
    competition_id: Joi.string().uuid().required()
  });

const EntryPathSchema: Joi.ObjectSchema<EntryPath> = Joi.object<EntryPath>({
  wave_id: Joi.string().trim().min(1).max(100).required(),
  competition_id: Joi.string().uuid().required(),
  entry_id: Joi.string().uuid().required()
});

const OutcomePathSchema: Joi.ObjectSchema<OutcomePath> =
  Joi.object<OutcomePath>({
    wave_id: Joi.string().trim().min(1).max(100).required(),
    competition_id: Joi.string().uuid().required(),
    outcome_id: Joi.string().uuid().required()
  });

const EmptyQuerySchema = Joi.object<Record<string, never>>({})
  .unknown(false)
  .required();

function cursorQuerySchema(defaultDirection: 'ASC' | 'DESC' = 'ASC') {
  return Joi.object<CursorQuery>({
    direction: Joi.string().valid('ASC', 'DESC').default(defaultDirection),
    cursor: Joi.string().min(1).max(1000).optional(),
    limit: Joi.number().integer().min(1).max(100).default(50)
  })
    .unknown(false)
    .required();
}

const VersionsQuerySchema = Joi.object<{
  cursor?: string;
  limit: number;
}>({
  cursor: Joi.string().min(1).max(1000).optional(),
  limit: Joi.number().integer().min(1).max(100).default(50)
})
  .unknown(false)
  .required();

const CompetitionListQuerySchema = Joi.object<{
  lifecycle?: CompetitionLifecycle[];
  phase?: string[];
  sort: 'created_at' | 'starts_at' | 'updated_at';
  direction: 'ASC' | 'DESC';
  cursor?: string;
  limit: number;
}>({
  lifecycle: Joi.array()
    .items(Joi.string().valid(...Object.values(CompetitionLifecycle)))
    .max(5)
    .unique()
    .single()
    .optional(),
  phase: Joi.array()
    .items(
      Joi.string().valid(
        'DRAFT',
        'UPCOMING',
        'PARTICIPATION_OPEN',
        'VOTING_OPEN',
        'DECIDING',
        'COMPLETED',
        'CANCELLED',
        'ARCHIVED'
      )
    )
    .max(8)
    .unique()
    .single()
    .optional(),
  sort: Joi.string()
    .valid('created_at', 'starts_at', 'updated_at')
    .default('created_at'),
  direction: Joi.string().valid('ASC', 'DESC').default('ASC'),
  cursor: Joi.string().min(1).max(1000).optional(),
  limit: Joi.number().integer().min(1).max(100).default(50)
})
  .unknown(false)
  .required();

const EntryListQuerySchema = Joi.object<{
  status?: CompetitionEntryStatus[];
  submitter?: string;
  sort: 'submitted_at' | 'rating' | 'rank';
  direction: 'ASC' | 'DESC';
  cursor?: string;
  limit: number;
}>({
  status: Joi.array()
    .items(Joi.string().valid(...Object.values(CompetitionEntryStatus)))
    .max(4)
    .unique()
    .single()
    .optional(),
  submitter: Joi.string().trim().min(1).max(100).optional(),
  sort: Joi.string()
    .valid('submitted_at', 'rating', 'rank')
    .default('submitted_at'),
  direction: Joi.string().valid('ASC', 'DESC').default('ASC'),
  cursor: Joi.string().min(1).max(1000).optional(),
  limit: Joi.number().integer().min(1).max(100).default(50)
})
  .unknown(false)
  .required();

type LeaderboardQuery = CursorQuery & { readonly sort: 'rating' };
const LeaderboardQuerySchema: Joi.ObjectSchema<LeaderboardQuery> =
  Joi.object<LeaderboardQuery>({
    direction: Joi.string().valid('ASC', 'DESC').default('DESC'),
    cursor: Joi.string().min(1).max(1000).optional(),
    limit: Joi.number().integer().min(1).max(100).default(50),
    sort: Joi.string().valid('rating').default('rating')
  })
    .unknown(false)
    .required();

type VotersQuery = CursorQuery & {
  readonly entry_id?: string;
  readonly sort: 'votes';
};
const VotersQuerySchema: Joi.ObjectSchema<VotersQuery> =
  Joi.object<VotersQuery>({
    direction: Joi.string().valid('ASC', 'DESC').default('DESC'),
    cursor: Joi.string().min(1).max(1000).optional(),
    limit: Joi.number().integer().min(1).max(100).default(50),
    entry_id: Joi.string().uuid().optional(),
    sort: Joi.string().valid('votes').default('votes')
  })
    .unknown(false)
    .required();

async function getContext(
  req: Parameters<typeof getAuthenticationContext>[0]
): Promise<RequestContext> {
  const timer = Timer.getFromRequest(req);
  return {
    timer,
    authenticationContext: await getAuthenticationContext(req, timer)
  };
}

function toCursorRequest(query: CursorQuery): CursorPageRequest {
  return {
    direction: query.direction,
    cursor: query.cursor,
    limit: query.limit
  };
}

function toApiCompetition(competition: PublicCompetition): ApiCompetition {
  return {
    ...competition,
    capabilities: [...competition.capabilities]
  } as unknown as ApiCompetition;
}

async function toApiEntry(
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
  return { ...data, submitter } as unknown as ApiCompetitionEntry;
}

async function toApiEntryPage(
  page: CompetitionPage<CompetitionEntry>,
  ctx: RequestContext
): Promise<ApiCompetitionEntryPage> {
  const profileIds = Array.from(
    new Set(page.data.map((it) => it.submitter_id))
  );
  const submitters = await identityFetcher.getOverviewsByIds(profileIds, ctx);
  return {
    ...page,
    data: page.data.map((entry) => {
      const submitter = submitters[entry.submitter_id];
      if (!submitter) throw new NotFoundException(`Entry submitter not found`);
      const { submitter_id: _submitterId, ...data } = entry;
      return { ...data, submitter } as unknown as ApiCompetitionEntry;
    })
  };
}

export async function handleGetWaveHubV3(
  req: GetWaveHubV3Request
): Promise<ApiWaveV3> {
  getValidatedByJoiOrThrow(req.query, EmptyQuerySchema);
  const { wave_id } = getValidatedByJoiOrThrow(req.params, WavePathSchema);
  return (await competitionService.getHub(
    wave_id,
    await getContext(req)
  )) as ApiWaveV3;
}

export async function handleListWaveCompetitionsV3(
  req: ListWaveCompetitionsV3Request
): Promise<ApiCompetitionPage> {
  const { wave_id } = getValidatedByJoiOrThrow(req.params, WavePathSchema);
  const query = getValidatedByJoiOrThrow(req.query, CompetitionListQuerySchema);
  const page = await competitionService.listCompetitions(
    wave_id,
    {
      lifecycle: query.lifecycle,
      phase: query.phase as PublicCompetition['computed_phase'][] | undefined,
      sort: query.sort,
      direction: query.direction,
      cursor: query.cursor,
      limit: query.limit
    },
    await getContext(req)
  );
  return {
    ...page,
    data: page.data.map(toApiCompetition)
  };
}

export async function handleGetWaveCompetitionV3(
  req: GetWaveCompetitionV3Request
): Promise<ApiCompetition> {
  getValidatedByJoiOrThrow(req.query, EmptyQuerySchema);
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  return toApiCompetition(
    await competitionService.getCompetition(
      wave_id,
      competition_id,
      await getContext(req)
    )
  );
}

export async function handleListCompetitionVersionsV3(
  req: ListCompetitionVersionsV3Request
): Promise<ApiCompetitionConfigVersionPage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, VersionsQuerySchema);
  return (await competitionService.listVersions(
    wave_id,
    competition_id,
    query,
    await getContext(req)
  )) as unknown as ApiCompetitionConfigVersionPage;
}

export async function handleListCompetitionEntriesV3(
  req: ListCompetitionEntriesV3Request
): Promise<ApiCompetitionEntryPage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, EntryListQuerySchema);
  const ctx = await getContext(req);
  const page = await competitionService.listEntries(
    wave_id,
    competition_id,
    { ...toCursorRequest(query), sort: query.sort },
    { status: query.status, submitterId: query.submitter },
    ctx
  );
  return await toApiEntryPage(page, ctx);
}

export async function handleGetCompetitionEntryV3(
  req: GetCompetitionEntryV3Request
): Promise<ApiCompetitionEntry> {
  getValidatedByJoiOrThrow(req.query, EmptyQuerySchema);
  const { wave_id, competition_id, entry_id } = getValidatedByJoiOrThrow(
    req.params,
    EntryPathSchema
  );
  const ctx = await getContext(req);
  return await toApiEntry(
    await competitionService.getEntry(wave_id, competition_id, entry_id, ctx),
    ctx
  );
}

export async function handleListCompetitionEntryVotesV3(
  req: ListCompetitionEntryVotesV3Request
): Promise<ApiCompetitionEntryVotePage> {
  const { wave_id, competition_id, entry_id } = getValidatedByJoiOrThrow(
    req.params,
    EntryPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, cursorQuerySchema());
  return (await competitionService.listEntryVotes(
    wave_id,
    competition_id,
    entry_id,
    toCursorRequest(query),
    await getContext(req)
  )) as unknown as ApiCompetitionEntryVotePage;
}

export async function handleListCompetitionLeaderboardV3(
  req: ListCompetitionLeaderboardV3Request
): Promise<ApiCompetitionLeaderboardPage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, LeaderboardQuerySchema);
  return (await competitionService.listLeaderboard(
    wave_id,
    competition_id,
    toCursorRequest(query),
    await getContext(req)
  )) as unknown as ApiCompetitionLeaderboardPage;
}

export async function handleListCompetitionVotersV3(
  req: ListCompetitionVotersV3Request
): Promise<ApiCompetitionVoterPage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, VotersQuerySchema);
  return (await competitionService.listVoters(
    wave_id,
    competition_id,
    toCursorRequest(query),
    query.entry_id,
    await getContext(req)
  )) as unknown as ApiCompetitionVoterPage;
}

export async function handleListCompetitionDecisionsV3(
  req: ListCompetitionDecisionsV3Request
): Promise<ApiCompetitionDecisionPage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, cursorQuerySchema());
  return (await competitionService.listDecisions(
    wave_id,
    competition_id,
    toCursorRequest(query),
    await getContext(req)
  )) as unknown as ApiCompetitionDecisionPage;
}

export async function handleListCompetitionWinnersV3(
  req: ListCompetitionWinnersV3Request
): Promise<ApiCompetitionEntryPage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, cursorQuerySchema());
  const ctx = await getContext(req);
  return await toApiEntryPage(
    await competitionService.listWinners(
      wave_id,
      competition_id,
      toCursorRequest(query),
      ctx
    ),
    ctx
  );
}

export async function handleListCompetitionOutcomesV3(
  req: ListCompetitionOutcomesV3Request
): Promise<ApiCompetitionOutcomePage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, cursorQuerySchema());
  return (await competitionService.listOutcomes(
    wave_id,
    competition_id,
    toCursorRequest(query),
    await getContext(req)
  )) as unknown as ApiCompetitionOutcomePage;
}

export async function handleListCompetitionOutcomeDistributionV3(
  req: ListCompetitionOutcomeDistributionV3Request
): Promise<ApiCompetitionDistributionItemPage> {
  const { wave_id, competition_id, outcome_id } = getValidatedByJoiOrThrow(
    req.params,
    OutcomePathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, cursorQuerySchema());
  return (await competitionService.listDistribution(
    wave_id,
    competition_id,
    outcome_id,
    toCursorRequest(query),
    await getContext(req)
  )) as unknown as ApiCompetitionDistributionItemPage;
}

export async function handleListCompetitionPausesV3(
  req: ListCompetitionPausesV3Request
): Promise<ApiCompetitionPausePage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, cursorQuerySchema());
  return (await competitionService.listPauses(
    wave_id,
    competition_id,
    toCursorRequest(query),
    await getContext(req)
  )) as unknown as ApiCompetitionPausePage;
}
