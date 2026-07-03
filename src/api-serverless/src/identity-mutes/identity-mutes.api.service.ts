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

export class IdentityMutesApiService {
  constructor(
    private readonly identityMutesDb: IdentityMutesDb,
    private readonly identityFetcher: IdentityFetcher
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
    return { muted: true };
  }

  async unmuteIdentity(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiIdentityMuteState> {
    const pair = await this.resolveIdentityMutePair(identityKey, ctx);
    await this.identityMutesDb.unmuteIdentity(pair, ctx);
    return { muted: false };
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
  identityFetcher
);
