import { findCommittedDropOnWriter } from '@/api/drops/drop-writer-read';
import { metricEnvironment } from '@/metric-environment';
import {
  readCommitted,
  runWriteTransaction
} from '@/api/write-transaction-budget';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { DropsApiService, dropsService } from './drops.api.service';
import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { ApiDrop } from '../generated/models/ApiDrop';
import { AuthenticationContext } from '../../../auth-context';
import { Time, Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { ApiUpdateDropRequest } from '../generated/models/ApiUpdateDropRequest';
import {
  createOrUpdateDrop,
  CreateOrUpdateDropUseCase,
  sanitizeDropStructuredFields,
  PrePublicationPreparation
} from '../../../drops/create-or-update-drop.use-case';
import {
  moderationReviewDb,
  moderationConflict
} from '@/content-moderation/moderation-review.db';
import { moderationFingerprint } from '@/content-moderation/moderation-review.types';
import {
  CreateOrUpdateDropModel,
  DropPartIdentifierModel
} from '../../../drops/create-or-update-drop.model';
import { ConnectionWrapper } from '../../../sql-executor';
import { dropsMappers, DropsMappers } from './drops.mappers';
import { withOwnedMediaUploadIds } from './drop-media-upload-refs';
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

import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { assertProxyMayEditDrops } from '@/api/drops/drop-proxy-rights';
import {
  dropClientIdsDb,
  DropClientIdsDb,
  DropClientIdTakenError
} from '@/drops/drop-client-ids.db';
import { DropClientIdEntity } from '@/entities/IDropClientId';
import { DropType } from '@/entities/IDrop';
import { DROP_UPDATE_REASON_REPLY_COLLAPSE } from '@/api/ws/ws-message';
import {
  chatHistoryPurgeDb,
  ChatHistoryPurgeDb,
  CHAT_HISTORY_PURGE_BATCH_SIZE
} from '@/drops/chat-history-purge.db';
import {
  createChatHistoryPurgeToken,
  readChatHistoryPurgeToken
} from '@/api/waves/chat-history-purge-token';
import { ApiWaveChatHistoryPurgePlan } from '@/api/generated/models/ApiWaveChatHistoryPurgePlan';
import {
  DropPostHops,
  serverReceivedAtFromTimer
} from '@/ws-delivery/wave-delivery-metrics';
import {
  DropCreatedEffectsJob,
  WAVE_FANOUT_JOB_VERSION
} from '@/ws-delivery/wave-fanout-job';
import {
  isAsyncFanoutEnabled,
  WaveFanoutQueue,
  waveFanoutQueue
} from '@/ws-delivery/wave-fanout-queue';

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

import { competitionEntryDropHooks } from '@/competitions/competition-entry-drop-hooks';
import { isDropWriteOutboxEnabled } from '@/drops/drop-write-outbox.types';
import { handOffDropWriteOutbox } from '@/drops/drop-write-outbox.hand-off';
import { findCommittedDropOnPrimary } from '@/api/drops/drop-writer-read';

/**
 * The after-commit pipeline of a new drop: (1) read the committed drop; then
 * (2) deliver it (frames and the 1.1 worker hand-off, owned by drop delivery)
 * and (3) hand off outbox work, started together and both awaited before the
 * response. Waves 1.8 supplies stages 1 and 3; nothing else may add a
 * competing post-commit path.
 */
export interface DropAfterCommitStages {
  /** Stage 1: the committed drop as the writer sees it. */
  readCommittedDrop(
    input: { dropId: string; inTransactionDrop: ApiDrop | null },
    ctx: RequestContext
  ): Promise<ApiDrop>;
  /**
   * Stage 3: hand post-commit outbox work to its processor (enqueue or wake
   * only). It must not do notification or metric work before the response.
   */
  processOutbox(
    input: { dropId: string; waveId: string; outboxId: number | null },
    ctx: RequestContext
  ): Promise<void>;
}

/** Until 1.8: the drop read inside the transaction, and no outbox. */
export const defaultDropAfterCommitStages: DropAfterCommitStages = {
  readCommittedDrop: async ({ inTransactionDrop }) => {
    if (!inTransactionDrop) {
      throw new Error('The default stages need the in-transaction drop');
    }
    return inTransactionDrop;
  },
  processOutbox: async () => undefined
};

/**
 * Waves 1.8 stages. With `WS_POST_OUTBOX` off the write still reads the drop
 * in its transaction and leaves no outbox row, so these behave exactly like
 * the defaults. With it on, stage 1 reads the committed drop on the primary,
 * outside any transaction so its queries run in parallel, and stage 3 hands
 * the outbox row to the worker.
 */
export function dropWriteOutboxAfterCommitStages(
  dropsService: Pick<DropsApiService, 'findDropByIdOrThrow'>,
  handOff: typeof handOffDropWriteOutbox = handOffDropWriteOutbox
): DropAfterCommitStages {
  return {
    readCommittedDrop: async ({ dropId, inTransactionDrop }, ctx) =>
      inTransactionDrop ??
      findCommittedDropOnPrimary({ dropId, dropsService }, ctx),
    processOutbox: async ({ dropId, waveId, outboxId }, ctx) => {
      await handOff({ outboxId, dropId, waveId }, ctx);
    }
  };
}

interface ClientDrop {
  readonly clientDropId: string;
  readonly waveId: string;
  readonly contentFingerprint: string;
}

/**
 * Request fields that prove who sent a drop rather than describe it. A
 * retry may carry fresh proofs for the same content (a new wallet nonce or
 * device envelope), so they are not part of the fingerprint.
 */
const CLIENT_DROP_PROOF_FIELDS = [
  'client_drop_id',
  'device_signature',
  'signature',
  'signature_message',
  'is_safe_signature',
  'signer_address',
  'author'
] as const;

/**
 * Fingerprints the drop content exactly as the client sent it: the same for
 * an identical retry, whatever the server derives from it and whatever
 * fresh signature the retry carries; different as soon as wave, parts,
 * metadata, mentions, poll or any other content field changes.
 */
export function clientDropFingerprint(request: ApiCreateDropRequest): string {
  const content: Record<string, unknown> = { ...request };
  for (const field of CLIENT_DROP_PROOF_FIELDS) {
    delete content[field];
  }
  return moderationFingerprint(content);
}

const CLIENT_DROP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function clientDropFor(request: ApiCreateDropRequest): ClientDrop | null {
  if (request.client_drop_id === undefined || request.client_drop_id === null) {
    return null;
  }
  // The route passes Joi's normalized value; re-check for other callers so a
  // malformed id never reaches a lookup or becomes a key.
  const clientDropId = String(request.client_drop_id).toLowerCase();
  if (!CLIENT_DROP_ID_PATTERN.test(clientDropId)) {
    throw new BadRequestException(
      'client_drop_id must be a UUID in the plain 8-4-4-4-12 form'
    );
  }
  return {
    clientDropId,
    waveId: request.wave_id,
    contentFingerprint: clientDropFingerprint(request)
  };
}

/**
 * One EMF count per idempotent-create outcome, so a retry storm (many
 * `concurrent` or `replayed`) or misbehaving clients (`reused`) show up.
 */
function recordClientDropOutcome(
  outcome: 'replayed' | 'concurrent' | 'reused'
): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  const environment = metricEnvironment();
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/DropCreate',
              Dimensions: [['Environment', 'Outcome']],
              Metrics: [{ Name: 'ClientDropIdOutcome', Unit: 'Count' }]
            }
          ]
        },
        Environment: environment,
        Outcome: outcome,
        ClientDropIdOutcome: 1
      })}\n`
    );
  } catch {
    /* Telemetry must not alter the create. */
  }
}

const POST_COMMIT_READ_RETRY_DELAY_MS = 200;

/**
 * The drop was saved but could not be read back for the response. Not a
 * 2xx (the web inserts the response as a drop), and a status no client
 * retries; the message tells the author not to post it again.
 */
class DropSavedRefreshException extends CustomApiCompliantException {
  constructor() {
    super(
      409,
      'Your drop was posted. Refresh to see it.',
      'DROP_SAVED_REFRESH'
    );
  }
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
    private readonly dailyActivityCreditQueueService: HelpBotDailyActivityCreditQueueService = helpBotDailyActivityCreditQueueService,
    private readonly purgeDb: ChatHistoryPurgeDb = chatHistoryPurgeDb,
    private readonly clientIdsDb: DropClientIdsDb = dropClientIdsDb,
    private readonly fanoutQueue: WaveFanoutQueue = waveFanoutQueue,
    private readonly afterCommitStages: DropAfterCommitStages = defaultDropAfterCommitStages
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
    const hops = new DropPostHops();
    const serverReceivedAt = serverReceivedAtFromTimer(ctx.timer);
    const proxyId =
      authorId === representativeId ? undefined : representativeId;
    const replay = await moderationReviewDb.savedRequest(
      authorId,
      'DROP',
      ctx.moderationRequestId,
      ctx
    );
    // R11-2: the media keeps its own upload's id, which links layout hints.
    // A retry of a published request resolves as the first attempt did.
    const model = await withOwnedMediaUploadIds(
      this.dropsMappers.createDropApiToUseCaseModel({
        request: createDropRequest,
        authorId,
        proxyId
      }),
      createDropRequest,
      { publishedDropId: replay?.published_subject_id ?? null }
    );
    const createModel: typeof model =
      hideLinkPreview === undefined
        ? model
        : {
            ...model,
            hide_link_preview: hideLinkPreview
          };
    if (replay) {
      if (
        replay.scope.context_fingerprint !==
          moderationFingerprint(sanitizeDropStructuredFields(createModel)) ||
        !replay.published_subject_id
      )
        moderationConflict();
      return this.dropsService.findDropByIdOrThrow(
        { dropId: replay.published_subject_id },
        ctx
      );
    }
    // A retried send with the same client_drop_id returns the drop the first
    // attempt made, before any moderation or write work (waves R11-5).
    const clientDrop = clientDropFor(createDropRequest);
    if (clientDrop) {
      const replay = await this.findClientDropReplay(
        { createDropRequest, authorId },
        ctx
      );
      if (replay) {
        return replay;
      }
    }
    const preResolvedIdentityNomination =
      await this.createOrUpdateDrop.preResolveIdentityNomination(createModel, {
        timer: ctx.timer
      });
    // Wave and eligibility checks run before the pre-publication model
    // evaluator, and only for content that needs it.
    const prePublication = await this.createOrUpdateDrop.preparePrePublication(
      createModel,
      ctx,
      {
        beforeModelEvaluation: () =>
          this.createOrUpdateDrop.assertCanCreateDropInWave(createModel, ctx)
      }
    );
    hops.set('drop_pre_commit_ms', hops.elapsed());
    let created: Awaited<
      ReturnType<DropCreationApiService['createDropWithGivenConnection']>
    >;
    // Splits drop_commit_ms: connection + BEGIN, the post's statements, COMMIT.
    const transaction: { bodyStartedAt?: number; bodyEndedAt?: number } = {};
    const transactionStartedAt = hops.elapsed();
    try {
      created = await hops.time('drop_commit_ms', () =>
        runWriteTransaction((options) =>
          this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
            transaction.bodyStartedAt = hops.elapsed();
            try {
              return await this.createDropWithGivenConnection(
                {
                  model: createModel,
                  authorId,
                  preResolvedIdentityNomination,
                  prePublication,
                  requestDailyActivityCredit,
                  clientDrop
                },
                normalizeCreateDropPollRequest(createDropRequest.poll),
                { timer: ctx.timer!, connection }
              );
            } finally {
              transaction.bodyEndedAt = hops.elapsed();
            }
          }, options)
        )
      );
    } catch (error) {
      if (!(error instanceof DropClientIdTakenError) || !clientDrop) {
        throw error;
      }
      // A concurrent attempt with the same id committed first; this one
      // rolled back and returns that attempt's drop.
      const claimed = await this.clientIdsDb.find(
        { authorId, clientDropId: clientDrop.clientDropId },
        ctx
      );
      if (!claimed) {
        throw error;
      }
      recordClientDropOutcome('concurrent');
      return this.findClientDropRetry(claimed, clientDrop, ctx);
    }
    const committedAt = hops.elapsed();
    if (
      transaction.bodyStartedAt !== undefined &&
      transaction.bodyEndedAt !== undefined
    ) {
      hops.set(
        'drop_tx_begin_ms',
        transaction.bodyStartedAt - transactionStartedAt
      );
      hops.set(
        'drop_tx_body_ms',
        transaction.bodyEndedAt - transaction.bodyStartedAt
      );
      hops.set('drop_tx_commit_ms', committedAt - transaction.bodyEndedAt);
    }
    const {
      drop: transactionDrop,
      dropId: committedDropId,
      outboxId,
      pendingPushNotificationIds,
      dmUnreadRecipientIds,
      dailyActivityCreditRequestEnqueued
    } = created;
    // After-commit pipeline, in this order (waves 1.1 + 1.8):
    // 1. the committed drop as the writer sees it (#2372: read after commit,
    //    retried once), then its gap marker (waves 1.5): the wave's previous
    //    surviving serial, read after commit.
    // The drop is committed from here on: no failure below may look like a
    // failed write, or the author reposts it.
    const drop = await hops.time('post_commit_read_ms', () =>
      this.readCommittedDropOrNull(
        committedDropId,
        transactionDrop,
        authorId,
        ctx
      )
    );
    if (!drop) {
      await this.runCreatedDropEffectsWithoutDrop(
        {
          dropId: committedDropId,
          waveId: createModel.wave_id,
          authorId,
          collaboratorIds: createDropRequest.collaborator_ids ?? [],
          pendingPushNotificationIds,
          dmUnreadRecipientIds,
          dailyActivityCreditRequestEnqueued
        },
        ctx
      );
      throw new DropSavedRefreshException();
    }
    if (clientDrop) {
      drop.client_drop_id = clientDrop.clientDropId;
    }
    const prevSerialNo = await hops.time('post_commit_prev_serial_ms', () =>
      this.findPrevSerialNo(drop, ctx)
    );
    const gapMarker = prevSerialNo === undefined ? {} : { prevSerialNo };
    // 2. delivery: frames, plus (with WS_ASYNC_FANOUT) the worker hand-off;
    const delivery = isAsyncFanoutEnabled()
      ? this.replyAfterCommit(
          {
            v: WAVE_FANOUT_JOB_VERSION,
            kind: 'drop_created_effects',
            enqueued_at: Date.now(),
            drop_id: drop.id,
            wave_id: createModel.wave_id,
            author_id: authorId,
            pending_push_notification_ids: pendingPushNotificationIds,
            dm_unread_recipient_ids: dmUnreadRecipientIds,
            collaborator_ids: createDropRequest.collaborator_ids ?? []
          },
          { drop, gapMarker, dailyActivityCreditRequestEnqueued, hops },
          ctx
        )
      : this.deliverCreatedDropInline(
          {
            drop,
            waveId: createModel.wave_id,
            authorId,
            collaboratorIds: createDropRequest.collaborator_ids ?? [],
            pendingPushNotificationIds,
            dmUnreadRecipientIds,
            dailyActivityCreditRequestEnqueued,
            hops,
            gapMarker
          },
          ctx
        );
    // 3. the outbox hand-off, started with delivery. Both are awaited, and
    //    a delivery failure is rethrown only after the hand-off has settled.
    const [delivered] = await Promise.allSettled([
      delivery,
      this.handOffOutbox(drop, createModel.wave_id, outboxId, hops, ctx)
    ]);
    if (delivered.status === 'rejected') throw delivered.reason;
    hops.set('drop_post_commit_ms', hops.elapsed() - committedAt);
    hops.set(
      'drop_post_total_ms',
      serverReceivedAt === null ? hops.elapsed() : Date.now() - serverReceivedAt
    );
    hops.emit({ drop_id: drop.id, wave_id: createModel.wave_id });
    return drop;
  }

  /**
   * The gap marker of a new drop (waves 1.5). Best effort: if the read
   * fails, the frame goes out without a marker (clients then see no gap)
   * rather than failing the committed POST.
   */
  private async findPrevSerialNo(
    drop: ApiDrop,
    ctx: RequestContext
  ): Promise<number | null | undefined> {
    try {
      return await this.dropsDb.findPreviousSerialNo(
        { waveId: drop.wave.id, serialNo: drop.serial_no },
        { timer: ctx.timer }
      );
    } catch (error) {
      this.logger.warn(
        `Gap marker read failed for drop ${drop.id}; sending without it`,
        error
      );
      return undefined;
    }
  }

  /**
   * Stage 3 of the after-commit pipeline. It only hands work off; any
   * failure is logged and never fails the already-committed POST.
   */
  private async handOffOutbox(
    drop: ApiDrop,
    waveId: string,
    outboxId: number | null,
    hops: DropPostHops,
    ctx: RequestContext
  ): Promise<void> {
    try {
      await hops.time('post_commit_outbox_ms', () =>
        this.afterCommitStages.processOutbox(
          { dropId: drop.id, waveId, outboxId },
          ctx
        )
      );
    } catch (error) {
      this.logger.error(
        `Failed to hand off post-commit outbox work for drop ${drop.id}`,
        error
      );
    }
  }

  /** Pre-1.1 post-commit delivery, unchanged, used when the flag is off. */
  private async deliverCreatedDropInline(
    {
      drop,
      waveId,
      authorId,
      collaboratorIds,
      pendingPushNotificationIds,
      dmUnreadRecipientIds,
      dailyActivityCreditRequestEnqueued,
      hops,
      gapMarker
    }: {
      drop: ApiDrop;
      waveId: string;
      authorId: string;
      collaboratorIds: string[];
      pendingPushNotificationIds: number[];
      dmUnreadRecipientIds: string[];
      dailyActivityCreditRequestEnqueued: boolean;
      hops: DropPostHops;
      gapMarker: { prevSerialNo?: number | null };
    },
    ctx: RequestContext
  ): Promise<void> {
    if (dailyActivityCreditRequestEnqueued) {
      await hops.time('post_commit_daily_activity_ms', () =>
        this.dailyActivityCreditQueueService.sendWakeupBestEffort(ctx)
      );
    }
    // Before the fan-out: a frame must not reach a client that then reads a
    // cached unread count the new drop has not invalidated yet.
    await hops.time('post_commit_unread_cache_ms', () =>
      invalidateWaveUnreadCacheForWave(waveId)
    );
    await hops.time('post_commit_push_ms', () =>
      this.sendPendingPushNotifications({
        dropId: drop.id,
        pendingPushNotificationIds
      })
    );
    void this.ensureNftLinkTrackingForDrop(drop.id, ctx);
    // The wave-score request is independent of the frames (best effort, never
    // throws), so it runs beside the fan-out instead of before it.
    await Promise.all([
      hops.time('post_commit_wave_score_ms', () =>
        waveScoreService.requestWaveScoreRefreshBestEffort(
          [waveId],
          WaveScoreDirtyRefreshReason.DROP_CHANGED,
          ctx
        )
      ),
      hops.time('post_commit_fanout_ms', () =>
        this.wsListenersNotifier.notifyAboutDropUpdate(drop, ctx, gapMarker)
      )
    ]);
    if (collaboratorIds.length) {
      await hops.time('post_commit_collaborators_ms', () =>
        this.wsListenersNotifier.notifyAboutIdentityNotificationsChanged([
          authorId,
          ...collaboratorIds
        ])
      );
    }
    await hops.time('post_commit_dm_unread_ms', () =>
      this.notifyDmUnreadStateChanged({
        waveId,
        recipientIds: dmUnreadRecipientIds,
        ctx
      })
    );
  }

  /**
   * Waves 1.1 (`WS_ASYNC_FANOUT`): after the commit the request only
   * invalidates the unread cache, sends the drop to open-wave viewers (the
   * notifier queues the rest of the audience), and hands push, DM unread,
   * collaborator and wave-score work to the fan-out worker. The hand-off is
   * awaited; if the queue does not accept it, the work runs here instead.
   */
  private async replyAfterCommit(
    effects: DropCreatedEffectsJob,
    {
      drop,
      gapMarker,
      dailyActivityCreditRequestEnqueued,
      hops
    }: {
      drop: ApiDrop;
      gapMarker: { prevSerialNo?: number | null };
      dailyActivityCreditRequestEnqueued: boolean;
      hops: DropPostHops;
    },
    ctx: RequestContext
  ): Promise<void> {
    if (dailyActivityCreditRequestEnqueued) {
      await hops.time('post_commit_daily_activity_ms', () =>
        this.dailyActivityCreditQueueService.sendWakeupBestEffort(ctx)
      );
    }
    await hops.time('post_commit_unread_cache_ms', () =>
      invalidateWaveUnreadCacheForWave(effects.wave_id)
    );
    void this.ensureNftLinkTrackingForDrop(drop.id, ctx);
    const [, notAccepted] = await Promise.all([
      hops.time('post_commit_fanout_ms', () =>
        this.wsListenersNotifier.notifyAboutDropUpdate(drop, ctx, gapMarker)
      ),
      hops.time('post_commit_hand_off_ms', () =>
        this.fanoutQueue.enqueue([effects])
      )
    ]);
    if (notAccepted.length) {
      await hops.time('post_commit_effects_inline_ms', () =>
        this.runDropCreatedEffects(effects, ctx)
      );
    }
  }

  /**
   * The post-commit side effects of a new drop other than its frames. Each
   * step is best effort, as before 1.1; the worker runs this for queued jobs.
   */
  public async runDropCreatedEffects(
    effects: DropCreatedEffectsJob,
    ctx: RequestContext
  ): Promise<void> {
    await waveScoreService.requestWaveScoreRefreshBestEffort(
      [effects.wave_id],
      WaveScoreDirtyRefreshReason.DROP_CHANGED,
      ctx
    );
    await this.sendPendingPushNotifications({
      dropId: effects.drop_id,
      pendingPushNotificationIds: effects.pending_push_notification_ids
    });
    if (effects.collaborator_ids.length) {
      await this.wsListenersNotifier.notifyAboutIdentityNotificationsChanged([
        effects.author_id,
        ...effects.collaborator_ids
      ]);
    }
    await this.notifyDmUnreadStateChanged({
      waveId: effects.wave_id,
      recipientIds: effects.dm_unread_recipient_ids,
      ctx
    });
  }

  /**
   * The committed drop, read after commit (staging's after-commit stage):
   * retried once after a short pause, then null (logged) rather than an
   * error, since the drop is saved.
   */
  private async readCommittedDropOrNull(
    dropId: string,
    inTransactionDrop: ApiDrop | null,
    authorId: string,
    ctx: RequestContext
  ): Promise<ApiDrop | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.afterCommitStages.readCommittedDrop(
          { dropId, inTransactionDrop },
          {
            ...ctx,
            authenticationContext: AuthenticationContext.fromProfileId(authorId)
          }
        );
      } catch (error) {
        if (attempt >= 2) {
          this.logger.error('[POST_COMMIT_READ_FAILED]', {
            drop_id: dropId,
            code: (error as { code?: unknown } | null)?.code ?? null
          });
          return null;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, POST_COMMIT_READ_RETRY_DELAY_MS)
        );
      }
    }
  }

  /**
   * A saved drop that could not be read back still gets every post-commit
   * effect that does not need the mapped drop (only its frames are skipped).
   */
  private async runCreatedDropEffectsWithoutDrop(
    {
      dropId,
      waveId,
      authorId,
      collaboratorIds,
      pendingPushNotificationIds,
      dmUnreadRecipientIds,
      dailyActivityCreditRequestEnqueued
    }: {
      dropId: string;
      waveId: string;
      authorId: string;
      collaboratorIds: string[];
      pendingPushNotificationIds: number[];
      dmUnreadRecipientIds: string[];
      dailyActivityCreditRequestEnqueued: boolean;
    },
    ctx: RequestContext
  ): Promise<void> {
    if (dailyActivityCreditRequestEnqueued) {
      await this.dailyActivityCreditQueueService.sendWakeupBestEffort(ctx);
    }
    await invalidateWaveUnreadCacheForWave(waveId);
    await this.runDropCreatedEffects(
      {
        v: WAVE_FANOUT_JOB_VERSION,
        kind: 'drop_created_effects',
        enqueued_at: Date.now(),
        drop_id: dropId,
        wave_id: waveId,
        author_id: authorId,
        pending_push_notification_ids: pendingPushNotificationIds,
        dm_unread_recipient_ids: dmUnreadRecipientIds,
        collaborator_ids: collaboratorIds
      },
      ctx
    );
  }

  /**
   * The drop an earlier attempt with the same client_drop_id created, or
   * null when the id is unused. The create route calls this before checking
   * device signatures: a retried signed envelope would otherwise be refused
   * as already used, although the first attempt succeeded.
   */
  public async findClientDropReplay(
    {
      createDropRequest,
      authorId
    }: { createDropRequest: ApiCreateDropRequest; authorId: string },
    ctx: RequestContext
  ): Promise<ApiDrop | null> {
    const clientDrop = clientDropFor(createDropRequest);
    if (!clientDrop) {
      return null;
    }
    const claimed = await this.clientIdsDb.find(
      { authorId, clientDropId: clientDrop.clientDropId },
      ctx
    );
    if (!claimed) {
      return null;
    }
    recordClientDropOutcome('replayed');
    return this.findClientDropRetry(claimed, clientDrop, ctx);
  }

  /**
   * Answers a retried create whose client_drop_id is already claimed. Only an
   * identical request (same wave and content) gets the original drop back.
   */
  private async findClientDropRetry(
    claimed: DropClientIdEntity,
    clientDrop: ClientDrop,
    ctx: RequestContext
  ): Promise<ApiDrop> {
    if (
      claimed.wave_id !== clientDrop.waveId ||
      claimed.content_fingerprint !== clientDrop.contentFingerprint
    ) {
      recordClientDropOutcome('reused');
      throw new CustomApiCompliantException(
        409,
        'client_drop_id was already used for a different drop',
        'CLIENT_DROP_ID_REUSED'
      );
    }
    let drop: ApiDrop;
    try {
      // Read the writer: the first attempt may have committed moments ago.
      drop = await this.dropsDb.executeNativeQueriesInTransaction(
        (connection) =>
          this.dropsService.findDropByIdOrThrow(
            { dropId: claimed.drop_id, skipEligibilityCheck: true },
            { ...ctx, connection }
          ),
        { isolationLevel: 'READ COMMITTED' }
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        recordClientDropOutcome('reused');
        throw new CustomApiCompliantException(
          409,
          'client_drop_id was used for a drop that no longer exists',
          'CLIENT_DROP_ID_REUSED'
        );
      }
      throw error;
    }
    return { ...drop, client_drop_id: clientDrop.clientDropId };
  }

  private async createDropWithGivenConnection(
    {
      model,
      authorId,
      preResolvedIdentityNomination,
      prePublication,
      requestDailyActivityCredit,
      clientDrop = null
    }: {
      model: CreateOrUpdateDropModel;
      authorId: string;
      preResolvedIdentityNomination: Awaited<
        ReturnType<CreateOrUpdateDropUseCase['preResolveIdentityNomination']>
      > | null;
      prePublication: PrePublicationPreparation;
      requestDailyActivityCredit: boolean;
      clientDrop?: ClientDrop | null;
    },
    poll: CreateDropPollRequest | null | undefined,
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ): Promise<{
    drop: ApiDrop | null;
    dropId: string;
    outboxId: number | null;
    pendingPushNotificationIds: number[];
    dmUnreadRecipientIds: string[];
    dailyActivityCreditRequestEnqueued: boolean;
  }> {
    const useOutbox = isDropWriteOutboxEnabled();
    const {
      drop_id,
      replayed,
      pending_push_notification_ids,
      dm_unread_recipient_ids,
      outbox_id
    } = await this.createOrUpdateDrop.execute(model, false, {
      timer,
      connection,
      preResolvedIdentityNomination,
      prePublication,
      useOutbox
    });
    if (clientDrop && !replayed) {
      // Claimed in the same transaction as the drop. A concurrent attempt
      // with the same id waits on this one key and then fails.
      await this.clientIdsDb.insert(
        {
          author_id: authorId,
          client_drop_id: clientDrop.clientDropId,
          drop_id,
          wave_id: model.wave_id,
          content_fingerprint: clientDrop.contentFingerprint,
          created_at: Time.currentMillis()
        },
        { timer, connection }
      );
    }
    if (!replayed)
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
    const dailyActivityCreditRequestEnqueued =
      requestDailyActivityCredit && !replayed
        ? await this.dailyActivityCreditQueueService.enqueueRequest(
            { profileId: authorId },
            { timer, connection }
          )
        : false;
    // Waves 1.8: with the outbox the response read runs after commit, on the
    // writer, so it no longer extends the write transaction. Without it the
    // read stays here (staging only); under the #2372 write budget its
    // overlapping mapping reads make the post rerun unbudgeted, logged as
    // [WRITE_BUDGET_CONCURRENT_STATEMENTS].
    const drop = useOutbox
      ? null
      : await this.dropsService.findDropByIdOrThrow(
          {
            dropId: drop_id,
            skipEligibilityCheck: true
          },
          {
            connection,
            authenticationContext:
              AuthenticationContext.fromProfileId(authorId),
            timer
          }
        );
    return {
      drop,
      dropId: drop_id,
      outboxId: outbox_id ?? null,
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
    const deleteResponse = await runWriteTransaction((options) =>
      this.dropsDb.executeNativeQueriesInTransaction(
        async (connection) =>
          await this.deleteDrop.execute(
            {
              drop_id: id,
              deleter_identity: authenticatedProfileId,
              deleter_id: authenticatedProfileId,
              deletion_purpose: 'DELETE'
            },
            { timer: timer!, connection }
          ),
        readCommitted(options)
      )
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

  private getChatHistoryPurgeAuthor(ctx: RequestContext): string {
    const authenticationContext = ctx.authenticationContext;
    const authorId = authenticationContext?.getActingAsId();
    if (!authenticationContext || !authorId) {
      throw new ForbiddenException('Please create a profile first');
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(
        'Proxy is not allowed to delete chat history'
      );
    }
    return authorId;
  }

  public async prepareMyWaveChatHistoryPurge(
    { waveId }: { waveId: string },
    ctx: RequestContext
  ): Promise<ApiWaveChatHistoryPurgePlan> {
    const authorId = this.getChatHistoryPurgeAuthor(ctx);
    return this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx = { ...ctx, connection };
        const wave = await this.wavesApiDb.findWaveByIdForUpdate(waveId, txCtx);
        if (!wave) throw new NotFoundException(`Wave ${waveId} not found`);
        const cutoffSerialNo = await this.purgeDb.findCutoff(
          { waveId, authorId },
          txCtx
        );
        return {
          purge_token: createChatHistoryPurgeToken({
            waveId,
            authorId,
            cutoffSerialNo
          })
        };
      }
    );
  }

  public async deleteMyWaveChatHistory(
    {
      waveId,
      purgeToken
    }: { readonly waveId: string; readonly purgeToken?: string },
    ctx: RequestContext
  ): Promise<ApiDeleteMyWaveChatHistoryResponse> {
    const timerName = `${this.constructor.name}->deleteMyWaveChatHistory`;
    ctx.timer?.start(timerName);
    try {
      const authorId = this.getChatHistoryPurgeAuthor(ctx);
      const tokenCutoff =
        purgeToken === undefined
          ? undefined
          : readChatHistoryPurgeToken(purgeToken, { waveId, authorId });
      const {
        deleteResponses,
        preservedPinnedDropId,
        hasMore,
        dmUnreadRecipientIds
      } = await this.dropsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const transactionContext = { ...ctx, connection };
          const wave = await this.wavesApiDb.findWaveByIdForUpdate(
            waveId,
            transactionContext
          );
          if (!wave) throw new NotFoundException(`Wave ${waveId} not found`);
          const cutoffSerialNo =
            tokenCutoff ??
            (await this.purgeDb.findCutoff(
              { waveId, authorId },
              transactionContext
            ));
          const scope = { waveId, authorId, cutoffSerialNo };
          const candidates = await this.purgeDb.findBatchForUpdate(
            { ...scope, pinnedDropId: wave.description_drop_id },
            transactionContext
          );
          const hasMore = candidates.length > CHAT_HISTORY_PURGE_BATCH_SIZE;
          if (purgeToken === undefined && hasMore) {
            throw new BadRequestException(
              'Please update your app to delete a large chat history in batches'
            );
          }
          const pinnedDrop = wave.description_drop_id
            ? await this.dropsDb.findDropById(
                wave.description_drop_id,
                connection
              )
            : null;
          const drops = candidates.slice(0, CHAT_HISTORY_PURGE_BATCH_SIZE);
          const recipientIds = await this.deleteDrop.executeChatHistoryBatch(
            scope,
            drops,
            wave,
            transactionContext
          );
          return {
            hasMore,
            dmUnreadRecipientIds: recipientIds,
            preservedPinnedDropId:
              pinnedDrop?.author_id === authorId &&
              pinnedDrop.drop_type === DropType.CHAT
                ? pinnedDrop.id
                : null,
            deleteResponses: drops.map((drop) => ({
              id: drop.id,
              serial_no: drop.serial_no,
              wave_id: waveId,
              visibility_group_id: wave.visibility_group_id
            }))
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
                recipientIds: dmUnreadRecipientIds,
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
        preserved_pinned_drop_id: preservedPinnedDropId,
        has_more: hasMore
      };
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async setDropReplyCollapse(
    { dropId, collapseReplies }: { dropId: string; collapseReplies: boolean },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const authorId = ctx.authenticationContext?.getActingAsId();
    if (!authorId || ctx.authenticationContext?.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(
        'Only the author can change reply placement'
      );
    }

    const placement = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const tx = { ...ctx, connection };
        const visibleDrop = await this.dropsService.findViewableDropByIdOrThrow(
          { dropId, unavailableMessage: 'Drop is unavailable' },
          tx
        );
        if (visibleDrop.author_id !== authorId) {
          throw new ForbiddenException(
            'Only the author can change reply placement'
          );
        }
        const wave = await this.wavesApiDb.findWaveByIdForUpdate(
          visibleDrop.wave_id,
          tx
        );
        const drop = await this.dropsDb.findDropById(dropId, connection, true);
        if (!wave || !drop)
          throw new NotFoundException(`Drop ${dropId} not found`);
        if (
          wave.is_direct_message ||
          wave.chat_replies_collapsed ||
          drop.drop_type !== DropType.CHAT ||
          drop.reply_to_drop_id !== null
        ) {
          throw new BadRequestException(
            'Reply placement can only be changed on top-level chat drops in waves with inline replies'
          );
        }
        const changed = await this.dropsDb.setDropReplyCollapse(
          { dropId, waveId: wave.id, collapseReplies },
          tx
        );
        return {
          changed,
          hasReplies: await this.dropsDb.hasDropReplies(dropId, tx)
        };
      },
      { isolationLevel: 'READ COMMITTED' }
    );

    const drop = await findCommittedDropOnWriter(
      { dropId, db: this.dropsDb, dropsService: this.dropsService },
      ctx
    );
    drop.reply_placement_has_replies = placement.hasReplies;
    if (placement.changed) {
      await this.wsListenersNotifier.notifyAboutDropUpdate(drop, ctx, {
        reason: DROP_UPDATE_REASON_REPLY_COLLAPSE
      });
    }
    return drop;
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
    const changed = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const tx = { ...ctx, connection };
        const entries = await competitionEntryDropHooks.lockForDelete(
          dropId,
          tx
        );
        const drop = await this.dropsDb.findDropById(dropId, connection);
        if (!drop) throw new NotFoundException(`Drop ${dropId} not found`);
        if (drop.author_id !== authenticatedProfileId)
          throw new ForbiddenException(
            'Only the author can toggle hide link preview'
          );
        const edit = await competitionEntryDropHooks.preparePresentationUpdate(
          drop,
          entries,
          tx
        );
        const newValue = hideLinkPreview ?? !drop.hide_link_preview;
        const updated = await this.dropsDb.updateHideLinkPreview(
          { drop_id: dropId, hide_link_preview: newValue },
          tx
        );
        if (updated)
          await competitionEntryDropHooks.recordUpdate(
            edit,
            { ...drop, hide_link_preview: newValue },
            authenticatedProfileId,
            tx
          );
        return updated;
      },
      { isolationLevel: 'READ COMMITTED' }
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
  ): Promise<{ drop: ApiDrop; changed: boolean }> {
    assertProxyMayEditDrops(ctx.authenticationContext);
    const drop = await this.dropsDb.findDropById(dropId);
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    if (drop.author_id !== authorId) {
      throw new ForbiddenException(`Only the author can update drop ${dropId}`);
    }
    if (drop.drop_type === DropType.COMPETITION)
      throw new ForbiddenException('Decision submissions cannot be edited');
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
    const model: CreateOrUpdateDropModel = await withOwnedMediaUploadIds(
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
      }),
      request
    );
    const replay = await moderationReviewDb.savedRequest(
      authorId,
      'DROP',
      ctx.moderationRequestId,
      ctx
    );
    if (replay) {
      if (
        replay.scope.context_fingerprint !==
          moderationFingerprint(sanitizeDropStructuredFields(model)) ||
        replay.published_subject_id !== dropId
      )
        moderationConflict();
      return {
        drop: await this.dropsService.findDropByIdOrThrow({ dropId }, ctx),
        changed: false
      };
    }
    const preResolvedIdentityNomination =
      await this.createOrUpdateDrop.preResolveIdentityNomination(model, {
        timer: ctx.timer
      });
    const prePublication = await this.createOrUpdateDrop.preparePrePublication(
      model,
      ctx
    );
    const useOutbox = isDropWriteOutboxEnabled();
    const {
      inTransactionDrop,
      committedDropId,
      outboxId,
      pendingPushNotificationIds
    } = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const { drop_id, pending_push_notification_ids, outbox_id } =
          await this.createOrUpdateDrop.execute(model, false, {
            timer: ctx.timer!,
            connection,
            preResolvedIdentityNomination,
            prePublication,
            useOutbox
          });
        const inTransactionDrop = useOutbox
          ? null
          : await this.dropsService.findDropByIdOrThrow(
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
          inTransactionDrop,
          committedDropId: drop_id,
          outboxId: outbox_id ?? null,
          pendingPushNotificationIds: pending_push_notification_ids
        };
      },
      { isolationLevel: 'READ COMMITTED' }
    );
    const apiDrop = await this.afterCommitStages.readCommittedDrop(
      { dropId: committedDropId, inTransactionDrop },
      ctx
    );
    try {
      await this.afterCommitStages.processOutbox(
        { dropId: committedDropId, waveId: model.wave_id, outboxId },
        ctx
      );
    } catch (error) {
      this.logger.error(
        `Failed to hand off post-commit outbox work for drop ${committedDropId}`,
        error
      );
    }
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
    return { drop: apiDrop, changed: true };
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
  dropPollsApiService,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  dropWriteOutboxAfterCommitStages(dropsService)
);
