import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { DropsApiService, dropsService } from './drops.api.service';
import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { ApiDrop } from '../generated/models/ApiDrop';
import { AuthenticationContext } from '../../../auth-context';
import { Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { ApiUpdateDropRequest } from '../generated/models/ApiUpdateDropRequest';
import {
  createOrUpdateDrop,
  CreateOrUpdateDropUseCase,
  PrePublicationPreparation
} from '../../../drops/create-or-update-drop.use-case';
import {
  CreateOrUpdateDropModel,
  DropPartIdentifierModel
} from '../../../drops/create-or-update-drop.model';
import { ConnectionWrapper } from '../../../sql-executor';
import { dropsMappers, DropsMappers } from './drops.mappers';
import {
  deleteDrop,
  DeleteDropUseCase
} from '../../../drops/delete-drop.use-case';
import { ApiDropType } from '../generated/models/ApiDropType';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '../ws/ws-listeners-notifier';
import { enums } from '../../../enums';
import { dropNftLinksDb, DropNftLinksDb } from '@/drops/drop-nft-links.db';
import {
  nftLinkResolvingService,
  NftLinkResolvingService
} from '@/nft-links/nft-link-resolving.service';
import { Logger } from '@/logging';
import { DbPoolName } from '@/db-query.options';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import {
  CreateDropPollRequest,
  dropPollsApiService,
  DropPollsApiService
} from '@/api/drops/drop-polls.api.service';
import { ApiCreateDropPollRequest } from '@/api/generated/models/ApiCreateDropPollRequest';
import { ApiDeleteMyWaveChatHistoryResponse } from '@/api/generated/models/ApiDeleteMyWaveChatHistoryResponse';
import { invalidateWaveUnreadCacheForWave } from '@/api/waves/wave-unread-cache';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import {
  waveDropMetricsRefreshService,
  WaveDropMetricsDirtyRefreshReason
} from '@/drops/wave-drop-metrics-refresh.service';
import {
  wavesApiDb as defaultWavesApiDb,
  WavesApiDb
} from '@/api/waves/waves.api.db';
import {
  helpBotDailyActivityCreditQueueService,
  HelpBotDailyActivityCreditQueueService
} from '@/help-bot/help-bot-daily-activity-credit-queue.service';

function normalizeCreateDropPollRequest(
  poll: ApiCreateDropPollRequest | null | undefined
): CreateDropPollRequest | null | undefined {
  if (!poll) {
    return undefined;
  }
  return {
    ...poll,
    options: Array.from(poll.options)
  };
}

export class DropCreationApiService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly dropsService: DropsApiService,
    private readonly dropsDb: DropsDb,
    private readonly dropsMappers: DropsMappers,
    private readonly createOrUpdateDrop: CreateOrUpdateDropUseCase,
    private readonly deleteDrop: DeleteDropUseCase,
    private readonly wsListenersNotifier: WsListenersNotifier,
    private readonly dropNftLinksDb: DropNftLinksDb,
    private readonly nftLinkResolvingService: NftLinkResolvingService,
    private readonly dropPollsApiService: DropPollsApiService,
    private readonly wavesApiDb: WavesApiDb = defaultWavesApiDb,
    private readonly dailyActivityCreditQueueService: HelpBotDailyActivityCreditQueueService = helpBotDailyActivityCreditQueueService
  ) {}

  public async createDrop(
    {
      createDropRequest,
      authorId,
      representativeId,
      hideLinkPreview,
      requestDailyActivityCredit = false
    }: {
      createDropRequest: ApiCreateDropRequest;
      authorId: string;
      representativeId: string;
      hideLinkPreview?: boolean;
      requestDailyActivityCredit?: boolean;
    },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const proxyId =
      authorId === representativeId ? undefined : representativeId;
    const model = this.dropsMappers.createDropApiToUseCaseModel({
      request: createDropRequest,
      authorId,
      proxyId
    });
    const createModel: typeof model =
      hideLinkPreview === undefined
        ? model
        : {
            ...model,
            hide_link_preview: hideLinkPreview
          };
    const preResolvedIdentityNomination =
      await this.createOrUpdateDrop.preResolveIdentityNomination(createModel, {
        timer: ctx.timer
      });
    const prePublication = await this.createOrUpdateDrop.preparePrePublication(
      createModel,
      ctx
    );
    const {
      drop,
      pendingPushNotificationIds,
      dmUnreadRecipientIds,
      dailyActivityCreditRequestEnqueued
    } = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        return await this.createDropWithGivenConnection(
          {
            model: createModel,
            authorId,
            preResolvedIdentityNomination,
            prePublication,
            requestDailyActivityCredit
          },
          normalizeCreateDropPollRequest(createDropRequest.poll),
          { timer: ctx.timer!, connection }
        );
      }
    );
    if (dailyActivityCreditRequestEnqueued) {
      await this.dailyActivityCreditQueueService.sendWakeupBestEffort(ctx);
    }
    await waveScoreService.requestWaveScoreRefreshBestEffort(
      [createModel.wave_id],
      WaveScoreDirtyRefreshReason.DROP_CHANGED,
      ctx
    );
    await invalidateWaveUnreadCacheForWave(createModel.wave_id);
    await this.sendPendingPushNotifications({
      dropId: drop.id,
      pendingPushNotificationIds
    });
    void this.ensureNftLinkTrackingForDrop(drop.id, ctx);
    await this.wsListenersNotifier.notifyAboutDropUpdate(drop, ctx);
    await this.notifyDmUnreadStateChanged({
      waveId: createModel.wave_id,
      recipientIds: dmUnreadRecipientIds,
      ctx
    });
    return drop;
  }

  private async createDropWithGivenConnection(
    {
      model,
      authorId,
      preResolvedIdentityNomination,
      prePublication,
      requestDailyActivityCredit
    }: {
      model: CreateOrUpdateDropModel;
      authorId: string;
      preResolvedIdentityNomination: Awaited<
        ReturnType<CreateOrUpdateDropUseCase['preResolveIdentityNomination']>
      > | null;
      prePublication: PrePublicationPreparation;
      requestDailyActivityCredit: boolean;
    },
    poll: CreateDropPollRequest | null | undefined,
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ): Promise<{
    drop: ApiDrop;
    pendingPushNotificationIds: number[];
    dmUnreadRecipientIds: string[];
    dailyActivityCreditRequestEnqueued: boolean;
  }> {
    const { drop_id, pending_push_notification_ids, dm_unread_recipient_ids } =
      await this.createOrUpdateDrop.execute(model, false, {
        timer,
        connection,
        preResolvedIdentityNomination,
        prePublication
      });
    await this.dropPollsApiService.createPollForDrop(
      {
        poll,
        dropId: drop_id,
        waveId: model.wave_id,
        authorId,
        dropType: model.drop_type
      },
      {
        timer,
        connection,
        authenticationContext: AuthenticationContext.fromProfileId(authorId)
      }
    );
    const dailyActivityCreditRequestEnqueued = requestDailyActivityCredit
      ? await this.dailyActivityCreditQueueService.enqueueRequest(
          { profileId: authorId },
          { timer, connection }
        )
      : false;
    const drop = await this.dropsService.findDropByIdOrThrow(
      {
        dropId: drop_id,
        skipEligibilityCheck: true
      },
      {
        connection,
        authenticationContext: AuthenticationContext.fromProfileId(authorId),
        timer
      }
    );
    return {
      drop,
      pendingPushNotificationIds: pending_push_notification_ids,
      dmUnreadRecipientIds: dm_unread_recipient_ids ?? [],
      dailyActivityCreditRequestEnqueued
    };
  }

  private async notifyDmUnreadStateChanged({
    waveId,
    recipientIds,
    ctx
  }: {
    waveId: string;
    recipientIds: string[];
    ctx: RequestContext;
  }): Promise<void> {
    if (!recipientIds.length) {
      return;
    }
    try {
      const recipients =
        await this.wsListenersNotifier.findConnectedNotificationRecipients(
          recipientIds
        );
      const connectedRecipientIds = Array.from(
        new Set(recipients.map((recipient) => recipient.identityId))
      );
      if (!connectedRecipientIds.length) {
        return;
      }
      const states =
        await this.wavesApiDb.findDmUnreadConversationStatesForIdentities(
          { identityIds: connectedRecipientIds, waveIds: [waveId] },
          ctx,
          DbPoolName.WRITE
        );
      await this.wsListenersNotifier.notifyAboutDmUnreadStateChanged(
        states,
        recipients
      );
    } catch (error) {
      this.logger.error(
        `Failed to broadcast DM unread state for wave ${waveId}`,
        error
      );
    }
  }

  public async deleteDropById(
    { id }: { id: string },
    { timer, authenticationContext }: RequestContext
  ) {
    timer?.start('dropCreationApiService->deleteDrop');
    const authenticatedProfileId = authenticationContext?.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (authenticationContext?.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxy is not allowed to delete drops`);
    }
    const deleteResponse = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        return await this.deleteDrop.execute(
          {
            drop_id: id,
            deleter_identity: authenticatedProfileId,
            deleter_id: authenticatedProfileId,
            deletion_purpose: 'DELETE'
          },
          { timer: timer!, connection }
        );
      }
    );
    if (deleteResponse) {
      await waveDropMetricsRefreshService.requestWaveDropMetricsRefreshBestEffort(
        [deleteResponse.wave_id],
        WaveDropMetricsDirtyRefreshReason.DROP_DELETED,
        {
          timer,
          authenticationContext
        }
      );
      await waveScoreService.requestWaveScoreRefreshBestEffort(
        [deleteResponse.wave_id],
        WaveScoreDirtyRefreshReason.DROP_DELETED,
        {
          timer,
          authenticationContext
        }
      );
      await invalidateWaveUnreadCacheForWave(deleteResponse.wave_id);
      await this.wsListenersNotifier.notifyAboutDropDelete(
        {
          drop_id: deleteResponse.id,
          drop_serial: deleteResponse.serial_no,
          wave_id: deleteResponse.wave_id
        },
        deleteResponse.visibility_group_id,
        { timer, authenticationContext }
      );
      await this.notifyDmUnreadStateChanged({
        waveId: deleteResponse.wave_id,
        recipientIds: deleteResponse.dm_unread_recipient_ids,
        ctx: { timer, authenticationContext }
      });
    }
    timer?.stop('dropCreationApiService->deleteDrop');
  }

  public async deleteMyWaveChatHistory(
    { waveId }: { readonly waveId: string },
    ctx: RequestContext
  ): Promise<ApiDeleteMyWaveChatHistoryResponse> {
    const timerName = `${this.constructor.name}->deleteMyWaveChatHistory`;
    ctx.timer?.start(timerName);
    try {
      const authenticationContext = ctx.authenticationContext;
      const authenticatedProfileId = authenticationContext?.getActingAsId();
      if (!authenticationContext || !authenticatedProfileId) {
        throw new ForbiddenException(`Please create a profile first`);
      }
      if (authenticationContext.isAuthenticatedAsProxy()) {
        throw new ForbiddenException(
          `Proxy is not allowed to delete chat history`
        );
      }

      const { deleteResponses, preservedPinnedDropId } =
        await this.dropsDb.executeNativeQueriesInTransaction(
          async (connection) => {
            const transactionContext: RequestContext = {
              ...ctx,
              connection
            };
            const wave = await this.wavesApiDb.findWaveByIdForUpdate(
              waveId,
              transactionContext
            );
            if (!wave) {
              throw new NotFoundException(`Wave ${waveId} not found`);
            }

            const chatDrops =
              await this.dropsDb.findWaveChatDropsByAuthorForUpdate(
                {
                  waveId,
                  authorId: authenticatedProfileId
                },
                transactionContext
              );
            const pinnedDrop = chatDrops.find(
              (drop) => drop.id === wave.description_drop_id
            );
            const responses: Array<{
              id: string;
              visibility_group_id: string | null;
              serial_no: number;
              wave_id: string;
              dm_unread_recipient_ids: string[];
            }> = [];

            for (const drop of chatDrops) {
              if (drop.id === pinnedDrop?.id) {
                continue;
              }
              const deleteResponse = await this.deleteDrop.execute(
                {
                  drop_id: drop.id,
                  deleter_identity: authenticatedProfileId,
                  deleter_id: authenticatedProfileId,
                  deletion_purpose: 'DELETE'
                },
                { timer: ctx.timer, connection }
              );
              if (deleteResponse) {
                responses.push(deleteResponse);
              }
            }

            return {
              deleteResponses: responses,
              preservedPinnedDropId: pinnedDrop?.id ?? null
            };
          }
        );

      if (deleteResponses.length) {
        const postCommitEffects = [
          {
            name: 'wave drop metrics refresh',
            run: () =>
              waveDropMetricsRefreshService.requestWaveDropMetricsRefreshBestEffort(
                [waveId],
                WaveDropMetricsDirtyRefreshReason.DROP_DELETED,
                ctx
              )
          },
          {
            name: 'wave score refresh',
            run: () =>
              waveScoreService.requestWaveScoreRefreshBestEffort(
                [waveId],
                WaveScoreDirtyRefreshReason.DROP_DELETED,
                ctx
              )
          },
          {
            name: 'wave unread cache invalidation',
            run: () => invalidateWaveUnreadCacheForWave(waveId)
          },
          {
            name: 'drop deletion websocket broadcast',
            run: () =>
              this.wsListenersNotifier.notifyAboutDropDeletes(
                deleteResponses.map((response) => ({
                  drop_id: response.id,
                  drop_serial: response.serial_no,
                  wave_id: response.wave_id
                })),
                deleteResponses[0]!.visibility_group_id,
                ctx
              )
          },
          {
            name: 'direct-message unread notification',
            run: () =>
              this.notifyDmUnreadStateChanged({
                waveId,
                recipientIds: Array.from(
                  new Set(
                    deleteResponses.flatMap(
                      (response) => response.dm_unread_recipient_ids
                    )
                  )
                ),
                ctx
              })
          }
        ] as const;
        const results = await Promise.allSettled(
          postCommitEffects.map((effect) => effect.run())
        );
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            this.logger.error(
              `Wave chat history deletion ${postCommitEffects[index]!.name} failed after commit for wave ${waveId}`,
              result.reason
            );
          }
        });
      }

      return {
        deleted_drop_ids: deleteResponses.map((response) => response.id),
        preserved_pinned_drop_id: preservedPinnedDropId
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async toggleHideLinkPreview(
    { dropId, hideLinkPreview }: { dropId: string; hideLinkPreview?: boolean },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    ctx.timer?.start('dropCreationApiService->toggleHideLinkPreview');
    const authenticatedProfileId = ctx.authenticationContext?.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (ctx.authenticationContext?.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(
        `Proxy is not allowed to toggle hide link preview`
      );
    }
    const drop = await this.dropsDb.findDropById(dropId);
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    if (drop.author_id !== authenticatedProfileId) {
      throw new ForbiddenException(
        `Only the author can toggle hide link preview`
      );
    }
    const newValue = hideLinkPreview ?? !drop.hide_link_preview;
    const changed = await this.dropsDb.updateHideLinkPreview(
      { drop_id: dropId, hide_link_preview: newValue },
      ctx
    );
    const apiDrop = await this.dropsService.findDropByIdOrThrow(
      { dropId, skipEligibilityCheck: true },
      ctx
    );
    if (changed) {
      await this.wsListenersNotifier.notifyAboutDropUpdate(apiDrop, ctx);
    }
    ctx.timer?.stop('dropCreationApiService->toggleHideLinkPreview');
    return apiDrop;
  }

  async updateDrop(
    {
      dropId,
      request,
      authorId,
      representativeId
    }: {
      dropId: string;
      request: ApiUpdateDropRequest;
      authorId: string;
      representativeId: string;
    },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const drop = await this.dropsDb.findDropById(dropId);
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    if (drop.author_id !== authorId) {
      throw new ForbiddenException(`Only the author can update drop ${dropId}`);
    }
    const waveId = drop.wave_id;
    const replyTo: DropPartIdentifierModel | null =
      drop.reply_to_drop_id !== null
        ? {
            drop_id: drop.reply_to_drop_id,
            drop_part_id: drop.reply_to_part_id!
          }
        : null;
    const proxyId =
      authorId === representativeId ? undefined : representativeId;
    const dropType = drop.drop_type
      ? enums.resolveOrThrow(ApiDropType, drop.drop_type)
      : ApiDropType.Chat;
    const model: CreateOrUpdateDropModel =
      this.dropsMappers.updateDropApiToUseCaseModel({
        request: {
          ...request,
          drop_type: dropType,
          is_additional_action_promised: drop.is_additional_action_promised
        },
        authorId,
        proxyId,
        replyTo,
        waveId,
        dropId
      });
    const preResolvedIdentityNomination =
      await this.createOrUpdateDrop.preResolveIdentityNomination(model, {
        timer: ctx.timer
      });
    const prePublication = await this.createOrUpdateDrop.preparePrePublication(
      model,
      ctx
    );
    const { apiDrop, pendingPushNotificationIds } =
      await this.dropsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const { drop_id, pending_push_notification_ids } =
            await this.createOrUpdateDrop.execute(model, false, {
              timer: ctx.timer!,
              connection,
              preResolvedIdentityNomination,
              prePublication
            });
          const apiDrop = await this.dropsService.findDropByIdOrThrow(
            {
              dropId: drop_id,
              skipEligibilityCheck: true
            },
            {
              ...ctx,
              connection
            }
          );
          return {
            apiDrop,
            pendingPushNotificationIds: pending_push_notification_ids
          };
        }
      );
    await waveScoreService.requestWaveScoreRefreshBestEffort(
      [model.wave_id],
      WaveScoreDirtyRefreshReason.DROP_CHANGED,
      ctx
    );
    await invalidateWaveUnreadCacheForWave(model.wave_id);
    await this.sendPendingPushNotifications({
      dropId: apiDrop.id,
      pendingPushNotificationIds
    });
    void this.ensureNftLinkTrackingForDrop(apiDrop.id, ctx);
    await this.wsListenersNotifier.notifyAboutDropUpdate(apiDrop, ctx);
    return apiDrop;
  }

  private async sendPendingPushNotifications({
    dropId,
    pendingPushNotificationIds
  }: {
    dropId: string;
    pendingPushNotificationIds: number[];
  }) {
    try {
      await sendIdentityPushNotifications(pendingPushNotificationIds);
    } catch (error) {
      this.logger.error(
        `Failed to send push notifications for drop ${dropId} with pending ids ${pendingPushNotificationIds.join(',')}`,
        error
      );
    }
  }

  private async ensureNftLinkTrackingForDrop(
    dropId: string,
    ctx: RequestContext
  ) {
    try {
      const links = await this.dropNftLinksDb.findByDropId(
        dropId,
        ctx.connection,
        true
      );
      if (!links.length) {
        return;
      }
      await this.nftLinkResolvingService.ensureTrackingForUrls(
        links.map((it) => it.url_in_text),
        ctx
      );
    } catch (e) {
      this.logger.error(
        `Failed to initialize NFT link tracking for drop ${dropId}`,
        e
      );
    }
  }
}

export const dropCreationService = new DropCreationApiService(
  dropsService,
  dropsDb,
  dropsMappers,
  createOrUpdateDrop,
  deleteDrop,
  wsListenersNotifier,
  dropNftLinksDb,
  nftLinkResolvingService,
  dropPollsApiService
);
