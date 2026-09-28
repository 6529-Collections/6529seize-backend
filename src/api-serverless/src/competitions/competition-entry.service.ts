import { randomUUID } from 'node:crypto';
import { ApiCreateCompetitionEntryRequest } from '@/api/generated/models/ApiCreateCompetitionEntryRequest';
import { ApiCompetitionActionRequest } from '@/api/generated/models/ApiCompetitionActionRequest';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiDropGroupMention } from '@/api/generated/models/ApiDropGroupMention';
import { NewDropSchema } from '@/api/drops/drop.validator';
import { dropsMappers } from '@/api/drops/drops.mappers';
import { dropsService } from '@/api/drops/drops.api.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { invalidateWaveUnreadCacheForWave } from '@/api/waves/wave-unread-cache';
import { competitionService } from '@/competitions/competition.service';
import {
  competitionCommandRepository,
  competitionConflict
} from '@/competitions/competition-command.repository';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionPayloadHash } from '@/competitions/competition-command-identity';
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
import {
  CompetitionEntryStatus,
  CompetitionLifecycle
} from '@/entities/ICompetition';
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
import {
  administerCompetitionWave,
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
  preparation?: PrePublicationPreparation;
  identity: Awaited<
    ReturnType<CreateOrUpdateDropUseCase['preResolveIdentityNomination']>
  >;
};

/** This exact wire object is also the signed existing-drop content hash input. */
export function competitionEntryContentForApi(
  content: CompetitionEntryContent
): ApiCreateDropRequest {
  return {
    wave_id: content.wave_id,
    drop_type: ApiDropType.Chat,
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

function signingPayload(request: EntryRequest) {
  return {
    drop: request.drop ?? null,
    drop_id: request.drop_id ?? null,
    ...(request.drop_content_hash
      ? { drop_content_hash: request.drop_content_hash }
      : {})
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
    if (Boolean(request.drop) === Boolean(request.drop_id))
      throw new BadRequestException(
        'Provide either new drop content or an existing drop_id'
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
    const model = request.drop_id
      ? await this.existingModel(waveId, request.drop_id, actor, tx)
      : prepared.model;
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
    if (request.drop_id)
      await this.assertSignedContent(request, competition, tx);
    await verifyCompetitionSignature(
      {
        action: 'ENTRY_CREATE',
        wave_id: waveId,
        competition_id: competitionId,
        competition_entry_id: null,
        drop_id: request.drop_id ?? null,
        config_version: request.config_version,
        payload: signingPayload(request)
      },
      request.signature,
      competition.participation.signature_required,
      Date.now(),
      tx
    );
    let dropId = request.drop_id;
    if (!dropId) {
      if (!prepared.preparation)
        throw new Error('Entry moderation preparation is missing');
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
      dropId = created.drop_id;
      if (!created.replayed) {
        pendingPushIds = created.pending_push_notification_ids;
        createdDropId = dropId;
      }
    }
    await competitionCommandRepository.lockDrop(dropId, tx);
    await this.entries.assertDropAvailable(dropId, competitionId, tx);
    const drop = await dropsDb.findDropById(dropId, tx.connection);
    if (
      !drop ||
      drop.wave_id !== waveId ||
      drop.author_id !== actor ||
      drop.drop_type !== DropType.CHAT
    )
      throw new BadRequestException(
        'Entry content must be your chat drop in this wave'
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
    // Existing identity nominations are normalized in the entry snapshot only;
    // attaching content must not silently rewrite its shared chat metadata.
    const snapshot = { ...content, metadata: model.metadata };
    await this.entries.saveContent(
      entry,
      snapshot,
      actor,
      request.signature
        ? {
            ...request.signature,
            payload: signingPayload(request),
            content: request.drop ?? competitionEntryContentForApi(content)
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
      tx
    );
    return { entry, pendingPushIds, createdDropId };
  }

  private async prepare(
    waveId: string,
    request: EntryRequest,
    actor: string,
    ctx: RequestContext
  ): Promise<PreparedEntry> {
    const model = request.drop
      ? this.newModel(waveId, request.drop, actor, ctx)
      : await this.existingModel(waveId, request.drop_id!, actor, ctx, false);
    const identity = await this.dropWriter.preResolveIdentityNomination(
      { ...model, drop_type: DropType.PARTICIPATORY },
      { timer: ctx.timer }
    );
    const preparation = request.drop
      ? await this.dropWriter.preparePrePublication(model, ctx)
      : undefined;
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
      (input.drop_type !== undefined && input.drop_type !== ApiDropType.Chat)
    )
      throw new BadRequestException(
        'Native entry content must be a chat drop in this wave'
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
      request: { ...drop, signature: null },
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

  private async existingModel(
    waveId: string,
    dropId: string,
    actor: string,
    ctx: RequestContext,
    lock = true
  ): Promise<CreateOrUpdateDropModel> {
    if (lock) await competitionCommandRepository.lockDrop(dropId, ctx);
    const drop = await dropsDb.findDropById(dropId, ctx.connection);
    if (!drop || drop.wave_id !== waveId)
      throw new NotFoundException('Drop not found');
    if (drop.author_id !== actor || drop.drop_type !== DropType.CHAT)
      throw new ForbiddenException(
        'Only your own chat drop can become a native entry'
      );
    await this.assertContentVisible(drop, ctx);
    const content = await this.entries.loadDropContent(drop, ctx);
    return sanitizeDropStructuredFields({
      ...content,
      drop_id: dropId,
      author_identity: actor,
      author_id: actor,
      signature: null,
      drop_type: DropType.CHAT,
      is_additional_action_promised: null
    });
  }

  private async assertSignedContent(
    request: EntryRequest,
    competition: Competition,
    ctx: RequestContext
  ): Promise<void> {
    if (!request.signature && !competition.participation.signature_required)
      return;
    if (!request.drop_content_hash)
      throw new BadRequestException(
        'Signed existing entries require drop_content_hash'
      );
    const drop = await dropsDb.findDropById(request.drop_id!, ctx.connection);
    if (!drop) throw new NotFoundException('Drop not found');
    const content = competitionEntryContentForApi(
      await this.entries.loadDropContent(drop, ctx)
    );
    if (competitionPayloadHash(content) !== request.drop_content_hash)
      competitionConflict(
        'Drop content changed. Reload and sign its current content'
      );
  }

  public async action(
    waveId: string,
    competitionId: string,
    entryId: string,
    action: 'withdraw' | 'disqualify',
    request: ApiCompetitionActionRequest,
    ctx: RequestContext
  ): Promise<CompetitionEntry> {
    requireNativeWrites();
    const actor = competitionActor(ctx);
    await visibleCompetitionWave(waveId, ctx);
    return competitionCommandRepository.command(
      actor,
      request.idempotency_key,
      { action, waveId, competitionId, entryId, request },
      async (tx) => {
        const { competition } = await lockNativeCompetition(
          waveId,
          competitionId,
          request.config_version,
          tx
        );
        const entry = await competitionRepository.findNativeEntry(
          competitionId,
          entryId,
          tx
        );
        if (!entry) throw new NotFoundException('Entry not found');
        if (
          competition.lifecycle !== CompetitionLifecycle.PUBLISHED ||
          entry.status !== CompetitionEntryStatus.ACTIVE
        )
          competitionConflict('Entry is read-only');
        if (action === 'disqualify')
          await administerCompetitionWave(waveId, tx);
        else if (
          entry.submitter_id !== actor ||
          !ctx.authenticationContext?.hasRightsTo(
            ProfileProxyActionType.CREATE_DROP_TO_WAVE
          )
        )
          throw new ForbiddenException(
            'Only the submitter can withdraw an entry'
          );
        await competitionCommandRepository.lockDrop(entry.drop_id, tx);
        const status =
          action === 'withdraw'
            ? CompetitionEntryStatus.WITHDRAWN
            : CompetitionEntryStatus.DISQUALIFIED;
        await this.entries.setStatus(entryId, status, Date.now(), tx);
        await nativeCompetitionRuntimeService.refreshCompetition(
          competitionId,
          Date.now(),
          tx
        );
        const updated = { ...entry, status };
        await this.event(
          updated,
          action === 'withdraw'
            ? 'COMPETITION_ENTRY_WITHDRAWN'
            : 'COMPETITION_ENTRY_DISQUALIFIED',
          request.idempotency_key,
          actor,
          request.reason ?? null,
          tx
        );
        return updated;
      },
      ctx
    );
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

  public async getCandidateContent(
    waveId: string,
    competitionId: string,
    dropId: string,
    ctx: RequestContext
  ): Promise<ApiCreateDropRequest> {
    const actor = competitionActor(ctx);
    await competitionService.getCompetition(waveId, competitionId, ctx);
    await this.existingModel(waveId, dropId, actor, ctx, false);
    const drop = await dropsDb.findDropById(dropId, ctx.connection);
    if (!drop) throw new NotFoundException('Drop not found');
    return competitionEntryContentForApi(
      await this.entries.loadDropContent(drop, ctx)
    );
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
    ctx: RequestContext
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
          reason
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
    try {
      await invalidateWaveUnreadCacheForWave(waveId);
      await sendIdentityPushNotifications(pendingPushIds);
      await wsListenersNotifier.notifyAboutDropUpdate(
        await dropsService.findDropByIdOrThrow({ dropId }, ctx),
        ctx
      );
    } catch {
      this.logger.warn(
        'Native entry committed; shared chat notification delivery failed',
        { drop_id: dropId }
      );
    }
  }
}

export const competitionEntryService = new CompetitionEntryService();
