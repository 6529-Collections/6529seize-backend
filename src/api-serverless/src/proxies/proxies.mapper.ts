import { ProfileProxyEntity } from '../../../entities/IProfileProxy';
import {
  ProfileProxyActionEntity,
  ProfileProxyActionType
} from '../../../entities/IProfileProxyAction';
import { distinct } from '../../../helpers';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import { CreateNewProfileProxyActionType } from '../generated/models/CreateNewProfileProxyActionType';
import { ProfileMin } from '../generated/models/ProfileMin';
import { ProfileProxy } from '../generated/models/ProfileProxy';

const ACTION_MAP: Record<
  ProfileProxyActionType,
  CreateNewProfileProxyActionType
> = {
  [ProfileProxyActionType.ALLOCATE_REP]:
    CreateNewProfileProxyActionType.AllocateRep,
  [ProfileProxyActionType.ALLOCATE_CIC]:
    CreateNewProfileProxyActionType.AllocateCic,
  [ProfileProxyActionType.CREATE_WAVE]:
    CreateNewProfileProxyActionType.CreateWave,
  [ProfileProxyActionType.READ_WAVE]: CreateNewProfileProxyActionType.ReadWave,
  [ProfileProxyActionType.CREATE_DROP_TO_WAVE]:
    CreateNewProfileProxyActionType.CreateDropToWave,
  [ProfileProxyActionType.RATE_WAVE_DROP]:
    CreateNewProfileProxyActionType.RateWaveDrop
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

    return profileProxyEntities
      .map<ProfileProxy>((entity) => ({
        id: entity.id,
        granted_to: profileMins[entity.target_id],
        created_by: profileMins[entity.created_by],
        created_at: entity.created_at,
        actions: actions
          .filter((action) => action.proxy_id === entity.id)
          .map((action) => ({
            id: action.id,
            proxy_id: action.proxy_id,
            action_type: ACTION_MAP[action.action_type],
            action_data: action.action_data,
            created_at: action.created_at,
            start_time: action.start_time,
            end_time: action.end_time,
            accepted_at: action.accepted_at,
            rejected_at: action.rejected_at,
            revoked_at: action.revoked_at,
            is_active: action.is_active
          }))
      }))
      .filter((profileProxy) => !!profileProxy.actions.length);
  }
}

export const profileProxiesMapper = new ProfileProxiesMapper(profilesService);
