import { ProfileProxyEntity } from '../../../entities/IProfileProxy';
import {
  ProfileProxyActionEntity,
  ProfileProxyActionType
} from '../../../entities/IProfileProxyAction';
import { ApiProfileProxyActionType } from '../generated/models/ApiProfileProxyActionType';
import { ApiProfileProxy } from '../generated/models/ApiProfileProxy';
import { AuthenticationContext } from '../../../auth-context';
import {
  IdentityFetcher,
  identityFetcher
} from '../identities/identity.fetcher';
import { collections } from '../../../collections';

const ACTION_MAP: Record<ProfileProxyActionType, ApiProfileProxyActionType> = {
  [ProfileProxyActionType.ALLOCATE_REP]: ApiProfileProxyActionType.AllocateRep,
  [ProfileProxyActionType.ALLOCATE_CIC]: ApiProfileProxyActionType.AllocateCic,
  [ProfileProxyActionType.CREATE_WAVE]: ApiProfileProxyActionType.CreateWave,
  [ProfileProxyActionType.READ_WAVE]: ApiProfileProxyActionType.ReadWave,
  [ProfileProxyActionType.CREATE_DROP_TO_WAVE]:
    ApiProfileProxyActionType.CreateDropToWave,
  [ProfileProxyActionType.RATE_WAVE_DROP]:
    ApiProfileProxyActionType.RateWaveDrop
};

export class ProfileProxiesMapper {
  constructor(private readonly identityFetcher: IdentityFetcher) {}

  public async profileProxyEntitiesToApiProfileProxies(
    {
      profileProxyEntities,
      actions
    }: {
      readonly profileProxyEntities: ProfileProxyEntity[];
      readonly actions: ProfileProxyActionEntity[];
    },
    authenticatedProfileId?: string
  ): Promise<ApiProfileProxy[]> {
    const profileIds = collections.distinct(
      profileProxyEntities.flatMap((entity) => [
        entity.target_id,
        entity.created_by
      ])
    );
    const profileMins = await this.identityFetcher.getOverviewsByIds(
      profileIds,
      {
        authenticationContext: authenticatedProfileId
          ? AuthenticationContext.fromProfileId(authenticatedProfileId)
          : AuthenticationContext.notAuthenticated()
      }
    );

    return profileProxyEntities.map<ApiProfileProxy>((entity) => ({
      id: entity.id,
      granted_to: profileMins[entity.target_id],
      created_by: profileMins[entity.created_by],
      created_at: entity.created_at,
      actions: actions
        .filter((action) => action.proxy_id === entity.id)
        .map((action) => ({
          ...action,
          action_type: ACTION_MAP[action.action_type]
        }))
    }));
  }
}

export const profileProxiesMapper = new ProfileProxiesMapper(identityFetcher);
