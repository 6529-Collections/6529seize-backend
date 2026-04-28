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
  nftLinkUpdatedMessage,
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

export class WsListenersNotifier {
  private readonly logger: Logger = Logger.get(this.constructor.name);

  constructor(
    private readonly appWebSockets: AppWebSockets,
    private readonly wsConnectionRepository: WsConnectionRepository
  ) {}

  async notifyAboutDropUpdate(
    inputDrop: ApiDrop,
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->notifyAboutDrop`);
    try {
      const onlineProfiles =
        await this.wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIds(
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
            message: JSON.stringify(
              dropUpdateMessage(
                this.removeDropsAuthRequestContext(
                  inputDrop,
                  profileId === null ? 0 : (creditLefts[profileId] ?? 0)
                )
              )
            )
          })
        )
      );
    } catch (e) {
      this.logger.error(
        `Sending data to websockets failed. Params: ${JSON.stringify(
          inputDrop
        )}. Error: ${JSON.stringify(e)}`
      );
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
            message: JSON.stringify(
              dropRatingUpdateMessage(
                this.removeDropsAuthRequestContext(
                  drop,
                  profileId === null ? 0 : (creditLefts[profileId] ?? 0)
                )
              )
            )
          })
        )
      );
    } catch (e) {
      this.logger.error(
        `Sending data to websockets failed. Params: ${JSON.stringify(
          drop
        )}. Error: ${JSON.stringify(e)}`
      );
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
            message: JSON.stringify(
              dropReactionUpdateMessage(
                this.removeDropsAuthRequestContext(
                  drop,
                  profileId === null ? 0 : (creditLefts[profileId] ?? 0)
                )
              )
            )
          })
        )
      );
    } catch (e) {
      this.logger.error(
        `Sending data to websockets failed. Params: ${JSON.stringify(
          drop
        )}. Error: ${JSON.stringify(e)}`
      );
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
              waveId: inputDrop.wave.id
            }
          );
      } else {
        creditLefts =
          await this.wsConnectionRepository.getCreditLeftForProfilesForTdhBasedWave(
            { waveId: inputDrop.wave.id, profileIds }
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

  private removeDropsAuthRequestContext(
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
    for (const part of modifiedDrop.parts) {
      if (part.quoted_drop?.drop) {
        part.quoted_drop.drop = this.removeDropsAuthRequestContext(
          part.quoted_drop.drop,
          creditLeft
        );
      }
    }
    if (modifiedDrop.reply_to?.drop) {
      modifiedDrop.reply_to.drop = this.removeDropsAuthRequestContext(
        modifiedDrop.reply_to.drop,
        creditLeft
      );
    }
    return modifiedDrop;
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
              .getCurrentlyOnlineCommunityMemberConnectionIds(
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
