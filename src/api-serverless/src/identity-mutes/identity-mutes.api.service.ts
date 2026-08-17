import {
  identityMutesDb,
  IdentityMutesDb
} from '@/api/identity-mutes/identity-mutes.db';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import { ApiIdentityMuteState } from '@/api/generated/models/ApiIdentityMuteState';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { Logger } from '@/logging';
import { DbPoolName } from '@/db-query.options';
import {
  wavesApiDb as defaultWavesApiDb,
  WavesApiDb
} from '@/api/waves/waves.api.db';
import {
  wsListenersNotifier as defaultWsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';

const DM_UNREAD_SYNC_PAGE_SIZE = 500;

export class IdentityMutesApiService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly identityMutesDb: IdentityMutesDb,
    private readonly identityFetcher: IdentityFetcher,
    private readonly wavesApiDb: WavesApiDb = defaultWavesApiDb,
    private readonly wsListenersNotifier: WsListenersNotifier = defaultWsListenersNotifier
  ) {}

  async getIdentityMuteState(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiIdentityMuteState> {
    const pair = await this.resolveIdentityMutePair(identityKey, ctx);
    return {
      muted: await this.identityMutesDb.isIdentityMuted(pair, ctx.connection)
    };
  }

  async muteIdentity(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiIdentityMuteState> {
    const pair = await this.resolveIdentityMutePair(identityKey, ctx);
    await this.identityMutesDb.muteIdentity(pair, ctx);
    await this.synchronizeDmUnreadStatesBestEffort(pair, ctx);
    return { muted: true };
  }

  async unmuteIdentity(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiIdentityMuteState> {
    const pair = await this.resolveIdentityMutePair(identityKey, ctx);
    await this.identityMutesDb.unmuteIdentity(pair, ctx);
    await this.synchronizeDmUnreadStatesBestEffort(pair, ctx);
    return { muted: false };
  }

  private async synchronizeDmUnreadStatesBestEffort(
    pair: { muter_id: string; muted_identity_id: string },
    ctx: RequestContext
  ): Promise<void> {
    try {
      let afterWaveId: string | undefined;
      let hasMore = true;
      while (hasMore) {
        const waveIds =
          await this.wavesApiDb.findDmWaveIdsForReaderWithDropsByAuthor(
            {
              readerId: pair.muter_id,
              authorId: pair.muted_identity_id,
              limit: DM_UNREAD_SYNC_PAGE_SIZE,
              ...(afterWaveId ? { afterWaveId } : {})
            },
            ctx
          );
        if (!waveIds.length) {
          return;
        }
        await this.wavesApiDb.incrementDmUnreadStateVersionsForReaderWaves(
          { readerId: pair.muter_id, waveIds },
          ctx
        );
        const states = await this.wavesApiDb.findDmUnreadConversationStates(
          { identityId: pair.muter_id, waveIds },
          ctx,
          DbPoolName.WRITE
        );
        await this.wsListenersNotifier.notifyAboutDmUnreadStateChanged(states);
        afterWaveId = waveIds[waveIds.length - 1];
        hasMore = waveIds.length === DM_UNREAD_SYNC_PAGE_SIZE;
      }
    } catch (error) {
      this.logger.warn(
        'Failed to synchronize DM unread state after identity mute change',
        { pair, error }
      );
    }
  }

  private async resolveIdentityMutePair(
    identityKey: string,
    ctx: RequestContext
  ) {
    const muterId = ctx.authenticationContext?.getActingAsId();
    if (!muterId) {
      throw new ForbiddenException(`Please create a profile first`);
    }

    const mutedIdentityId =
      await this.identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey },
        ctx
      );
    if (muterId === mutedIdentityId) {
      throw new BadRequestException(`You can't mute your own profile`);
    }
    return { muter_id: muterId, muted_identity_id: mutedIdentityId };
  }
}

export const identityMutesApiService = new IdentityMutesApiService(
  identityMutesDb,
  identityFetcher,
  defaultWavesApiDb,
  defaultWsListenersNotifier
);
