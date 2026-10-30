import {
  toApiCompetition,
  toApiEntry,
  toApiEntryPage
} from './competition-api.mapper';
export {
  toApiCompetition,
  toApiEntry,
  toApiEntryPage
} from './competition-api.mapper';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { readCompetitionEntryContexts } from './competition-entry-context.reader';
import { listCompetitionVoteActivity } from './competition-vote-activity.service';
import { ApiWaveLog } from '@/api/generated/models/ApiWaveLog';
import { getAuthenticationContext } from '@/api/auth/auth';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { ApiCompetition } from '@/api/generated/models/ApiCompetition';
import { ApiDefaultCompetition } from '@/api/generated/models/ApiDefaultCompetition';
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
  GetDefaultWaveCompetitionV3Request,
  GetWaveCompetitionV3Request,
  GetWaveHubV3Request,
  ListCompetitionDecisionsV3Request,
  ListCompetitionEntriesV3Request,
  ListCompetitionEntryVotesV3Request,
  ListCompetitionLeaderboardV3Request,
  ListCompetitionOutcomesV3Request,
  ListCompetitionOutcomeDistributionV3Request,
  ListCompetitionPausesV3Request,
  ListCompetitionVoteActivityV3Request,
  ListCompetitionVersionsV3Request,
  ListCompetitionVotersV3Request,
  ListCompetitionWinnersV3Request,
  ListWaveCompetitionsV3Request
} from '@/api/generated/routes/operations';
import {
  CompetitionEntryStatus,
  CompetitionLifecycle
} from '@/entities/ICompetition';
import {
  competitionService,
  CursorPageRequest,
  PublicCompetition
} from '@/competitions/competition.service';
import {
  CompetitionPage,
  CompetitionVoter
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

type LeaderboardQuery = CursorQuery & {
  readonly is_additional_action_promised?: boolean;
  readonly include?: 'cards';
  readonly sort:
    | 'rating'
    | 'real_time_rating'
    | 'submitted_at'
    | 'trend'
    | 'price';
  readonly price_currency?: string;
  readonly min_price?: number;
  readonly max_price?: number;
};
const LeaderboardQuerySchema: Joi.ObjectSchema<LeaderboardQuery> =
  Joi.object<LeaderboardQuery>({
    is_additional_action_promised: Joi.boolean().optional(),
    direction: Joi.string().valid('ASC', 'DESC').default('DESC'),
    cursor: Joi.string().min(1).max(1000).optional(),
    limit: Joi.number().integer().min(1).max(100).default(50),
    sort: Joi.string()
      .valid('rating', 'real_time_rating', 'submitted_at', 'trend', 'price')
      .default('rating'),
    price_currency: Joi.string().trim().min(1).max(100).optional(),
    min_price: Joi.number().min(0).optional(),
    max_price: Joi.number().min(0).optional(),
    include: Joi.string().valid('cards').optional()
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

export async function getContext(
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

export async function handleGetDefaultWaveCompetitionV3(
  req: GetDefaultWaveCompetitionV3Request
): Promise<ApiDefaultCompetition> {
  getValidatedByJoiOrThrow(req.query, EmptyQuerySchema);
  const { wave_id } = getValidatedByJoiOrThrow(req.params, WavePathSchema);
  return competitionService.getDefaultCompetition(
    wave_id,
    await getContext(req)
  );
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
  const ctx = await getContext(req);
  const page = (await competitionService.listLeaderboard(
    wave_id,
    competition_id,
    {
      ...toCursorRequest(query),
      sort: query.sort,
      price_currency: query.price_currency,
      min_price: query.min_price,
      max_price: query.max_price,
      is_additional_action_promised: query.is_additional_action_promised
    },
    ctx
  )) as unknown as ApiCompetitionLeaderboardPage;
  if (query.include !== 'cards') return page;
  return withCompetitionCards(
    page,
    page.data.map((entry) => entry.entry_id),
    wave_id,
    competition_id,
    query.include,
    ctx
  );
}

export async function handleListCompetitionVotersV3(
  req: ListCompetitionVotersV3Request
): Promise<ApiCompetitionVoterPage> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(req.query, VotersQuerySchema);
  const ctx = await getContext(req);
  const page = await competitionService.listVoters(
    wave_id,
    competition_id,
    toCursorRequest(query),
    query.entry_id,
    ctx
  );
  return await toApiVoterPage(page, ctx);
}

async function toApiVoterPage(
  page: CompetitionPage<CompetitionVoter>,
  ctx: RequestContext
): Promise<ApiCompetitionVoterPage> {
  const profileIds = Array.from(
    new Set(page.data.map((voter) => voter.profile_id))
  );
  const profiles = profileIds.length
    ? await identityFetcher.getOverviewsByIds(profileIds, ctx)
    : {};
  return {
    ...page,
    data: page.data.map((voter) => {
      const profile = profiles[voter.profile_id];
      return profile ? { ...voter, voter: profile } : { ...voter };
    })
  };
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
  const query = getValidatedByJoiOrThrow<CursorQuery & { include?: 'cards' }>(
    req.query,
    cursorQuerySchema('DESC').append<CursorQuery & { include?: 'cards' }>({
      include: Joi.string().valid('cards').optional()
    })
  );
  const ctx = await getContext(req);
  const page = await toApiEntryPage(
    await competitionService.listWinners(
      wave_id,
      competition_id,
      toCursorRequest(query),
      ctx
    ),
    ctx
  );
  if (query.include !== 'cards') return page;
  return withCompetitionCards(
    page,
    page.data.map((entry) => entry.id),
    wave_id,
    competition_id,
    query.include,
    ctx
  );
}

async function withCompetitionCards<
  T extends ApiCompetitionEntryPage | ApiCompetitionLeaderboardPage
>(
  page: T,
  entryIds: string[],
  waveId: string,
  competitionId: string,
  include: 'cards' | undefined,
  ctx: RequestContext
): Promise<T> {
  if (include !== 'cards') return page;
  const cards = entryIds.length
    ? (
        await readCompetitionEntryContexts(
          waveId,
          competitionId,
          entryIds,
          ctx,
          true
        )
      ).data
    : [];
  return { ...page, cards };
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

export async function handleListCompetitionVoteActivityV3(
  req: ListCompetitionVoteActivityV3Request
): Promise<ApiWaveLog[]> {
  const { wave_id, competition_id } = getValidatedByJoiOrThrow(
    req.params,
    CompetitionPathSchema
  );
  const query = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<{ offset: number; limit: number }>({
      offset: Joi.number().integer().min(0).max(100000).default(0),
      limit: Joi.number().integer().min(1).max(100).default(50)
    })
      .unknown(false)
      .required()
  );
  return listCompetitionVoteActivity(
    wave_id,
    competition_id,
    query.offset,
    query.limit,
    await getContext(req)
  );
}
