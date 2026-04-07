import { ForbiddenException, NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { ApiSetProfileWaveRequest } from '@/api/generated/models/ApiSetProfileWaveRequest';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { identityFetcher } from '@/api/identities/identity.fetcher';

export class ProfileWavesApiService {
  public async setProfileWave(
    identityKey: string,
    request: ApiSetProfileWaveRequest,
    ctx: RequestContext
  ): Promise<ApiIdentity> {
    return await profileWavesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx = { ...ctx, connection };
        const profileId = await this.assertCanManageProfileWave(
          identityKey,
          txCtx
        );
        const wave = await wavesApiDb.findWaveById(request.wave_id, connection);
        if (!wave) {
          throw new NotFoundException(`Wave ${request.wave_id} not found`);
        }
        if (wave.is_direct_message) {
          throw new ForbiddenException(
            `Direct message waves cannot be profile waves`
          );
        }
        if (wave.visibility_group_id !== null) {
          throw new ForbiddenException(`Profile wave must be public`);
        }
        if (wave.created_by !== profileId) {
          throw new ForbiddenException(
            `You can only select a wave you created as your profile wave`
          );
        }
        await profileWavesDb.setProfileWave(
          {
            profileId,
            waveId: wave.id
          },
          txCtx
        );
        return await this.getIdentityOrThrow(profileId, txCtx);
      }
    );
  }

  public async clearProfileWave(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiIdentity> {
    return await profileWavesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx = { ...ctx, connection };
        const profileId = await this.assertCanManageProfileWave(
          identityKey,
          txCtx
        );
        await profileWavesDb.deleteByProfileId(profileId, txCtx);
        return await this.getIdentityOrThrow(profileId, txCtx);
      }
    );
  }

  private async assertCanManageProfileWave(
    identityKey: string,
    ctx: RequestContext
  ): Promise<string> {
    const authenticationContext = ctx.authenticationContext;
    if (!authenticationContext?.isUserFullyAuthenticated()) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies cannot change profile waves`);
    }
    const actingProfileId = authenticationContext.getActingAsId();
    if (!actingProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const targetProfileId =
      await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey },
        ctx
      );
    if (targetProfileId !== actingProfileId) {
      throw new ForbiddenException(`You can only change your own profile wave`);
    }
    return actingProfileId;
  }

  private async getIdentityOrThrow(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiIdentity> {
    const identity =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey },
        ctx
      );
    if (!identity) {
      throw new NotFoundException(`Identity ${identityKey} not found`);
    }
    return identity;
  }
}

export const profileWavesApiService = new ProfileWavesApiService();
