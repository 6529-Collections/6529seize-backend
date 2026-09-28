import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { NewDropSchema, NewWaveDropSchema } from '@/api/drops/drop.validator';
import {
  WaveChatSchema,
  WaveScopeSchema,
  WaveVisibilitySchema
} from '@/api/waves/wave-write.schemas';
import { Timer } from '@/time';
import { RequestContext } from '@/request.context';
import { NotFoundException } from '@/exceptions';
import { ApiCompetition } from '@/api/generated/models/ApiCompetition';
import { ApiCompetitionCreditBudget } from '@/api/generated/models/ApiCompetitionCreditBudget';
import { ApiCompetitionEntryStatus } from '@/api/generated/models/ApiCompetitionEntryStatus';
import { ApiCompetitionEntry } from '@/api/generated/models/ApiCompetitionEntry';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiCompetitionMyVotePage } from '@/api/generated/models/ApiCompetitionMyVotePage';
import { ApiCompetitionAwardPage } from '@/api/generated/models/ApiCompetitionAwardPage';
import { ApiCreateCompetitionEntryRequest } from '@/api/generated/models/ApiCreateCompetitionEntryRequest';
import { ApiCompetitionActionRequest } from '@/api/generated/models/ApiCompetitionActionRequest';
import { ApiCreateWaveHubRequest } from '@/api/generated/models/ApiCreateWaveHubRequest';
import { ApiSetCompetitionVoteRequest } from '@/api/generated/models/ApiSetCompetitionVoteRequest';
import { ApiCreateCompetitionRequest } from '@/api/generated/models/ApiCreateCompetitionRequest';
import { ApiUpdateCompetitionRequest } from '@/api/generated/models/ApiUpdateCompetitionRequest';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { ApiWaveV3 } from '@/api/generated/models/ApiWaveV3';
import {
  CreateWaveHubV3Request,
  CreateCompetitionV3Request,
  UpdateCompetitionV3Request,
  ExecuteCompetitionActionV3Request,
  CreateCompetitionEntryV3Request,
  ExecuteCompetitionEntryActionV3Request,
  SetCompetitionVoteV3Request,
  GetCompetitionCreditBudgetV3Request,
  ListCompetitionMyVotesV3Request,
  ListCompetitionAwardsV3Request,
  GetCompetitionConfigurationV3Request,
  GetCompetitionEntryContentV3Request,
  GetCompetitionEntryContentCandidateV3Request
} from '@/api/generated/routes/operations';
import { CompetitionCreditBudget } from '@/competitions/competition-credit.service';
import { competitionService } from '@/competitions/competition.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionCursorCodec } from '@/competitions/competition-cursor';
import { competitionInteractionRepository } from '@/competitions/competition-interaction.repository';
import { CompetitionDraftSchema } from './competition-configuration';
import { competitionLifecycleService } from './competition-lifecycle.service';
import { competitionVotingService } from './competition-voting.service';
import { competitionEntryService } from './competition-entry.service';
import { waveHubCreationService } from './wave-hub-creation.service';
import { competitionActor } from './competition-command-access';
import { toApiEntry } from './competitions-v3.handlers';

const pathFields = {
  wave_id: Joi.string().min(1).max(100).required(),
  competition_id: Joi.string().uuid().required()
};
const commandFields = {
  idempotency_key: Joi.string().uuid().required(),
  config_version: Joi.number().integer().min(1).required()
};
const signatureSchema = Joi.object({
  message: Joi.string().max(10000).required(),
  signature: Joi.string().max(20000).required()
}).unknown(false);
const actionSchema = Joi.object<ApiCompetitionActionRequest>({
  ...commandFields,
  reason: Joi.string().max(2000).allow(null, ''),
  starts_at: Joi.number().integer().min(0).allow(null),
  ends_at: Joi.number().integer().min(0).allow(null)
}).unknown(false);
const pageSchema = Joi.object<{ cursor?: string; limit: number }>({
  cursor: Joi.string().max(1000),
  limit: Joi.number().integer().min(1).max(100).default(50)
}).unknown(false);

async function context(
  req: Parameters<typeof getAuthenticationContext>[0]
): Promise<RequestContext> {
  const timer = Timer.getFromRequest(req);
  return {
    timer,
    authenticationContext: await getAuthenticationContext(req, timer)
  };
}
function noQuery(query: unknown): void {
  getValidatedByJoiOrThrow(query, Joi.object({}).unknown(false));
}
function path<T>(params: T, extra: Joi.SchemaMap = {}): T {
  return getValidatedByJoiOrThrow(
    params,
    Joi.object({ ...pathFields, ...extra }).unknown(false)
  );
}
function budgetResponse(
  budget: CompetitionCreditBudget
): ApiCompetitionCreditBudget {
  return {
    ...budget,
    credit_type: budget.credit_type as ApiWaveCreditType,
    credit_scope: budget.credit_scope as ApiWaveCreditScope
  };
}

export async function handleCreateWaveHubV3(
  req: CreateWaveHubV3Request
): Promise<ApiWaveV3> {
  noQuery(req.query);
  const request = getValidatedByJoiOrThrow(
    req.body,
    Joi.object<ApiCreateWaveHubRequest>({
      idempotency_key: commandFields.idempotency_key,
      name: Joi.string().min(1).max(250).required(),
      picture: Joi.string()
        .uri({ scheme: ['https'] })
        .allow(null)
        .required(),
      description_drop: NewWaveDropSchema.required(),
      visibility: WaveVisibilitySchema.required(),
      chat: WaveChatSchema.required(),
      admin_group: WaveScopeSchema.required(),
      parent_wave_id: Joi.string().min(1).max(100).allow(null)
    }).unknown(false)
  );
  return waveHubCreationService.create(request, await context(req));
}

export async function handleCreateCompetitionV3(
  req: CreateCompetitionV3Request
): Promise<ApiCompetition> {
  noQuery(req.query);
  const { wave_id } = getValidatedByJoiOrThrow(
    req.params,
    Joi.object({ wave_id: pathFields.wave_id })
  );
  const request = getValidatedByJoiOrThrow(
    req.body,
    Joi.object<ApiCreateCompetitionRequest>({
      idempotency_key: commandFields.idempotency_key,
      config: CompetitionDraftSchema.required()
    }).unknown(false)
  );
  return (await competitionLifecycleService.create(
    wave_id,
    request,
    await context(req)
  )) as unknown as ApiCompetition;
}

export async function handleUpdateCompetitionV3(
  req: UpdateCompetitionV3Request
): Promise<ApiCompetition> {
  noQuery(req.query);
  const { wave_id, competition_id } = path(req.params);
  const request = getValidatedByJoiOrThrow(
    req.body,
    Joi.object<ApiUpdateCompetitionRequest>({
      ...commandFields,
      config: CompetitionDraftSchema.required()
    }).unknown(false)
  );
  return (await competitionLifecycleService.update(
    wave_id,
    competition_id,
    request,
    await context(req)
  )) as unknown as ApiCompetition;
}

export async function handleExecuteCompetitionActionV3(
  req: ExecuteCompetitionActionV3Request
): Promise<ApiCompetition> {
  noQuery(req.query);
  const { wave_id, competition_id, action } = path(req.params, {
    action: Joi.string()
      .valid('publish', 'end', 'cancel', 'archive', 'clone', 'pause', 'resume')
      .required()
  });
  const request = getValidatedByJoiOrThrow(req.body, actionSchema);
  return (await competitionLifecycleService.action(
    wave_id,
    competition_id,
    action,
    request,
    await context(req)
  )) as unknown as ApiCompetition;
}

export async function handleGetCompetitionConfigurationV3(
  req: GetCompetitionConfigurationV3Request
): Promise<ApiCompetitionDraftInput> {
  noQuery(req.query);
  const { wave_id, competition_id } = path(req.params);
  return competitionLifecycleService.configuration(
    wave_id,
    competition_id,
    await context(req)
  );
}

export async function handleCreateCompetitionEntryV3(
  req: CreateCompetitionEntryV3Request
): Promise<ApiCompetitionEntry> {
  noQuery(req.query);
  const { wave_id, competition_id } = path(req.params);
  const schema = Joi.object<ApiCreateCompetitionEntryRequest>({
    ...commandFields,
    drop: NewDropSchema.prefs({ noDefaults: true, convert: false }),
    drop_id: Joi.string().min(1).max(100),
    drop_content_hash: Joi.string().pattern(/^[0-9a-f]{64}$/),
    signature: signatureSchema
  })
    .xor('drop', 'drop_id')
    .unknown(false);
  const request = getValidatedByJoiOrThrow(req.body, schema);
  const ctx = await context(req);
  return toApiEntry(
    await competitionEntryService.create(wave_id, competition_id, request, ctx),
    ctx
  );
}

export async function handleExecuteCompetitionEntryActionV3(
  req: ExecuteCompetitionEntryActionV3Request
): Promise<ApiCompetitionEntry> {
  noQuery(req.query);
  const { wave_id, competition_id, entry_id, action } = path(req.params, {
    entry_id: Joi.string().uuid().required(),
    action: Joi.string().valid('withdraw', 'disqualify').required()
  });
  const ctx = await context(req);
  return toApiEntry(
    await competitionEntryService.action(
      wave_id,
      competition_id,
      entry_id,
      action,
      getValidatedByJoiOrThrow(req.body, actionSchema),
      ctx
    ),
    ctx
  );
}

export async function handleGetCompetitionEntryContentCandidateV3(
  req: GetCompetitionEntryContentCandidateV3Request
): Promise<ApiCreateDropRequest> {
  noQuery(req.query);
  const { wave_id, competition_id, drop_id } = path(req.params, {
    drop_id: Joi.string().min(1).max(100).required()
  });
  return competitionEntryService.getCandidateContent(
    wave_id,
    competition_id,
    drop_id,
    await context(req)
  );
}

export async function handleGetCompetitionEntryContentV3(
  req: GetCompetitionEntryContentV3Request
): Promise<ApiCreateDropRequest> {
  noQuery(req.query);
  const { wave_id, competition_id, entry_id } = path(req.params, {
    entry_id: Joi.string().uuid().required()
  });
  return competitionEntryService.getContent(
    wave_id,
    competition_id,
    entry_id,
    await context(req)
  );
}

export async function handleSetCompetitionVoteV3(
  req: SetCompetitionVoteV3Request
): Promise<ApiCompetitionCreditBudget> {
  noQuery(req.query);
  const { wave_id, competition_id, entry_id } = path(req.params, {
    entry_id: Joi.string().uuid().required()
  });
  const request = getValidatedByJoiOrThrow(
    req.body,
    Joi.object<ApiSetCompetitionVoteRequest>({
      ...commandFields,
      value: Joi.number()
        .integer()
        .min(Number.MIN_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER)
        .required(),
      signature: signatureSchema
    }).unknown(false)
  );
  return budgetResponse(
    await competitionVotingService.vote(
      wave_id,
      competition_id,
      entry_id,
      request,
      await context(req)
    )
  );
}

export async function handleGetCompetitionCreditBudgetV3(
  req: GetCompetitionCreditBudgetV3Request
): Promise<ApiCompetitionCreditBudget> {
  const { wave_id, competition_id } = path(req.params);
  const { entry_id } = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<{ entry_id?: string }>({
      entry_id: Joi.string().uuid()
    }).unknown(false)
  );
  return budgetResponse(
    await competitionVotingService.budget(
      wave_id,
      competition_id,
      entry_id,
      await context(req)
    )
  );
}

export async function handleListCompetitionMyVotesV3(
  req: ListCompetitionMyVotesV3Request
): Promise<ApiCompetitionMyVotePage> {
  const { wave_id, competition_id } = path(req.params);
  const query = getValidatedByJoiOrThrow(req.query, pageSchema);
  const ctx = await context(req);
  const actor = competitionActor(ctx);
  await competitionService.getCompetition(wave_id, competition_id, ctx);
  const record = await competitionRepository.findCompetitionRecordById(
    competition_id,
    ctx
  );
  if (!record) throw new NotFoundException('Competition not found');
  const scope = `competition:${competition_id}:my-votes:${actor}`;
  const offset = competitionCursorCodec.decode(query.cursor, scope, {});
  const rows = await competitionInteractionRepository.myVotes(
    record,
    actor,
    offset,
    query.limit + 1,
    ctx
  );
  return {
    data: rows.slice(0, query.limit).map((row) => ({
      ...row,
      entry_status: row.entry_status as unknown as ApiCompetitionEntryStatus
    })),
    has_more: rows.length > query.limit,
    next_cursor:
      rows.length > query.limit
        ? competitionCursorCodec.encode(scope, {}, offset + query.limit)
        : null
  };
}

export async function handleListCompetitionAwardsV3(
  req: ListCompetitionAwardsV3Request
): Promise<ApiCompetitionAwardPage> {
  const { wave_id, competition_id } = path(req.params);
  const query = getValidatedByJoiOrThrow(req.query, pageSchema);
  const ctx = await context(req);
  await competitionService.getCompetition(wave_id, competition_id, ctx);
  const record = await competitionRepository.findCompetitionRecordById(
    competition_id,
    ctx
  );
  if (!record) throw new NotFoundException('Competition not found');
  const scope = `competition:${competition_id}:awards`;
  const offset = competitionCursorCodec.decode(query.cursor, scope, {});
  const rows = await competitionInteractionRepository.awards(
    record,
    offset,
    query.limit + 1,
    ctx
  );
  return {
    data: rows.slice(0, query.limit),
    has_more: rows.length > query.limit,
    next_cursor:
      rows.length > query.limit
        ? competitionCursorCodec.encode(scope, {}, offset + query.limit)
        : null
  };
}
