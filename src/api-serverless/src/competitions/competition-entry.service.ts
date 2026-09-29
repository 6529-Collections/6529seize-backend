import { randomUUID } from 'node:crypto';
import { ApiCreateCompetitionEntryRequest } from '@/api/generated/models/ApiCreateCompetitionEntryRequest';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiDropGroupMention } from '@/api/generated/models/ApiDropGroupMention';
import { NewDropSchema } from '@/api/drops/drop.validator';
import { dropsMappers } from '@/api/drops/drops.mappers';
import { dropsService } from '@/api/drops/drops.api.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { sendIdentityPushNotificationsStrict } from '@/api/push-notifications/push-notifications.service';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { invalidateWaveUnreadCacheForWave } from '@/api/waves/wave-unread-cache';
import { competitionService } from '@/competitions/competition.service';
import { competitionCommandRepository } from '@/competitions/competition-command.repository';
import { competitionRepository } from '@/competitions/competition.repository';
import {
  Competition,
  CompetitionEntry
} from '@/competitions/competition.types';
import {
  CompetitionEntryContent,
  CompetitionEntryRepository,
  competitionEntryRepository
} from '@/competitions/competition-entry.repository';
import {
  assertCompetitionEntryContent,
  assertCompetitionEntryMedia,
  nativeEntryContentPermit
} from '@/competitions/competition-entry-content';
import { assertNativeEntryNomination } from '@/competitions/competition-entry-drop-hooks';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import {
  CreateOrUpdateDropUseCase,
  createOrUpdateDrop,
  PrePublicationPreparation,
  sanitizeDropStructuredFields
} from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { dropsDb } from '@/drops/drops.db';
import { DropEntity, DropType } from '@/entities/IDrop';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { RequestContext } from '@/request.context';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { prePublicationModerationService } from '@/content-moderation/pre-publication-moderation.service';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import { metricsRecorder } from '@/metrics/MetricsRecorder';
import { Logger } from '@/logging';
import { competitionDeliveryErrorCode } from '@/competitions/competition-delivery-diagnostics';
import {
  assertCompetitionGroup,
  assertCompetitionOpen,
  competitionActor,
  lockNativeCompetition,
  requireNativeWrites,
  visibleCompetitionWave
} from './competition-command-access';
import { verifyCompetitionSignature } from './competition-signature';

type EntryRequest = ApiCreateCompetitionEntryRequest;
type PreparedEntry = {
  model: CreateOrUpdateDropModel;
  preparation: PrePublicationPreparation;
  identity: Awaited<
    ReturnType<CreateOrUpdateDropUseCase['preResolveIdentityNomination']>
  >;
};

/** Read-only content of a dedicated competition submission. */
export function competitionEntryContentForApi(
  content: CompetitionEntryContent
): ApiCreateDropRequest {
  return {
    wave_id: content.wave_id,
    drop_type: ApiDropType.Participatory,
    title: content.title,
    reply_to: content.reply_to ?? undefined,
    hide_link_preview: content.hide_link_preview ?? false,
    parts: content.parts.map((part) => ({
      content: part.content,
      quoted_drop: part.quoted_drop,
      media: part.media.map((media) => ({
        url: media.url,
        mime_type: media.mime_type,
        media_upload_id: media.media_upload_id ?? null
      })),
      attachments: (part.attachments ?? []).map((item) => ({
        attachment_id: item.attachment_id
      }))
    })),
    metadata: content.metadata.map((item) => ({
      data_key: item.data_key,
      data_value: item.data_value
    })),
    referenced_nfts: content.referenced_nfts.map((item) => ({
      contract: item.contract,
      token: item.token,
      name: item.name
    })),
    mentioned_users: content.mentioned_users.map((item) => ({
      mentioned_profile_id: item.profile_id,
      handle_in_content: item.handle
    })),
    mentioned_waves: content.mentioned_waves.map((item) => ({
      wave_id: item.wave_id,
      wave_name_in_content: item.wave_name_in_content
    })),
    mentioned_groups:
      content.mentioned_groups as unknown as ApiDropGroupMention[],
    signature: null
  };
}

export class CompetitionEntryService {
  private readonly logger = Logger.get(this.constructor.name);
  public constructor(
    private readonly entries: CompetitionEntryRepository = competitionEntryRepository,
    private readonly dropWriter: CreateOrUpdateDropUseCase = createOrUpdateDrop
  ) {}

  public async create(
    waveId: string,
    competitionId: string,
    request: EntryRequest,
    ctx: RequestContext
  ): Promise<CompetitionEntry> {
    requireNativeWrites();
    const actor = competitionActor(ctx);
    await visibleCompetitionWave(waveId, ctx);
    if (!request.drop || 'drop_id' in request || 'drop_content_hash' in request)
      throw new BadRequestException(
        'Competition entries require a new dedicated submission; existing drops cannot be entered'
      );
    const command = { action: 'ENTRY_CREATE', waveId, competitionId, request };
    const saved =
      await competitionCommandRepository.findSavedCommand<CompetitionEntry>(
        actor,
        request.idempotency_key,
        command,
        ctx
      );
    if (saved) return saved;
    const prepared = await this.prepare(waveId, request, actor, {
      ...ctx,
      moderationRequestId: request.idempotency_key
    });
    let pendingPushIds: number[] = [];
    let createdDropId: string | null = null;
    const result = await competitionCommandRepository.command(
      actor,
      request.idempotency_key,
      command,
      async (tx) => {
        const created = await this.createUnderLock(
          waveId,
          competitionId,
          request,
          actor,
          prepared,
          tx
        );
        pendingPushIds = created.pendingPushIds;
        createdDropId = created.createdDropId;
        return created.entry;
      },
      ctx
    );
    if (createdDropId)
      await this.afterCreate(createdDropId, waveId, pendingPushIds, ctx);
    return result;
  }

  private async createUnderLock(
    waveId: string,
    competitionId: string,
    request: EntryRequest,
    actor: string,
    prepared: PreparedEntry,
    tx: RequestContext
  ): Promise<{
    entry: CompetitionEntry;
    pendingPushIds: number[];
    createdDropId: string | null;
  }> {
    let pendingPushIds: number[] = [];
    let createdDropId: string | null = null;
    const { competition } = await lockNativeCompetition(
      waveId,
      competitionId,
      request.config_version,
      tx
    );
    const { groups } = await visibleCompetitionWave(waveId, tx);
    assertCompetitionGroup(
      competition.participation.group_id,
      groups,
      ProfileProxyActionType.CREATE_DROP_TO_WAVE,
      tx
    );
    assertCompetitionOpen(competition, Date.now(), 'submit');
    const limit = competition.participation.max_entries_per_participant;
    if (
      limit !== null &&
      (await this.entries.countActive(competitionId, actor, tx)) >= limit
    )
      throw new ForbiddenException('Competition entry limit reached');
    const model = prepared.model;
    await moderationReviewDb.lockProfile(actor, tx);
    await prePublicationModerationService.assertPostingAllowed(actor, tx);
    assertCompetitionEntryContent(competition, model);
    await assertCompetitionEntryMedia(competition, model);
    await this.dropWriter.normalizeNativeEntryIdentity(
      model,
      competition,
      prepared.identity,
      tx
    );
    await assertNativeEntryNomination(competition, model, null, tx);
    await verifyCompetitionSignature(
      {
        action: 'ENTRY_CREATE',
        wave_id: waveId,
        competition_id: competitionId,
        competition_entry_id: null,
        drop_id: null,
        config_version: request.config_version,
        payload: { drop: request.drop, drop_id: null }
      },
      request.signature,
      competition.participation.signature_required,
      Date.now(),
      tx
    );
    const created = await this.dropWriter.execute(model, false, {
      ...tx,
      connection: tx.connection!,
      prePublication: prepared.preparation,
      preResolvedIdentityNomination: prepared.identity,
      nativeEntryContent: nativeEntryContentPermit({
        competitionId,
        waveId,
        authorId: actor,
        dropId: null,
        connection: tx.connection!
      })
    });
    const dropId = created.drop_id;
    if (!created.replayed) {
      pendingPushIds = created.pending_push_notification_ids;
      createdDropId = dropId;
    }
    await competitionCommandRepository.lockDrop(dropId, tx);
    await this.entries.assertDropAvailable(dropId, competitionId, tx);
    const drop = await dropsDb.findDropById(dropId, tx.connection);
    if (
      !drop ||
      drop.wave_id !== waveId ||
      drop.author_id !== actor ||
      drop.drop_type !== DropType.COMPETITION
    )
      throw new BadRequestException(
        'Entry content must be your dedicated competition drop in this wave'
      );
    const entry: CompetitionEntry = {
      id: randomUUID(),
      wave_id: waveId,
      competition_id: competitionId,
      drop_id: dropId,
      submitter_id: actor,
      status: CompetitionEntryStatus.ACTIVE,
      config_version: request.config_version,
      submitted_at: Date.now(),
      rank: null,
      won_at: null,
      decision_id: null
    };
    await this.entries.insert(entry, tx);
    await metricsRecorder.recordNativeCompetitionSubmission(
      { competitionId },
      tx
    );
    const content = await this.entries.loadDropContent(drop, tx);
    const snapshot = { ...content, metadata: model.metadata };
    await this.entries.saveContent(
      entry,
      snapshot,
      actor,
      request.signature
        ? {
            ...request.signature,
            payload: { drop: request.drop, drop_id: null },
            content: request.drop
          }
        : undefined,
      tx
    );
    await nativeCompetitionRuntimeService.refreshCompetition(
      competitionId,
      Date.now(),
      tx
    );
    await this.event(
      entry,
      'COMPETITION_ENTRY_CREATED',
      request.idempotency_key,
      actor,
      null,
      tx,
      pendingPushIds
    );
    return { entry, pendingPushIds, createdDropId };
  }

  private async prepare(
    waveId: string,
    request: EntryRequest,
    actor: string,
    ctx: RequestContext
  ): Promise<PreparedEntry> {
    const model = this.newModel(waveId, request.drop, actor, ctx);
    const identity = await this.dropWriter.preResolveIdentityNomination(model, {
      timer: ctx.timer
    });
    const preparation = await this.dropWriter.preparePrePublication(model, ctx);
    return { model, identity, preparation };
  }

  private newModel(
    waveId: string,
    input: ApiCreateDropRequest,
    actor: string,
    ctx: RequestContext
  ): CreateOrUpdateDropModel {
    if (
      input.wave_id !== waveId ||
      (input.drop_type !== undefined &&
        ![ApiDropType.Chat, ApiDropType.Participatory].includes(
          input.drop_type
        ))
    )
      throw new BadRequestException(
        'Entry content must be a new competition submission in this wave'
      );
    if (
      input.signature ||
      input.signature_message ||
      input.signer_address ||
      input.is_safe_signature ||
      input.poll
    )
      throw new BadRequestException(
        'Use the competition signature; entry content cannot include a legacy signature or poll'
      );
    const drop = getValidatedByJoiOrThrow(input, NewDropSchema);
    if (
      drop.parts.some(
        (part) =>
          !part.content?.trim() &&
          part.media.length === 0 &&
          !part.attachments?.length
      )
    )
      throw new BadRequestException(
        'Each drop part must contain content, media or attachments'
      );
    const model = dropsMappers.createDropApiToUseCaseModel({
      request: {
        ...drop,
        drop_type: ApiDropType.Participatory,
        signature: null
      },
      authorId: actor,
      proxyId: ctx.authenticationContext?.isAuthenticatedAsProxy()
        ? ctx.authenticationContext.authenticatedProfileId!
        : undefined
    });
    return sanitizeDropStructuredFields({
      ...model,
      hide_link_preview: drop.hide_link_preview,
      parts: model.parts.map((part, index) => ({
        ...part,
        media: part.media.map((media, mediaIndex) => ({
          ...media,
          media_upload_id: drop.parts[index].media[mediaIndex].media_upload_id
        }))
      }))
    });
  }

  public async getDropContext(
    waveId: string,
    dropId: string,
    ctx: RequestContext
  ) {
    await competitionService.getHub(waveId, ctx);
    const drop = await dropsDb.findDropById(dropId, ctx.connection);
    if (!drop || drop.wave_id !== waveId)
      throw new NotFoundException('Drop not found');
    await this.assertContentVisible(drop, ctx);
    const memberships = await this.entries.findDropEntries(dropId, ctx);
    if (!memberships.length && drop.drop_type !== DropType.COMPETITION)
      return { competition: null, entry: null };
    if (memberships.length !== 1 || memberships[0].wave_id !== waveId)
      throw new NotFoundException('Competition entry not found');
    const membership = memberships[0];
    const entry = await competitionService.getEntry(
      waveId,
      membership.competition_id,
      membership.id,
      ctx
    );
    const competition = await competitionService.getCompetition(
      waveId,
      membership.competition_id,
      ctx
    );
    return { competition, entry };
  }

  public async getContent(
    waveId: string,
    competitionId: string,
    entryId: string,
    ctx: RequestContext
  ): Promise<ApiCreateDropRequest> {
    const entry = await competitionService.getEntry(
      waveId,
      competitionId,
      entryId,
      ctx
    );
    const drop = await dropsDb.findDropById(entry.drop_id, ctx.connection);
    if (!drop) throw new NotFoundException('Entry content has been deleted');
    await this.assertContentVisible(drop, ctx);
    const content =
      (await this.entries.getContent(entry.id, ctx)) ??
      (await this.entries.loadDropContent(drop, ctx));
    if (await this.entries.isContentSuppressed(drop.id, content, ctx))
      throw new NotFoundException('Entry content is unavailable');
    return competitionEntryContentForApi(content);
  }

  private async assertContentVisible(
    drop: DropEntity,
    ctx: RequestContext
  ): Promise<void> {
    const viewer = ctx.authenticationContext?.getActingAsId() ?? null;
    const presentations = await contentModerationDb.getPresentations(
      [drop],
      viewer,
      ctx.connection
    );
    const state = presentations[drop.id];
    if (
      state &&
      (!state.moderation.can_view ||
        state.viewer.author_blocked ||
        state.viewer.drop_hidden)
    )
      throw new NotFoundException('Entry content is unavailable');
  }

  private async event(
    entry: CompetitionEntry,
    eventType: string,
    key: string,
    actor: string,
    reason: string | null,
    ctx: RequestContext,
    pendingPushIds?: number[]
  ): Promise<void> {
    await nativeCompetitionRuntimeRepository.enqueueEvent(
      {
        key: `entry:${key}`,
        event_type: eventType,
        wave_id: entry.wave_id,
        competition_id: entry.competition_id,
        competition_entry_id: entry.id,
        drop_id: entry.drop_id,
        occurred_at: Date.now(),
        data: {
          submitter_id: entry.submitter_id,
          actor_id: actor,
          status: entry.status,
          reason,
          ...(pendingPushIds?.length
            ? { pending_push_notification_ids: pendingPushIds }
            : {})
        }
      },
      ctx
    );
  }

  private async afterCreate(
    dropId: string,
    waveId: string,
    pendingPushIds: number[],
    ctx: RequestContext
  ): Promise<void> {
    const effects = [
      {
        stage: 'unread_cache',
        run: () => invalidateWaveUnreadCacheForWave(waveId)
      },
      {
        stage: 'push_handoff',
        run: () => sendIdentityPushNotificationsStrict(pendingPushIds)
      },
      {
        stage: 'chat_socket',
        run: async () =>
          wsListenersNotifier.notifyAboutDropUpdate(
            await dropsService.findDropByIdOrThrow({ dropId }, ctx),
            ctx
          )
      }
    ];
    const results = await Promise.allSettled(
      effects.map((effect) => effect.run())
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected')
        this.logger.warn(
          'Native entry committed; shared chat notification delivery failed',
          {
            drop_id: dropId,
            stage: effects[index].stage,
            error_code: competitionDeliveryErrorCode(result.reason)
          }
        );
    });
  }
}

export const competitionEntryService = new CompetitionEntryService();
