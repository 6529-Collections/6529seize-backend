import { ProfileProxyEntity } from '../../../entities/IProfileProxy';
import { distinct } from '../../../helpers';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import { ProfileMin } from '../generated/models/ProfileMin';
import { ProfileProxy } from '../generated/models/ProfileProxy';

export class ProfileProxiesMapper {
  constructor(private readonly profilesService: ProfilesService) {}

  public async profileProxyEntitiesToApiProfileProxies({
    profileProxyEntities
  }: {
    readonly profileProxyEntities: ProfileProxyEntity[];
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
      created_at: entity.created_at
    }));
  }
}

export const profileProxiesMapper = new ProfileProxiesMapper(profilesService);
