import { identityFetcher } from '@/api/identities/identity.fetcher';
import { randomUUID } from 'node:crypto';
import { appFeatures } from '@/app-features';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { ApiCompetitionActionRequest } from '@/api/generated/models/ApiCompetitionActionRequest';
import { ApiCreateCompetitionRequest } from '@/api/generated/models/ApiCreateCompetitionRequest';
import { ApiUpdateCompetitionRequest } from '@/api/generated/models/ApiUpdateCompetitionRequest';
import { waveApiService } from '@/api/waves/wave.api.service';
import { competitionService } from '@/competitions/competition.service';
import {
  competitionCommandRepository,
  competitionConflict
} from '@/competitions/competition-command.repository';
import { competitionPayloadHash } from '@/competitions/competition-command-identity';
import {
  competitionRepository,
  CompetitionRecord
} from '@/competitions/competition.repository';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import {
  CompetitionEntity,
  CompetitionExecutionMode,
  CompetitionLifecycle,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';
import { BadRequestException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import {
  administerCompetitionWave,
  competitionActor,
  lockNativeCompetition,
  requireNativeWrites
} from './competition-command-access';
import {
  competitionValidationWave,
  configurationToRecord
} from './competition-configuration';

export type CompetitionLifecycleAction =
  | 'publish'
  | 'end'
  | 'cancel'
  | 'archive'
  | 'clone'
  | 'pause'
  | 'resume';

function entity(record: CompetitionRecord): CompetitionEntity {
  return competitionRepository.parseCompetitionRecord(
    record
  ) as unknown as CompetitionEntity;
}

function signableRules(config: ApiCompetitionDraftInput): unknown {
  const {
    title: _title,
    description: _description,
    presentation: _presentation,
    ...rules
  } = config;
  return rules;
}

function newRecord(
  waveId: string,
  input: ApiCompetitionDraftInput,
  now: number
): CompetitionEntity {
  return configurationToRecord(input, {
    id: randomUUID(),
    wave_id: waveId,
    legacy_wave_id: null,
    storage_mode: CompetitionStorageMode.NATIVE,
    execution_mode: CompetitionExecutionMode.DISABLED,
    lifecycle: CompetitionLifecycle.DRAFT,
    type: CompetitionType.RANK,
    title: '',
    description: null,
    presentation_config: [],
    participation_config: {},
    voting_config: {},
    decision_config: {},
    winner_config: {},
    outcome_config: [],
    config_version: 1,
    participation_starts_at: null,
    participation_ends_at: null,
    voting_starts_at: null,
    voting_ends_at: null,
    created_at: now,
    updated_at: now,
    published_at: null,
    ended_at: null,
    cancelled_at: null,
    archived_at: null
  });
}

export class CompetitionLifecycleService {
  private async normalizeConfiguration(
    config: ApiCompetitionDraftInput,
    ctx: RequestContext
  ): Promise<ApiCompetitionDraftInput> {
    if (!config.voting.creditor_id) return config;
    const creditorId = await identityFetcher.getProfileIdByIdentityKeyOrThrow(
      { identityKey: config.voting.creditor_id },
      ctx
    );
    return { ...config, voting: { ...config.voting, creditor_id: creditorId } };
  }

  public async create(
    waveId: string,
    request: ApiCreateCompetitionRequest,
    ctx: RequestContext
  ) {
    requireNativeWrites();
    await administerCompetitionWave(waveId, ctx);
    const actor = competitionActor(ctx);
    return competitionCommandRepository.command(
      actor,
      request.idempotency_key,
      { waveId, action: 'create', request },
      async (tx) => {
        await competitionCommandRepository.lockWave(waveId, tx);
        const { wave } = await administerCompetitionWave(waveId, tx);
        const config = await this.normalizeConfiguration(request.config, tx);
        await waveApiService.validateNativeCompetitionConfiguration(
          competitionValidationWave(config, wave),
          tx
        );
        const record = newRecord(waveId, config, Date.now());
        await this.persistNew(record, config, actor, tx);
        return competitionService.getCompetition(waveId, record.id, tx);
      },
      ctx
    );
  }

  public async configuration(
    waveId: string,
    competitionId: string,
    ctx: RequestContext
  ): Promise<ApiCompetitionDraftInput> {
    await competitionService.getCompetition(waveId, competitionId, ctx);
    await administerCompetitionWave(waveId, ctx);
    const record = await competitionRepository.findCompetitionRecordById(
      competitionId,
      ctx
    );
    if (
      record?.wave_id !== waveId ||
      record.storage_mode !== CompetitionStorageMode.NATIVE
    )
      competitionConflict('Native competition configuration is unavailable');
    return competitionCommandRepository.getConfiguration(
      competitionId,
      Number(record.config_version),
      ctx
    );
  }

  public async update(
    waveId: string,
    competitionId: string,
    request: ApiUpdateCompetitionRequest,
    ctx: RequestContext
  ) {
    requireNativeWrites();
    await administerCompetitionWave(waveId, ctx);
    const actor = competitionActor(ctx);
    return competitionCommandRepository.command(
      actor,
      request.idempotency_key,
      { waveId, competitionId, action: 'update', request },
      async (tx) => {
        const { record } = await lockNativeCompetition(
          waveId,
          competitionId,
          request.config_version,
          tx
        );
        const { wave } = await administerCompetitionWave(waveId, tx);
        const config = await this.normalizeConfiguration(request.config, tx);
        if (
          ![
            CompetitionLifecycle.DRAFT,
            CompetitionLifecycle.PUBLISHED
          ].includes(record.lifecycle)
        )
          competitionConflict(
            'Clone a terminal competition to change its rules'
          );
        const previous =
          await competitionCommandRepository.getConfiguration<ApiCompetitionDraftInput>(
            competitionId,
            Number(record.config_version),
            tx
          );
        const rulesChanged =
          competitionPayloadHash(signableRules(previous)) !==
          competitionPayloadHash(signableRules(config));
        if (
          record.lifecycle === CompetitionLifecycle.PUBLISHED &&
          config.rules.type !== previous.rules.type
        )
          competitionConflict('Published competition type cannot change');
        if (
          rulesChanged &&
          (await competitionCommandRepository.hasActivity(competitionId, tx))
        )
          competitionConflict(
            'Rules are immutable after the first accepted entry'
          );
        await waveApiService.validateNativeCompetitionConfiguration(
          competitionValidationWave(config, wave),
          tx
        );
        const now = Date.now();
        if (record.lifecycle === CompetitionLifecycle.PUBLISHED && rulesChanged)
          this.validatePublicationDates(config, now);
        const updated = configurationToRecord(config, entity(record));
        const next = {
          ...updated,
          config_version: Number(record.config_version) + 1,
          updated_at: now,
          decision_config: rulesChanged
            ? updated.decision_config
            : entity(record).decision_config
        };
        await competitionCommandRepository.saveCompetition(
          next,
          actor,
          config,
          tx
        );
        if (rulesChanged)
          await competitionCommandRepository.replaceOutcomeDefinitions(
            competitionId,
            config.outcomes,
            next.updated_at,
            tx
          );
        await this.event(
          next,
          rulesChanged ? 'COMPETITION_SCHEDULE_CHANGED' : 'COMPETITION_UPDATED',
          request.idempotency_key,
          tx
        );
        return competitionService.getCompetition(waveId, competitionId, tx);
      },
      ctx
    );
  }

  public async action(
    waveId: string,
    competitionId: string,
    action: CompetitionLifecycleAction,
    request: ApiCompetitionActionRequest,
    ctx: RequestContext
  ) {
    requireNativeWrites();
    await administerCompetitionWave(waveId, ctx);
    const actor = competitionActor(ctx);
    return competitionCommandRepository.command(
      actor,
      request.idempotency_key,
      { waveId, competitionId, action, request },
      async (tx) => {
        const { record } = await lockNativeCompetition(
          waveId,
          competitionId,
          request.config_version,
          tx
        );
        const { wave } = await administerCompetitionWave(waveId, tx);
        const config =
          await competitionCommandRepository.getConfiguration<ApiCompetitionDraftInput>(
            competitionId,
            Number(record.config_version),
            tx
          );
        const now = Date.now();
        if (action === 'clone') {
          if (
            ![
              CompetitionLifecycle.ENDED,
              CompetitionLifecycle.CANCELLED,
              CompetitionLifecycle.ARCHIVED
            ].includes(record.lifecycle)
          )
            competitionConflict('Only terminal competitions can be cloned');
          const clone = newRecord(waveId, config, now);
          await this.persistNew(clone, config, actor, tx);
          return competitionService.getCompetition(waveId, clone.id, tx);
        }
        if (action === 'publish') {
          if (!appFeatures.isNativeCompetitionExecutionEnabled())
            competitionConflict(
              'Native execution must be enabled before publication'
            );
          await waveApiService.validateNativeCompetitionConfiguration(
            competitionValidationWave(config, wave),
            tx
          );
          this.validatePublicationDates(config, now);
        }
        const changed = this.transition(entity(record), action, now);
        if (action === 'pause') {
          const startsAt = request.starts_at ?? now;
          const endsAt = request.ends_at ?? null;
          if (startsAt < now || (endsAt !== null && endsAt <= startsAt))
            throw new BadRequestException(
              'Pause must start now or later and end after its start'
            );
          await competitionCommandRepository.pause(
            competitionId,
            startsAt,
            endsAt,
            request.reason ?? null,
            tx
          );
        }
        if (action === 'resume')
          await competitionCommandRepository.resume(competitionId, now, tx);
        const next = {
          ...changed,
          config_version: Number(record.config_version) + 1,
          updated_at: now
        };
        await competitionCommandRepository.saveCompetition(
          next,
          actor,
          config,
          tx
        );
        await competitionCommandRepository.recordLifecycle(
          next,
          record.lifecycle,
          actor,
          request.reason ?? null,
          tx
        );
        const eventTypes: Record<
          Exclude<CompetitionLifecycleAction, 'clone'>,
          string
        > = {
          publish: 'COMPETITION_PUBLISHED',
          end: 'COMPETITION_ENDED',
          cancel: 'COMPETITION_CANCELLED',
          archive: 'COMPETITION_ARCHIVED',
          pause: 'COMPETITION_PAUSED',
          resume: 'COMPETITION_RESUMED'
        };
        await this.event(next, eventTypes[action], request.idempotency_key, tx);
        return competitionService.getCompetition(waveId, competitionId, tx);
      },
      ctx
    );
  }

  private transition(
    record: CompetitionEntity,
    action: Exclude<CompetitionLifecycleAction, 'clone'>,
    now: number
  ): CompetitionEntity {
    if (action === 'publish') {
      if (record.lifecycle !== CompetitionLifecycle.DRAFT)
        competitionConflict('Only drafts can be published');
      return {
        ...record,
        lifecycle: CompetitionLifecycle.PUBLISHED,
        execution_mode: CompetitionExecutionMode.ACTIVE,
        published_at: now
      };
    }
    if (action === 'archive') {
      if (
        record.lifecycle === CompetitionLifecycle.PUBLISHED ||
        record.lifecycle === CompetitionLifecycle.ARCHIVED
      )
        competitionConflict('End or cancel a competition before archiving');
      return {
        ...record,
        lifecycle: CompetitionLifecycle.ARCHIVED,
        execution_mode: CompetitionExecutionMode.DISABLED,
        archived_at: now
      };
    }
    if (
      action === 'cancel' &&
      record.lifecycle === CompetitionLifecycle.DRAFT
    ) {
      return {
        ...record,
        lifecycle: CompetitionLifecycle.CANCELLED,
        execution_mode: CompetitionExecutionMode.DISABLED,
        cancelled_at: now
      };
    }
    if (record.lifecycle !== CompetitionLifecycle.PUBLISHED)
      competitionConflict('This action requires a published competition');
    if (action === 'end')
      return {
        ...record,
        lifecycle: CompetitionLifecycle.ENDED,
        execution_mode: CompetitionExecutionMode.DISABLED,
        ended_at: now
      };
    if (action === 'cancel')
      return {
        ...record,
        lifecycle: CompetitionLifecycle.CANCELLED,
        execution_mode: CompetitionExecutionMode.DISABLED,
        cancelled_at: now
      };
    return record;
  }

  private validatePublicationDates(
    config: ApiCompetitionDraftInput,
    now: number
  ): void {
    if (
      config.rules.decisions_strategy &&
      config.rules.decisions_strategy.first_decision_time <= now
    )
      throw new BadRequestException('The first decision must be in the future');
    for (const period of [config.participation.period, config.voting.period]) {
      if (
        period?.max !== null &&
        period?.max !== undefined &&
        period.max <= now
      )
        throw new BadRequestException(
          'Competition periods must not have ended before publication'
        );
    }
  }

  private async persistNew(
    record: CompetitionEntity,
    config: ApiCompetitionDraftInput,
    actor: string,
    ctx: RequestContext
  ): Promise<void> {
    await competitionCommandRepository.saveCompetition(
      record,
      actor,
      config,
      ctx
    );
    await competitionCommandRepository.replaceOutcomeDefinitions(
      record.id,
      config.outcomes,
      record.created_at,
      ctx
    );
    await competitionCommandRepository.recordLifecycle(
      record,
      null,
      actor,
      null,
      ctx
    );
    await this.event(record, 'COMPETITION_CREATED', record.id, ctx);
  }

  private async event(
    record: CompetitionEntity,
    eventType: string,
    key: string,
    ctx: RequestContext
  ): Promise<void> {
    await nativeCompetitionRuntimeRepository.enqueueEvent(
      {
        key,
        event_type: eventType,
        wave_id: record.wave_id,
        competition_id: record.id,
        occurred_at: record.updated_at,
        data: {
          config_version: record.config_version,
          lifecycle: record.lifecycle
        }
      },
      ctx
    );
  }
}

export const competitionLifecycleService = new CompetitionLifecycleService();
