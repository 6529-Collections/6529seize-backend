import { ApiDrop } from '../generated/models/ApiDrop';
import { appWebSockets, AppWebSockets } from './ws';
import {
  wsConnectionRepository,
  WsConnectionRepository
} from './ws-connection.repository';
import { RequestContext } from '../../../request.context';
import { dropDeleteMessage, dropUpdateMessage } from './ws-message';
import { ApiDropWithoutWave } from '../generated/models/ApiDropWithoutWave';
import { ApiDropType } from '../generated/models/ApiDropType';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { Logger } from '../../../logging';

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
          inputDrop.wave.visibility_group_id,
          ctx
        );
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
      await Promise.all(
        onlineProfiles.map(({ connectionId, profileId }) =>
          this.appWebSockets.send({
            connectionId,
            message: JSON.stringify(
              dropUpdateMessage(
                this.removeDropsAuthRequestContext(
                  inputDrop,
                  profileId === null ? 0 : creditLefts[profileId] ?? 0
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

  async notifyAboutDropDelete(
    dropInfo: { drop_id: string; wave_id: string; drop_serial: number },
    visibility_group_id: string | null,
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->notifyAboutDropDelete`);
    const onlineClients =
      await this.wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIds(
        visibility_group_id,
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
      (modifiedWave as any).credit_left = creditLeft;
      (modifiedDrop.wave as any) = modifiedWave;
      (modifiedDrop.author as any).subscribed_actions = undefined;
      (modifiedDrop as any).context_profile_context = undefined;
    }
    for (const part of modifiedDrop.parts) {
      delete part.context_profile_context;
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
}

export const wsListenersNotifier = new WsListenersNotifier(
  appWebSockets,
  wsConnectionRepository
);
