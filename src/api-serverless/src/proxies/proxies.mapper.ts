import { ProfileProxyEntity } from '../../../entities/IProfileProxy';
import {
  ApiProfileProxyActionType,
  ProfileProxyActionEntity
} from '../../../entities/IProfileProxyAction';
import { distinct } from '../../../helpers';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import { ProfileProxyActionType } from '../generated/models/ProfileProxyActionType';
import { ProfileMin } from '../generated/models/ProfileMin';
import { ProfileProxy } from '../generated/models/ProfileProxy';

const ACTION_MAP: Record<ApiProfileProxyActionType, ProfileProxyActionType> = {
  [ApiProfileProxyActionType.ALLOCATE_REP]: ProfileProxyActionType.AllocateRep,
  [ApiProfileProxyActionType.ALLOCATE_CIC]: ProfileProxyActionType.AllocateCic,
  [ApiProfileProxyActionType.CREATE_WAVE]: ProfileProxyActionType.CreateWave,
  [ApiProfileProxyActionType.READ_WAVE]: ProfileProxyActionType.ReadWave,
  [ApiProfileProxyActionType.CREATE_DROP_TO_WAVE]:
    ProfileProxyActionType.CreateDropToWave,
  [ApiProfileProxyActionType.RATE_WAVE_DROP]:
    ProfileProxyActionType.RateWaveDrop
};

export class ProfileProxiesMapper {
  constructor(private readonly profilesService: ProfilesService) {}

  public async profileProxyEntitiesToApiProfileProxies({
    profileProxyEntities,
    actions
  }: {
    readonly profileProxyEntities: ProfileProxyEntity[];
    readonly actions: ProfileProxyActionEntity[];
  }): Promise<ProfileProxy[]> {
    const profileIds = distinct(
      profileProxyEntities.flatMap((entity) => [
        entity.target_id,
        entity.created_by
      ])
    );

    const profileMins: Record<string, ProfileMin> = await this.profilesService
      .getProfileMinsByIds(profileIds)
      .then((profileMins) =>
        profileMins.reduce((acc, profileMin) => {
          acc[profileMin.id] = {
            ...profileMin
          };
          return acc;
        }, {} as Record<string, ProfileMin>)
      );

    return profileProxyEntities.map<ProfileProxy>((entity) => ({
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

export const profileProxiesMapper = new ProfileProxiesMapper(profilesService);
