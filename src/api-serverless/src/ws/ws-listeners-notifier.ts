import { ApiDrop } from '../generated/models/ApiDrop';
import {
  ANON_USER_ID,
  appWebSockets,
  AppWebSockets,
  WS_SEND_CONCURRENCY_CAP
} from './ws';
import { forEachConcurrent } from '@/for-each-concurrent';
import {
  buildDropFramesJobs,
  DropFramesJob,
  QueuedRecipient
} from '@/ws-delivery/wave-fanout-job';
import {
  fanoutChunkSize,
  inlineFanoutLimit,
  isAsyncFanoutEnabled,
  WaveFanoutQueue,
  waveFanoutQueue
} from '@/ws-delivery/wave-fanout-queue';
import { DeliveryBatch, DeliveryMetricsBatch } from '@/ws-delivery/ws-delivery';
import {
  WaveRecipient,
  wsConnectionRepository,
  WsConnectionRepository
} from './ws-connection.repository';
import { RequestContext } from '@/request.context';
import {
  attachmentStatusUpdateMessage,
  dropDeleteMessage,
  dropRatingUpdateMessage,
  dropReactionUpdateMessage,
  dropUpdateMessage,
  dmUnreadStateChangedMessage,
  dropUpdateRefMessage,
  DELIVERY_TIMESTAMPS_RESERVED_BYTES,
  DROP_UPDATE_MAX_UTF8_BYTES,
  DropUpdateRefType,
  WsMessageType,
  nftLinkUpdatedMessage,
  identityNotificationsChangedMessage,
  userIsTypingMessage,
  withDeliveryTimestamps
} from './ws-message';
import {
  FanoutMeasurement,
  FanoutSendOutcome,
  serverReceivedAtFromTimer
} from '@/ws-delivery/wave-delivery-metrics';
import { ApiDropWithoutWave } from '../generated/models/ApiDropWithoutWave';
import { ApiQuotedDropResponse } from '@/api/generated/models/ApiQuotedDropResponse';
import { ApiDropType } from '../generated/models/ApiDropType';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { Logger } from '@/logging';
import { Time } from '@/time';
import { identitiesDb } from '@/identities/identities.db';
import { enums } from '@/enums';
import { getLevelFromScore } from '@/profiles/profile-level';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiProfileClassification } from '../generated/models/ApiProfileClassification';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { ApiAttachment } from '@/api/generated/models/ApiAttachment';
import { ApiDropModerationStatus } from '@/api/generated/models/ApiDropModerationStatus';
import {
  contentModerationDb,
  ContentModerationDb
} from '@/content-moderation/content-moderation.db';
import { ApiDmUnreadConversationState } from '@/api/generated/models/ApiDmUnreadConversationState';
import { AuthenticationContext } from '@/auth-context';
import { NotFoundException, UnauthorisedException } from '@/exceptions';
import { isExpectedClientError } from '@/operational-errors';
import { typingFailureDetails } from './ws-typing-failure';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import {
  anonymizeDropBroadcast,
  getEmbeddedDropIds
} from '@/api/ws/ws-competition-anonymity';
import { dropsDb } from '@/drops/drops.db';

const scalarForLog = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean'
    ? String(value)
    : 'unknown';

const dropNotificationIdentityForLog = (drop: ApiDrop): string =>
  `drop_id=${scalarForLog(drop.id)} wave_id=${scalarForLog(
    drop.wave?.id
  )} serial_no=${scalarForLog(drop.serial_no)}`;

const SEND_OUTCOMES: ReadonlySet<string> = new Set([
  'sent',
  'resync_pending',
  'gone',
  'failed'
]);

/** Older transport adapters and test doubles resolve without a status. */
function sendOutcome(result: unknown): FanoutSendOutcome {
  const status =
    result && typeof result === 'object'
      ? Reflect.get(result, 'status')
      : undefined;
  return typeof status === 'string' && SEND_OUTCOMES.has(status)
    ? (status as FanoutSendOutcome)
    : 'sent';
}

export interface NotificationConnectionRecipient {
  readonly connectionId: string;
  readonly identityId: string;
  /** Stored JWT expiry when the lookup returned it; skips a fence read. */
  readonly jwtExpiry?: number;
}

/** The audience-wide inputs of one drop frame. */
interface DropFrames {
  readonly audienceDrop: ApiDrop;
  readonly hiddenDropIds: ReadonlySet<string>;
  readonly authorIdsByDropId: ReadonlyMap<string, string>;
  readonly updateType: DropMessageType;
  readonly reason?: string;
}

interface AsyncFanoutSplit {
  readonly inline: WaveRecipient[];
  readonly deferred: WaveRecipient[];
}

function queuedToRecipient(recipient: QueuedRecipient): WaveRecipient {
  return {
    connectionId: recipient.c,
    profileId: recipient.p,
    jwtExpiry: recipient.e,
    wave_id: null
  };
}

interface FanoutSend {
  readonly connectionId: string;
  readonly jwtExpiry?: number;
  /** Resolved when the pool reaches this send, so payloads stay lazy. */
  readonly message: () => string;
}

const normalizedErrorForLog = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const metadata = Object.fromEntries(
      ['name', 'message', 'code', 'status', 'statusCode']
        .filter((key) => {
          const candidate = value[key];
          return (
            typeof candidate === 'string' ||
            typeof candidate === 'number' ||
            typeof candidate === 'boolean'
          );
        })
        .map((key) => [key, value[key]])
    );
    return Object.keys(metadata).length
      ? JSON.stringify(metadata)
      : 'Unknown error';
  }
  return 'Unknown error';
};

const logDropNotificationFailure = (
  logger: Logger,
  operation: string,
  drop: ApiDrop,
  error: unknown
): void => {
  logger.error(
    `${operation} websocket notification failed: ${dropNotificationIdentityForLog(
      drop
    )} error=${normalizedErrorForLog(error)}`
  );
};

function applyGlobalModerationForRecipient(
  inputDrop: ApiDrop,
  profileId: string | null,
  authorIdsByDropId: ReadonlyMap<string, string>
): ApiDrop {
  const recipientDrop = structuredClone(inputDrop);
  const apply = (
    drop: ApiDrop | ApiDropWithoutWave,
    visited: Set<string>
  ): void => {
    const status = drop.moderation?.status ?? ApiDropModerationStatus.Visible;
    const canView =
      status === ApiDropModerationStatus.Visible ||
      (profileId !== null &&
        (authorIdsByDropId.get(drop.id) ?? drop.author.id) === profileId);
    drop.moderation = { status, can_view: canView };
    const shouldRecurse = !visited.has(drop.id);
    const nextVisited = shouldRecurse ? new Set(visited).add(drop.id) : visited;
    if (shouldRecurse) {
      for (const part of drop.parts) {
        if (part.quoted_drop?.drop) {
          apply(part.quoted_drop.drop, nextVisited);
        }
      }
      if (drop.reply_to?.drop) {
        apply(drop.reply_to.drop, nextVisited);
      }
    }
    if (!canView) {
      drop.title = null;
      drop.parts = drop.parts.map((part) => ({
        ...part,
        content: null,
        media: [],
        attachments: []
      }));
      drop.referenced_nfts = [];
      drop.mentioned_users = [];
      drop.mentioned_groups = [];
      drop.mentioned_waves = [];
      drop.metadata = [];
      drop.reactions = [];
      drop.nft_links = [];
      delete drop.poll;
    }
  };
  apply(recipientDrop, new Set<string>());
  return recipientDrop;
}

function collectQuotedDropIds(
  drop: ApiDrop | ApiDropWithoutWave,
  quotedDropIds: Set<string>
): Set<string> {
  for (const part of drop.parts) {
    const quotedDrop = part.quoted_drop;
    if (quotedDrop) {
      quotedDropIds.add(quotedDrop.drop_id);
      if (quotedDrop.drop) {
        collectQuotedDropIds(quotedDrop.drop, quotedDropIds);
      }
    }
  }
  if (drop.reply_to?.drop) {
    collectQuotedDropIds(drop.reply_to.drop, quotedDropIds);
  }
  return quotedDropIds;
}

function redactQuotedDropsInPlace(
  drop: ApiDrop | ApiDropWithoutWave,
  visibleQuotedDropIds: ReadonlySet<string>
): void {
  for (const part of drop.parts) {
    const quotedDrop = part.quoted_drop;
    if (!quotedDrop) {
      continue;
    }
    if (!visibleQuotedDropIds.has(quotedDrop.drop_id)) {
      const reference: ApiQuotedDropResponse & { is_deleted: boolean } = {
        drop_id: quotedDrop.drop_id,
        drop_part_id: quotedDrop.drop_part_id,
        is_deleted: false
      };
      part.quoted_drop = reference;
    } else if (quotedDrop.drop) {
      redactQuotedDropsInPlace(quotedDrop.drop, visibleQuotedDropIds);
    }
  }
  if (drop.reply_to?.drop) {
    redactQuotedDropsInPlace(drop.reply_to.drop, visibleQuotedDropIds);
  }
}

export function getQuotedDropIds(drop: ApiDrop): string[] {
  return Array.from(collectQuotedDropIds(drop, new Set<string>()));
}

/**
 * Websocket payloads are built once and fanned out to the whole wave audience,
 * so a quote stays embedded only when that entire audience can read it. Other
 * quotes keep their reference and clients resolve them with their own access.
 */
export function redactQuotedDropsOutsideAudience(
  inputDrop: ApiDrop,
  visibleQuotedDropIds: ReadonlySet<string>
): ApiDrop {
  if (
    getQuotedDropIds(inputDrop).every((dropId) =>
      visibleQuotedDropIds.has(dropId)
    )
  ) {
    return inputDrop;
  }
  const audienceDrop = structuredClone(inputDrop);
  redactQuotedDropsInPlace(audienceDrop, visibleQuotedDropIds);
  return audienceDrop;
}

function removeDropsAuthRequestContext(
  drop: ApiDrop | ApiDropWithoutWave,
  creditLeft: number
): ApiDrop {
  const modifiedDrop: ApiDrop = JSON.parse(JSON.stringify(drop));
  const maybeWave = (drop as ApiDrop).wave;
  const modifiedWave = maybeWave ? { ...maybeWave } : undefined;
  if (modifiedWave) {
    (modifiedWave as any).authenticated_user_eligible_to_vote = undefined;
    (modifiedWave as any).authenticated_user_eligible_to_participate =
      undefined;
    (modifiedWave as any).authenticated_user_eligible_to_chat = undefined;
    (modifiedWave as any).authenticated_user_eligible_to_reply = undefined;
    (modifiedWave as any).authenticated_user_can_delete_replies = undefined;
    (modifiedWave as any).authenticated_user_admin = undefined;
    (modifiedWave as any).credit_left = creditLeft;
    (modifiedDrop.wave as any) = modifiedWave;
    (modifiedDrop.author as any).subscribed_actions = undefined;
    (modifiedDrop as any).context_profile_context = undefined;
  }
  if (modifiedDrop.poll?.anonymous) {
    modifiedDrop.poll.voted = [];
  }
  for (const part of modifiedDrop.parts) {
    if (part.quoted_drop?.drop) {
      part.quoted_drop.drop = removeDropsAuthRequestContext(
        part.quoted_drop.drop,
        creditLeft
      );
    }
  }
  if (modifiedDrop.reply_to?.drop) {
    modifiedDrop.reply_to.drop = removeDropsAuthRequestContext(
      modifiedDrop.reply_to.drop,
      creditLeft
    );
  }
  return modifiedDrop;
}

/**
 * Serializes the exact recipient-scoped message that will be sent. The byte
 * check intentionally happens after auth-context removal, credit injection,
 * anonymous-poll redaction, and reason inclusion so a recipient's payload
 * cannot cross the application ceiling unexpectedly.
 */
type DropMessageType = DropUpdateRefType;

export function serializeDropMessageForRecipient(
  inputDrop: ApiDrop,
  creditLeft: number,
  updateType: DropMessageType,
  reason?: string
): string {
  const recipientDrop = removeDropsAuthRequestContext(inputDrop, creditLeft);
  let fullMessage: string;
  if (updateType === WsMessageType.DROP_UPDATE) {
    fullMessage = JSON.stringify(dropUpdateMessage(recipientDrop, reason));
  } else if (updateType === WsMessageType.DROP_RATING_UPDATE) {
    fullMessage = JSON.stringify(dropRatingUpdateMessage(recipientDrop));
  } else {
    fullMessage = JSON.stringify(dropReactionUpdateMessage(recipientDrop));
  }

  if (
    Buffer.byteLength(fullMessage, 'utf8') +
      DELIVERY_TIMESTAMPS_RESERVED_BYTES <=
    DROP_UPDATE_MAX_UTF8_BYTES
  ) {
    return fullMessage;
  }

  const refData = {
    drop_id: inputDrop.id,
    wave_id: inputDrop.wave.id,
    author_id: inputDrop.author.id,
    serial_no: inputDrop.serial_no,
    update_type: updateType,
    ...(reason !== undefined && updateType === WsMessageType.DROP_UPDATE
      ? { reason }
      : {})
  } satisfies {
    drop_id: string;
    wave_id: string;
    author_id: string;
    serial_no: number;
    update_type: DropUpdateRefType;
    reason?: string;
  };

  return JSON.stringify(dropUpdateRefMessage(refData));
}

export function serializeDropUpdateForRecipient(
  inputDrop: ApiDrop,
  creditLeft: number,
  reason?: string
): string {
  return serializeDropMessageForRecipient(
    inputDrop,
    creditLeft,
    WsMessageType.DROP_UPDATE,
    reason
  );
}

export function serializeDropRatingUpdateForRecipient(
  inputDrop: ApiDrop,
  creditLeft: number
): string {
  return serializeDropMessageForRecipient(
    inputDrop,
    creditLeft,
    WsMessageType.DROP_RATING_UPDATE
  );
}

export function serializeDropReactionUpdateForRecipient(
  inputDrop: ApiDrop,
  creditLeft: number
): string {
  return serializeDropMessageForRecipient(
    inputDrop,
    creditLeft,
    WsMessageType.DROP_REACTION_UPDATE
  );
}

const DEFAULT_VIEWER_CONTEXT = { author_blocked: false, drop_hidden: false };

/**
 * Authors whose identity changes what a recipient sees: those of drops in the
 * tree (root, quotes, reply targets) that are not publicly visible. Mirrors
 * the traversal and owner lookup in `applyGlobalModerationForRecipient`.
 */
function moderationRelevantAuthorIds(
  drop: ApiDrop,
  authorIdsByDropId: ReadonlyMap<string, string>
): Set<string> {
  const authors = new Set<string>();
  // Same path-scoped cycle guard as applyGlobalModerationForRecipient, so
  // both reach exactly the same nodes even when one id appears twice.
  const visit = (
    current: ApiDrop | ApiDropWithoutWave,
    path: ReadonlySet<string>
  ): void => {
    const status =
      current.moderation?.status ?? ApiDropModerationStatus.Visible;
    if (status !== ApiDropModerationStatus.Visible) {
      authors.add(authorIdsByDropId.get(current.id) ?? current.author.id);
    }
    if (path.has(current.id)) return;
    const nextPath = new Set(path).add(current.id);
    for (const part of current.parts) {
      if (part.quoted_drop?.drop) visit(part.quoted_drop.drop, nextPath);
    }
    if (current.reply_to?.drop) visit(current.reply_to.drop, nextPath);
  };
  visit(drop, new Set<string>());
  return authors;
}

/**
 * Returns the serialized frame for a recipient, building it once per
 * audience class. Everything recipient-specific in a drop frame is:
 * - whether the recipient authored a drop in the tree that is not publicly
 *   visible (moderation `can_view`),
 * - their `viewer_context`,
 * - their `credit_left` (participatory drops only).
 * Recipients that agree on all three get the identical string, so a chat
 * message to 1,000 sockets is usually serialized once.
 */
export function createDropPayloadSerializer({
  audienceDrop,
  hiddenDropIds,
  authorIdsByDropId,
  viewerContexts,
  creditLefts,
  updateType,
  reason,
  onSerialized
}: {
  audienceDrop: ApiDrop;
  hiddenDropIds: ReadonlySet<string>;
  authorIdsByDropId: ReadonlyMap<string, string>;
  viewerContexts: Readonly<Record<string, ApiDrop['viewer_context']>>;
  creditLefts: Readonly<Record<string, number>>;
  updateType: DropMessageType;
  reason?: string;
  onSerialized?: () => void;
}): (profileId: string | null) => string {
  const moderationAuthors = moderationRelevantAuthorIds(
    audienceDrop,
    authorIdsByDropId
  );
  const payloads = new Map<string, string>();
  return (profileId) => {
    const viewerContext =
      profileId === null
        ? DEFAULT_VIEWER_CONTEXT
        : (viewerContexts[profileId] ?? DEFAULT_VIEWER_CONTEXT);
    const creditLeft = profileId === null ? 0 : (creditLefts[profileId] ?? 0);
    const key = JSON.stringify([
      profileId !== null && moderationAuthors.has(profileId) ? profileId : null,
      viewerContext,
      creditLeft
    ]);
    const cached = payloads.get(key);
    if (cached !== undefined) return cached;
    const recipientDrop = applyGlobalModerationForRecipient(
      audienceDrop,
      profileId,
      authorIdsByDropId
    );
    recipientDrop.viewer_context = viewerContext;
    const payload = serializeDropMessageForRecipient(
      anonymizeDropBroadcast(recipientDrop, hiddenDropIds),
      creditLeft,
      updateType,
      reason
    );
    onSerialized?.();
    payloads.set(key, payload);
    return payload;
  };
}

export class WsListenersNotifier {
  private readonly logger: Logger = Logger.get(this.constructor.name);

  constructor(
    private readonly appWebSockets: AppWebSockets,
    private readonly wsConnectionRepository: WsConnectionRepository,
    private readonly moderationDb: Pick<
      ContentModerationDb,
      'getViewerContextsForDrop'
    > = contentModerationDb,
    private readonly fanoutQueue: WaveFanoutQueue = waveFanoutQueue
  ) {}

  async notifyAboutCompetitionUpdate(
    event: {
      event_id: string;
      event_version: number;
      event_type: string;
      occurred_at: number;
      wave_id: string;
      competition_id: string;
      competition_entry_id?: string;
      drop_id?: string;
    },
    visibilityGroupId: string | null,
    ctx: RequestContext
  ): Promise<void> {
    const recipients =
      await this.wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
        { waveId: event.wave_id, groupId: visibilityGroupId },
        ctx
      );
    // Send invalidation identity only; signed commands and private draft rules
    // must never become websocket payloads. Draft suppression is producer-owned.
    const message = JSON.stringify({
      type: WsMessageType.COMPETITION_UPDATE,
      data: {
        event_id: event.event_id,
        event_version: event.event_version,
        event_type: event.event_type,
        occurred_at: event.occurred_at,
        wave_id: event.wave_id,
        competition_id: event.competition_id,
        competition_entry_id: event.competition_entry_id,
        drop_id: event.drop_id
      }
    });
    await forEachConcurrent(
      recipients,
      async ({ connectionId, jwtExpiry }) => {
        await this.appWebSockets.send({ connectionId, jwtExpiry, message });
      },
      { concurrency: WS_SEND_CONCURRENCY_CAP }
    );
  }

  async notifyAboutIdentityNotificationsChanged(
    inputProfileIds: string[]
  ): Promise<void> {
    const profileIds = Array.from(
      new Set(inputProfileIds.filter((profileId) => !!profileId))
    );
    if (!profileIds.length) {
      return;
    }
    try {
      const recipients =
        await this.wsConnectionRepository.findNotificationConnectionIdsByIdentityIds(
          profileIds
        );
      await forEachConcurrent(
        recipients,
        async ({ connectionId, identityId, jwtExpiry }) => {
          await this.appWebSockets.send({
            connectionId,
            jwtExpiry,
            message: JSON.stringify(
              identityNotificationsChangedMessage(identityId)
            )
          });
        },
        { concurrency: WS_SEND_CONCURRENCY_CAP }
      );
    } catch (error) {
      this.logger.error(
        `Sending notification invalidations to websockets failed. Profile ids: ${profileIds.join(',')}`,
        error
      );
    }
  }

  async notifyAboutDmUnreadStateChanged(
    states: ApiDmUnreadConversationState[],
    resolvedRecipients?: readonly NotificationConnectionRecipient[]
  ): Promise<void> {
    const statesByProfileId = states.reduce((acc, state) => {
      const profileStates = acc.get(state.profile_id) ?? [];
      profileStates.push(state);
      acc.set(state.profile_id, profileStates);
      return acc;
    }, new Map<string, ApiDmUnreadConversationState[]>());
    if (!statesByProfileId.size) {
      return;
    }
    const profileIds = Array.from(statesByProfileId.keys());
    try {
      const recipients =
        resolvedRecipients ??
        (await this.wsConnectionRepository.findNotificationConnectionIdsByIdentityIds(
          profileIds
        ));
      await forEachConcurrent(
        recipients.flatMap(({ connectionId, identityId, jwtExpiry }) =>
          (statesByProfileId.get(identityId) ?? []).map((state) => ({
            connectionId,
            jwtExpiry,
            state
          }))
        ),
        async ({ connectionId, jwtExpiry, state }) => {
          await this.appWebSockets.send({
            connectionId,
            jwtExpiry,
            message: JSON.stringify(dmUnreadStateChangedMessage(state))
          });
        },
        { concurrency: WS_SEND_CONCURRENCY_CAP }
      );
    } catch (error) {
      this.logger.error(
        `Sending DM unread states to websockets failed. Profile ids: ${profileIds.join(',')}`,
        error
      );
    }
  }

  async findConnectedNotificationRecipients(
    inputProfileIds: string[]
  ): Promise<NotificationConnectionRecipient[]> {
    const profileIds = Array.from(
      new Set(inputProfileIds.filter((profileId) => !!profileId))
    );
    if (!profileIds.length) {
      return [];
    }
    try {
      return await this.wsConnectionRepository.findNotificationConnectionIdsByIdentityIds(
        profileIds
      );
    } catch (error) {
      this.logger.error(
        `Resolving DM unread websocket recipients failed. Profile ids: ${profileIds.join(',')}`,
        error
      );
      return [];
    }
  }

  async notifyAboutDropUpdate(
    inputDrop: ApiDrop,
    ctx: RequestContext,
    options: { reason?: string; useSystemBroadcastAudience?: boolean } = {}
  ): Promise<void> {
    await this.notifyDropMessage(
      inputDrop,
      ctx,
      WsMessageType.DROP_UPDATE,
      options
    );
  }

  async notifyAboutDropRatingUpdate(
    drop: ApiDrop,
    ctx: RequestContext
  ): Promise<void> {
    await this.notifyDropMessage(drop, ctx, WsMessageType.DROP_RATING_UPDATE);
  }

  async notifyAboutDropReactionUpdate(
    drop: ApiDrop,
    ctx: RequestContext
  ): Promise<void> {
    await this.notifyDropMessage(drop, ctx, WsMessageType.DROP_REACTION_UPDATE);
  }

  private async notifyDropMessage(
    inputDrop: ApiDrop,
    ctx: RequestContext,
    updateType: DropMessageType,
    {
      reason,
      useSystemBroadcastAudience = false
    }: {
      reason?: string;
      useSystemBroadcastAudience?: boolean;
    } = {}
  ): Promise<void> {
    const timerName = `${this.constructor.name}->${
      {
        [WsMessageType.DROP_UPDATE]: 'notifyAboutDrop',
        [WsMessageType.DROP_RATING_UPDATE]: 'notifyAboutDropRatingUpdate',
        [WsMessageType.DROP_REACTION_UPDATE]: 'notifyAboutDropReactionUpdate'
      }[updateType]
    }`;
    ctx.timer?.start(timerName);
    const serverReceivedAt = serverReceivedAtFromTimer(ctx.timer);
    const measurement = new FanoutMeasurement(updateType, serverReceivedAt);
    try {
      const onlineProfiles = useSystemBroadcastAudience
        ? await this.wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
            {
              groupId: inputDrop.wave.visibility_group_id,
              waveId: inputDrop.wave.id
            },
            ctx
          )
        : await this.wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIds(
            {
              groupId: inputDrop.wave.visibility_group_id,
              waveId: inputDrop.wave.id
            },
            ctx
          );
      measurement.queryDone(onlineProfiles.length);
      if (!onlineProfiles.length) return;
      const audienceDrop = await this.restrictQuotesToWaveAudience(
        inputDrop,
        ctx
      );
      const { hiddenDropIds, authorIdsByDropId } =
        await this.getBroadcastAnonymity(audienceDrop, ctx);
      const frames: DropFrames = {
        audienceDrop,
        hiddenDropIds,
        authorIdsByDropId,
        updateType,
        reason
      };
      const split = await this.splitForAsyncFanout(
        onlineProfiles,
        inputDrop.wave.id,
        ctx
      );
      if (!split) {
        await this.deliverDropFrames(
          frames,
          onlineProfiles,
          serverReceivedAt,
          measurement,
          ctx
        );
        return;
      }
      await this.deliverWithAsyncFanout(
        frames,
        split,
        serverReceivedAt,
        measurement,
        ctx
      );
    } catch (e) {
      logDropNotificationFailure(this.logger, updateType, inputDrop, e);
    } finally {
      ctx.timer?.stop(timerName);
      measurement.emit({
        drop_id: inputDrop.id,
        wave_id: inputDrop.wave?.id ?? null
      });
    }
  }

  /**
   * Waves 1.1: with `WS_ASYNC_FANOUT` on and an audience larger than the
   * inline budget, the request sends to at most `WS_INLINE_FANOUT_MAX`
   * recipients itself, open-wave viewers first, and queues the rest for the
   * wave fan-out worker. Returns null when everything goes inline.
   */
  private async splitForAsyncFanout(
    recipients: readonly WaveRecipient[],
    waveId: string,
    ctx: RequestContext
  ): Promise<AsyncFanoutSplit | null> {
    if (!isAsyncFanoutEnabled()) return null;
    const limit = inlineFanoutLimit();
    if (recipients.length <= limit) return null;
    // A tab with the wave open has a socket subscribed to it (the typing
    // socket today, the app socket from 1.4); its app socket is a viewer too.
    const viewingProfileIds =
      await this.wsConnectionRepository.findProfileIdsViewingWave(waveId, ctx);
    const isViewer = (recipient: WaveRecipient) =>
      recipient.wave_id === waveId ||
      (recipient.profileId !== null &&
        viewingProfileIds.has(recipient.profileId));
    const ordered = [
      ...recipients.filter(isViewer),
      ...recipients.filter((recipient) => !isViewer(recipient))
    ];
    return { inline: ordered.slice(0, limit), deferred: ordered.slice(limit) };
  }

  private async deliverWithAsyncFanout(
    frames: DropFrames,
    split: AsyncFanoutSplit,
    serverReceivedAt: number | null,
    measurement: FanoutMeasurement,
    ctx: RequestContext
  ): Promise<void> {
    const { jobs, unqueueable } = buildDropFramesJobs(
      {
        update_type: frames.updateType,
        ...(frames.reason === undefined ? {} : { reason: frames.reason }),
        server_received_at: serverReceivedAt,
        enqueued_at: Date.now(),
        drop: frames.audienceDrop,
        hidden_drop_ids: Array.from(frames.hiddenDropIds),
        author_ids_by_drop_id: Array.from(frames.authorIdsByDropId.entries())
      },
      split.deferred.map(({ connectionId, profileId, jwtExpiry }) => ({
        c: connectionId,
        p: profileId,
        e: jwtExpiry
      })),
      fanoutChunkSize()
    );
    // The inline sends and the hand-off run together; both are awaited.
    const enqueueStartedAt = Date.now();
    const [, rejected] = await Promise.all([
      this.deliverDropFrames(
        frames,
        split.inline,
        serverReceivedAt,
        measurement,
        ctx
      ),
      this.fanoutQueue.enqueue(jobs).then((notAccepted) => {
        const rejectedRecipients = notAccepted.reduce(
          (total, job) =>
            total + (job.kind === 'drop_frames' ? job.recipients.length : 0),
          0
        );
        measurement.handedOff(
          split.deferred.length - unqueueable.length - rejectedRecipients,
          Date.now() - enqueueStartedAt
        );
        return notAccepted;
      })
    ]);
    // Whatever the queue did not accept is sent here, never dropped.
    const fallback = [
      ...unqueueable,
      ...rejected.flatMap((job) =>
        job.kind === 'drop_frames' ? job.recipients : []
      )
    ];
    if (!fallback.length) return;
    measurement.fellBack(fallback.length);
    await this.deliverDropFrames(
      frames,
      fallback.map(queuedToRecipient),
      serverReceivedAt,
      measurement,
      ctx
    );
  }

  /**
   * Worker side of 1.1: sends one queued chunk. Payload inputs that depend
   * on the recipient (viewer context, credit left) are read here, once per
   * chunk. A failure before any send is rethrown so SQS retries the chunk;
   * once sends have started, failures are logged instead, because a retry
   * would repeat frames to recipients that already have them.
   */
  async deliverQueuedDropFrames(job: DropFramesJob): Promise<void> {
    const startedAt = Date.now();
    const measurement = new FanoutMeasurement(
      job.update_type,
      job.server_received_at,
      Date.now,
      'async'
    );
    measurement.queryDone(job.recipients.length);
    const frames: DropFrames = {
      audienceDrop: job.drop,
      hiddenDropIds: new Set(job.hidden_drop_ids),
      authorIdsByDropId: new Map(job.author_ids_by_drop_id),
      updateType: job.update_type,
      reason: job.reason
    };
    const recipients = job.recipients.map(queuedToRecipient);
    try {
      const sends = await this.prepareDropFrames(
        frames,
        recipients,
        measurement,
        {}
      );
      try {
        await this.sendToAll(sends, job.server_received_at, measurement);
      } catch (error) {
        logDropNotificationFailure(
          this.logger,
          `${job.update_type} queued chunk ${job.chunk}`,
          job.drop,
          error
        );
      }
    } finally {
      measurement.emit({
        drop_id: job.drop.id,
        wave_id: job.drop.wave?.id ?? null,
        chunk: job.chunk,
        queue_wait_ms: startedAt - job.enqueued_at
      });
    }
  }

  /** Reads per-recipient payload inputs once, then sends. */
  private async deliverDropFrames(
    frames: DropFrames,
    recipients: readonly WaveRecipient[],
    serverReceivedAt: number | null,
    measurement: FanoutMeasurement,
    ctx: RequestContext
  ): Promise<void> {
    const sends = await this.prepareDropFrames(
      frames,
      recipients,
      measurement,
      ctx
    );
    await this.sendToAll(sends, serverReceivedAt, measurement);
  }

  private async prepareDropFrames(
    frames: DropFrames,
    recipients: readonly WaveRecipient[],
    measurement: FanoutMeasurement,
    ctx: RequestContext
  ): Promise<FanoutSend[]> {
    const { audienceDrop, authorIdsByDropId } = frames;
    const creditLefts = await this.getCreditLeftsForOnlineProfiles(
      recipients,
      audienceDrop
    );
    const viewerContexts = await this.moderationDb.getViewerContextsForDrop(
      {
        dropId: audienceDrop.id,
        authorProfileId:
          authorIdsByDropId.get(audienceDrop.id) ?? audienceDrop.author.id,
        viewerProfileIds: recipients
          .map(({ profileId }) => profileId)
          .filter((profileId): profileId is string => profileId !== null)
      },
      ctx.connection
    );
    const payloadFor = createDropPayloadSerializer({
      ...frames,
      viewerContexts,
      creditLefts,
      onSerialized: () => measurement.serialized()
    });
    measurement.prepareDone();
    return recipients.map(({ connectionId, profileId, jwtExpiry }) => ({
      connectionId,
      jwtExpiry,
      message: () => payloadFor(profileId)
    }));
  }

  /**
   * Sends one frame per recipient through a capped pool. Post-send
   * bookkeeping and delivery metrics are batched for the whole fan-out and
   * awaited before this returns: nothing is left running after a response.
   */
  private async sendToAll(
    sends: Iterable<FanoutSend>,
    serverReceivedAt: number | null,
    measurement: FanoutMeasurement
  ): Promise<void> {
    const settlements: Promise<unknown>[] = [];
    const batch: DeliveryBatch = {
      defer: (settlement) => settlements.push(settlement),
      metrics: new DeliveryMetricsBatch()
    };
    try {
      await forEachConcurrent(
        sends,
        async (send) => {
          await this.sendMeasured(
            send.connectionId,
            send.message(),
            serverReceivedAt,
            measurement,
            send.jwtExpiry,
            batch
          );
        },
        { concurrency: WS_SEND_CONCURRENCY_CAP }
      );
    } finally {
      const settled = await Promise.allSettled(settlements);
      const failed = settled.filter(
        (result) => result.status === 'rejected'
      ).length;
      if (failed) {
        this.logger.warn({
          code: 'WS_DELIVERY_BOOKKEEPING_FAILED',
          failed,
          total: settled.length
        });
      }
      batch.metrics.flush();
    }
  }

  /** Stamps delivery times on the frame and records the send's outcome. */
  private async sendMeasured(
    connectionId: string,
    message: string,
    serverReceivedAt: number | null,
    measurement: FanoutMeasurement,
    jwtExpiry?: number,
    batch?: DeliveryBatch
  ): Promise<unknown> {
    const sentAt = Date.now();
    try {
      const result = await this.appWebSockets.send({
        connectionId,
        message: withDeliveryTimestamps(message, { serverReceivedAt, sentAt }),
        jwtExpiry,
        batch,
        onConnectionRead: () => measurement.connectionRead()
      });
      measurement.sendSettled(sentAt, sendOutcome(result));
      return result;
    } catch (error) {
      measurement.sendSettled(sentAt, 'error');
      throw error;
    }
  }

  async notifyAboutUserIsTyping({
    identityId,
    waveId
  }: {
    identityId: string;
    waveId: string;
  }) {
    let stage = 'identity';
    try {
      if (identityId === ANON_USER_ID) {
        throw new UnauthorisedException('Authentication required');
      }
      const identityEntity =
        await identitiesDb.getIdentityByProfileId(identityId);
      if (!identityEntity) {
        throw new UnauthorisedException('Authentication required');
      }
      stage = 'recipients';
      const recipients = await this.wsConnectionRepository
        .getCurrentlyOnlineCommunityMemberConnectionIds(
          { waveId, groupId: null },
          {
            authenticationContext:
              AuthenticationContext.fromProfileId(identityId)
          },
          // Typing rides on sockets subscribed to this wave, including the
          // typing-purpose socket that is left out of every other frame.
          { includeTypingSockets: true }
        )
        .then((res) => res.filter((it) => it.wave_id === waveId));
      // Group metadata visibility alone is insufficient: the sender must also
      // be in the current child/parent membership intersection on this wave.
      if (!recipients.some((it) => it.profileId === identityId)) {
        throw new NotFoundException('Wave not found');
      }
      const connectionIds = recipients.map((it) => it.connectionId);
      stage = 'profile_enrichment';
      const [
        mainStageSubscriptions,
        mainStageWins,
        artistOfPrevoteCards,
        waveCreatorIds,
        profileWaveIds
      ] = await Promise.all([
        identitiesDb.getActiveMainStageDropIds([identityId], {}),
        identitiesDb.getMainStageWinnerDropIds([identityId], {}),
        identitiesDb.getArtistOfPrevoteCards([identityId], {}),
        identitiesDb.getWaveCreatorProfileIds([identityId]),
        profileWavesDb.findProfileWaveIdsByProfileIds([identityId], {})
      ]);
      const profile: Omit<ApiProfileMin, 'subscribed_actions'> = {
        id: identityId,
        handle: identityEntity.handle!,
        pfp: identityEntity.pfp,
        banner1_color: identityEntity.banner1,
        banner2_color: identityEntity.banner2,
        cic: identityEntity.cic,
        rep: identityEntity.rep,
        tdh: identityEntity.tdh,
        tdh_rate: identityEntity.basetdh_rate,
        xtdh: identityEntity.xtdh,
        xtdh_rate: identityEntity.xtdh_rate,
        level: getLevelFromScore(identityEntity.level_raw),
        classification: identityEntity.classification
          ? (enums.resolve(
              ApiProfileClassification,
              identityEntity.classification as string
            ) ?? ApiProfileClassification.Pseudonym)
          : ApiProfileClassification.Pseudonym,
        sub_classification: identityEntity.sub_classification,
        archived: false,
        primary_address: identityEntity.primary_address,
        profile_wave_id: profileWaveIds[identityId] ?? null,
        active_main_stage_submission_ids:
          mainStageSubscriptions[identityId] ?? [],
        winner_main_stage_drop_ids: mainStageWins[identityId] ?? [],
        artist_of_prevote_cards: artistOfPrevoteCards[identityId] ?? [],
        is_wave_creator: waveCreatorIds.has(identityId)
      };
      const now = Time.currentMillis();
      stage = 'delivery';
      await Promise.all(
        connectionIds.map((connectionId: string) =>
          this.appWebSockets.send({
            connectionId,
            message: JSON.stringify(
              userIsTypingMessage({
                wave_id: waveId,
                timestamp: now,
                profile: profile
              })
            )
          })
        )
      );
    } catch (error) {
      if (!isExpectedClientError(error)) {
        try {
          this.logger.error({
            code: 'WS_TYPING_FAILED',
            stage,
            ...typingFailureDetails(error)
          });
        } catch {
          // Diagnostic failure must not replace the original operation error.
        }
      }
      throw error;
    }
  }

  private async getBroadcastAnonymity(drop: ApiDrop, ctx: RequestContext) {
    const hiddenDropIds = await competitionAnonymityService.hiddenDropIds(
      getEmbeddedDropIds(drop),
      ctx,
      { includeOwner: true }
    );
    // API mappers may already have hidden an author's public projection. Keep
    // real ownership in a separate map used only for moderation decisions.
    const hiddenDrops = hiddenDropIds.size
      ? await dropsDb.getDropsByIds(Array.from(hiddenDropIds), ctx.connection)
      : [];
    return {
      hiddenDropIds,
      authorIdsByDropId: new Map(
        hiddenDrops.map((entity) => [entity.id, entity.author_id])
      )
    };
  }

  private async restrictQuotesToWaveAudience(
    inputDrop: ApiDrop,
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const quotedDropIds = getQuotedDropIds(inputDrop);
    if (!quotedDropIds.length) {
      return inputDrop;
    }
    const visibleQuotedDropIds =
      await this.wsConnectionRepository.findDropIdsReadableByWaveAudience(
        { waveId: inputDrop.wave.id, dropIds: quotedDropIds },
        ctx
      );
    return redactQuotedDropsOutsideAudience(inputDrop, visibleQuotedDropIds);
  }

  private async getCreditLeftsForOnlineProfiles(
    onlineProfiles: readonly {
      connectionId: string;
      profileId: string | null;
    }[],
    inputDrop: ApiDrop
  ) {
    const profileIds = onlineProfiles
      .map((p) => p.profileId)
      .filter((it) => !!it) as string[];
    let creditLefts: Record<string, number> = {};
    if (inputDrop.drop_type === ApiDropType.Participatory) {
      if (inputDrop.wave.voting_credit_type === ApiWaveCreditType.Rep) {
        creditLefts =
          await this.wsConnectionRepository.getCreditLeftForProfilesForRepBasedWave(
            {
              profileIds,
              waveId: inputDrop.wave.id,
              dropId: inputDrop.id
            }
          );
      } else {
        creditLefts =
          await this.wsConnectionRepository.getCreditLeftForProfilesForTdhBasedWave(
            { waveId: inputDrop.wave.id, dropId: inputDrop.id, profileIds }
          );
      }
    }
    return creditLefts;
  }

  async notifyAboutDropDelete(
    dropInfo: { drop_id: string; wave_id: string; drop_serial: number },
    visibility_group_id: string | null,
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->notifyAboutDropDelete`);
    await this.notifyAboutDropDeletes([dropInfo], visibility_group_id, ctx);
    ctx.timer?.stop(`${this.constructor.name}->notifyAboutDropDelete`);
  }

  async notifyAboutDropDeletes(
    dropInfos: readonly {
      drop_id: string;
      wave_id: string;
      drop_serial: number;
    }[],
    visibility_group_id: string | null,
    ctx: RequestContext
  ): Promise<void> {
    if (!dropInfos.length) {
      return;
    }
    const firstDrop = dropInfos[0];
    const timerName = `${this.constructor.name}->notifyAboutDropDeletes`;
    ctx.timer?.start(timerName);
    const serverReceivedAt = serverReceivedAtFromTimer(ctx.timer);
    const measurement = new FanoutMeasurement(
      WsMessageType.DROP_DELETE,
      serverReceivedAt
    );
    try {
      const onlineClients =
        await this.wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIds(
          {
            groupId: visibility_group_id,
            waveId: firstDrop.wave_id
          },
          ctx
        );
      measurement.queryDone(onlineClients.length * dropInfos.length);
      measurement.prepareDone();
      const messages = dropInfos.map((dropInfo) => {
        measurement.serialized();
        return JSON.stringify(dropDeleteMessage(dropInfo));
      });
      // Deletions go out in order, each to every listener; a failed send
      // does not stop later ones, and the first failure is rethrown.
      await this.sendToAll(
        messages.flatMap((message) =>
          onlineClients.map(({ connectionId, jwtExpiry }) => ({
            connectionId,
            jwtExpiry,
            message: () => message
          }))
        ),
        serverReceivedAt,
        measurement
      );
    } finally {
      ctx.timer?.stop(timerName);
      measurement.emit({
        drop_id: dropInfos.length === 1 ? firstDrop.drop_id : null,
        wave_id: firstDrop.wave_id
      });
    }
  }

  async notifyAboutAttachmentStatusUpdate(
    {
      attachment,
      ownerProfileId,
      waveIds
    }: {
      attachment: ApiAttachment;
      ownerProfileId: string;
      waveIds: string[];
    },
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(
      `${this.constructor.name}->notifyAboutAttachmentStatusUpdate`
    );
    const message = JSON.stringify(attachmentStatusUpdateMessage(attachment));
    try {
      const ownerConnectionIds =
        await this.wsConnectionRepository.findConnectionIdsByIdentityId(
          ownerProfileId
        );
      const waveConnectionIdLists = await Promise.all(
        Array.from(new Set(waveIds.filter((it) => !!it))).map(
          async (waveId) => {
            const groupId =
              await this.wsConnectionRepository.findWaveVisibilityGroupId(
                waveId
              );
            if (groupId === undefined) {
              return [];
            }
            return await this.wsConnectionRepository
              .getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
                {
                  groupId,
                  waveId
                },
                ctx
              )
              .then((rows) => rows.map((it) => it.connectionId));
          }
        )
      );
      const uniqueConnectionIds = Array.from(
        new Set([...ownerConnectionIds, ...waveConnectionIdLists.flat()])
      );
      if (!uniqueConnectionIds.length) {
        return;
      }
      await Promise.all(
        uniqueConnectionIds.map((connectionId: string) =>
          this.appWebSockets.send({
            connectionId,
            message
          })
        )
      );
    } catch (e) {
      this.logger.error(
        `Sending attachment status update to websockets failed. Params: ${message}`,
        e
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->notifyAboutAttachmentStatusUpdate`
      );
    }
  }

  async notifyAboutNftLinkUpdate(
    nftLinkData: ApiNftLinkData,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->notifyAboutNftLinkUpdate`);
    const message = JSON.stringify(nftLinkUpdatedMessage(nftLinkData));
    try {
      const connections =
        await this.wsConnectionRepository.findAllConnectionIds();
      if (connections.length) {
        await Promise.all(
          connections.map((connectionId: string) =>
            this.appWebSockets.send({
              connectionId,
              message
            })
          )
        );
      }
    } catch (e) {
      this.logger.error(
        `Sending data to websockets failed. Params: ${message}`,
        e
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->notifyAboutNftLinkUpdate`);
    }
  }
}

export const wsListenersNotifier = new WsListenersNotifier(
  appWebSockets,
  wsConnectionRepository
);
