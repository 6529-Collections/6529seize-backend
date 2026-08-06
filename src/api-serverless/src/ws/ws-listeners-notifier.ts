import { ApiDrop } from '../generated/models/ApiDrop';
import { appWebSockets, AppWebSockets } from './ws';
import {
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
  DROP_UPDATE_MAX_UTF8_BYTES,
  DropUpdateRefType,
  WsMessageType,
  nftLinkUpdatedMessage,
  identityNotificationsChangedMessage,
  userIsTypingMessage
} from './ws-message';
import { ApiDropWithoutWave } from '../generated/models/ApiDropWithoutWave';
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
import { ApiDmUnreadConversationState } from '@/api/generated/models/ApiDmUnreadConversationState';

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

  if (Buffer.byteLength(fullMessage, 'utf8') <= DROP_UPDATE_MAX_UTF8_BYTES) {
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

export class WsListenersNotifier {
  private readonly logger: Logger = Logger.get(this.constructor.name);

  constructor(
    private readonly appWebSockets: AppWebSockets,
    private readonly wsConnectionRepository: WsConnectionRepository
  ) {}

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
      await Promise.all(
        recipients.map(({ connectionId, identityId }) =>
          this.appWebSockets.send({
            connectionId,
            message: JSON.stringify(
              identityNotificationsChangedMessage(identityId)
            )
          })
        )
      );
    } catch (error) {
      this.logger.error(
        `Sending notification invalidations to websockets failed. Profile ids: ${profileIds.join(',')}`,
        error
      );
    }
  }

  async notifyAboutDmUnreadStateChanged(
    states: ApiDmUnreadConversationState[]
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
        await this.wsConnectionRepository.findNotificationConnectionIdsByIdentityIds(
          profileIds
        );
      await Promise.all(
        recipients.flatMap(({ connectionId, identityId }) =>
          (statesByProfileId.get(identityId) ?? []).map((state) =>
            this.appWebSockets.send({
              connectionId,
              message: JSON.stringify(dmUnreadStateChangedMessage(state))
            })
          )
        )
      );
    } catch (error) {
      this.logger.error(
        `Sending DM unread states to websockets failed. Profile ids: ${profileIds.join(',')}`,
        error
      );
    }
  }

  async notifyAboutDropUpdate(
    inputDrop: ApiDrop,
    ctx: RequestContext,
    {
      reason,
      useSystemBroadcastAudience = false
    }: { reason?: string; useSystemBroadcastAudience?: boolean } = {}
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->notifyAboutDrop`);
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

      const creditLefts = await this.getCreditLeftsForOnlineProfiles(
        onlineProfiles,
        inputDrop
      );
      await Promise.all(
        onlineProfiles.map(({ connectionId, profileId }) =>
          this.appWebSockets.send({
            connectionId,
            message: serializeDropUpdateForRecipient(
              inputDrop,
              profileId === null ? 0 : (creditLefts[profileId] ?? 0),
              reason
            )
          })
        )
      );
    } catch (e) {
      logDropNotificationFailure(this.logger, 'DROP_UPDATE', inputDrop, e);
    }

    ctx.timer?.stop(`${this.constructor.name}->notifyAboutDrop`);
  }

  async notifyAboutDropRatingUpdate(
    drop: ApiDrop,
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->notifyAboutDropRatingUpdate`);
    try {
      const onlineProfiles =
        await this.wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIds(
          {
            groupId: drop.wave.visibility_group_id,
            waveId: drop.wave.id
          },
          ctx
        );
      const creditLefts = await this.getCreditLeftsForOnlineProfiles(
        onlineProfiles,
        drop
      );
      await Promise.all(
        onlineProfiles.map(({ connectionId, profileId }) =>
          this.appWebSockets.send({
            connectionId,
            message: serializeDropRatingUpdateForRecipient(
              drop,
              profileId === null ? 0 : (creditLefts[profileId] ?? 0)
            )
          })
        )
      );
    } catch (e) {
      logDropNotificationFailure(this.logger, 'DROP_RATING_UPDATE', drop, e);
    }

    ctx.timer?.stop(`${this.constructor.name}->notifyAboutDropRatingUpdate`);
  }

  async notifyAboutDropReactionUpdate(
    drop: ApiDrop,
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->notifyAboutDropReactionUpdate`);
    try {
      const onlineProfiles =
        await this.wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIds(
          {
            groupId: drop.wave.visibility_group_id,
            waveId: drop.wave.id
          },
          ctx
        );
      const creditLefts = await this.getCreditLeftsForOnlineProfiles(
        onlineProfiles,
        drop
      );
      await Promise.all(
        onlineProfiles.map(({ connectionId, profileId }) =>
          this.appWebSockets.send({
            connectionId,
            message: serializeDropReactionUpdateForRecipient(
              drop,
              profileId === null ? 0 : (creditLefts[profileId] ?? 0)
            )
          })
        )
      );
    } catch (e) {
      logDropNotificationFailure(this.logger, 'DROP_REACTION_UPDATE', drop, e);
    }
  }

  async notifyAboutUserIsTyping({
    identityId,
    waveId
  }: {
    identityId: string;
    waveId: string;
  }) {
    const connectionIds = await this.wsConnectionRepository
      .findAllByWaveId(waveId)
      .then((res) => res.map((it) => it.connection_id));
    if (!connectionIds.length) {
      return;
    }
    const identityEntity =
      await identitiesDb.getIdentityByProfileId(identityId);
    if (!identityEntity) {
      return;
    }
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
  }

  private async getCreditLeftsForOnlineProfiles(
    onlineProfiles: { connectionId: string; profileId: string | null }[],
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
    const onlineClients =
      await this.wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIds(
        {
          groupId: visibility_group_id,
          waveId: dropInfo.wave_id
        },
        ctx
      );
    const connectionIds = onlineClients.map((it) => it.connectionId);
    const message = JSON.stringify(dropDeleteMessage(dropInfo));
    await Promise.all(
      connectionIds.map((connectionId: string) =>
        this.appWebSockets.send({ connectionId, message })
      )
    );
    ctx.timer?.stop(`${this.constructor.name}->notifyAboutDropDelete`);
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
