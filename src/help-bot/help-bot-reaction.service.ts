import { reactionsDb, ReactionsDb } from '@/api/drops/reactions.db';
import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';
import { RequestContext } from '@/request.context';

export class HelpBotReactionService {
  constructor(
    private readonly reactionsDb: ReactionsDb,
    private readonly dropsService: DropsApiService,
    private readonly wsListenersNotifier: WsListenersNotifier
  ) {}

  public async setReaction(
    {
      botProfileId,
      dropId,
      waveId,
      reaction
    }: {
      readonly botProfileId: string;
      readonly dropId: string;
      readonly waveId: string;
      readonly reaction: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    const changed = await this.reactionsDb.addReaction(
      botProfileId,
      dropId,
      waveId,
      reaction,
      ctx
    );
    if (!changed) {
      return;
    }

    const drop = await this.dropsService.findDropByIdOrThrow(
      {
        dropId,
        skipEligibilityCheck: true
      },
      ctx
    );
    await this.wsListenersNotifier.notifyAboutDropReactionUpdate(drop, ctx);
  }
}

export const helpBotReactionService = new HelpBotReactionService(
  reactionsDb,
  dropsService,
  wsListenersNotifier
);
