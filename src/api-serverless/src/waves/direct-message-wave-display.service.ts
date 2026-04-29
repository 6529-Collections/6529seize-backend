import { AuthenticationContext } from '@/auth-context';
import { collections } from '@/collections';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { WaveEntity } from '@/entities/IWave';
import { ConnectionWrapper } from '@/sql-executor';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import {
  IdentityFetcher,
  identityFetcher
} from '@/api/identities/identity.fetcher';
import {
  UserGroupsService,
  userGroupsService
} from '@/api/community-members/user-groups.service';

export type WaveDisplaySource = Pick<
  WaveEntity,
  | 'id'
  | 'is_direct_message'
  | 'visibility_group_id'
  | 'participation_group_id'
  | 'chat_group_id'
  | 'admin_group_id'
  | 'voting_group_id'
>;

export type WaveDisplayOverride = {
  readonly name?: string;
  readonly picture?: string | null;
};

export function resolveWavePictureOverride(
  wavePicture: string | null,
  waveDisplayOverride?: WaveDisplayOverride
): string | null {
  if (
    waveDisplayOverride &&
    Object.prototype.hasOwnProperty.call(waveDisplayOverride, 'picture')
  ) {
    return waveDisplayOverride.picture ?? null;
  }
  return wavePicture;
}

export class DirectMessageWaveDisplayService {
  constructor(
    private readonly userGroupsService: UserGroupsService,
    private readonly identityFetcher: IdentityFetcher
  ) {}

  public async resolveWaveDisplayByWaveIdForContext(
    {
      waveEntities,
      contextProfileId,
      curationEntities,
      profilesById
    }: {
      waveEntities: WaveDisplaySource[];
      contextProfileId: string | null;
      curationEntities?: UserGroupEntity[];
      profilesById?: Record<string, ApiProfileMin>;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, WaveDisplayOverride>> {
    const directMessageWaves = waveEntities.filter(
      (waveEntity) => waveEntity.is_direct_message === true
    );
    if (!directMessageWaves.length) {
      return {};
    }
    const waveGroupIds = collections.distinct(
      directMessageWaves.flatMap((waveEntity) =>
        [
          waveEntity.visibility_group_id,
          waveEntity.participation_group_id,
          waveEntity.chat_group_id,
          waveEntity.admin_group_id,
          waveEntity.voting_group_id
        ].filter((groupId): groupId is string => groupId !== null)
      )
    );
    if (!waveGroupIds.length) {
      return {};
    }
    const resolvedCurationEntities =
      curationEntities ??
      (await this.userGroupsService.getByIds(waveGroupIds, { connection }));
    const curationEntitiesById = resolvedCurationEntities.reduce(
      (acc, curationEntity) => {
        acc[curationEntity.id] = curationEntity;
        return acc;
      },
      {} as Record<string, UserGroupEntity>
    );
    const directMessageIdentityGroupIdByWaveId = directMessageWaves.reduce(
      (acc, waveEntity) => {
        const directMessageGroup = [
          waveEntity.visibility_group_id,
          waveEntity.participation_group_id,
          waveEntity.chat_group_id,
          waveEntity.admin_group_id,
          waveEntity.voting_group_id
        ]
          .map((groupId) => (groupId ? curationEntitiesById[groupId] : null))
          .find((group) => group?.is_direct_message && group.profile_group_id);
        if (directMessageGroup?.profile_group_id) {
          acc[waveEntity.id] = directMessageGroup.profile_group_id;
        }
        return acc;
      },
      {} as Record<string, string>
    );
    const directMessageIdentityGroupIds = collections.distinct(
      Object.values(directMessageIdentityGroupIdByWaveId)
    );
    if (!directMessageIdentityGroupIds.length) {
      return {};
    }
    const directMessageParticipantProfileIdsByIdentityGroupId =
      await this.userGroupsService.findUserGroupsIdentityGroupProfileIds(
        directMessageIdentityGroupIds
      );
    const allDirectMessageParticipantProfileIds = collections.distinct(
      Object.values(directMessageParticipantProfileIdsByIdentityGroupId).flat()
    );
    if (!allDirectMessageParticipantProfileIds.length) {
      return {};
    }
    const preloadedProfilesById = profilesById ?? {};
    const missingProfileIds = collections
      .distinct([
        ...allDirectMessageParticipantProfileIds,
        ...(contextProfileId ? [contextProfileId] : [])
      ])
      .filter((profileId) => !preloadedProfilesById[profileId]);
    const fetchedProfilesById = missingProfileIds.length
      ? await this.identityFetcher.getOverviewsByIds(missingProfileIds, {
          connection,
          authenticationContext: contextProfileId
            ? AuthenticationContext.fromProfileId(contextProfileId)
            : AuthenticationContext.notAuthenticated()
        })
      : {};
    const allProfilesById = {
      ...preloadedProfilesById,
      ...fetchedProfilesById
    };
    return Object.entries(directMessageIdentityGroupIdByWaveId).reduce(
      (acc, [waveId, identityGroupId]) => {
        const participantProfileIds =
          directMessageParticipantProfileIdsByIdentityGroupId[
            identityGroupId
          ] ?? [];
        if (
          !contextProfileId ||
          !participantProfileIds.includes(contextProfileId)
        ) {
          return acc;
        }
        const participantProfiles = participantProfileIds
          .map((profileId) => allProfilesById[profileId])
          .filter((it): it is ApiProfileMin => !!it);
        const displayProfiles = participantProfiles.filter(
          (it) => it.id !== contextProfileId
        );
        const effectiveDisplayProfiles = displayProfiles.length
          ? displayProfiles
          : participantProfiles;
        const sortedEffectiveDisplayProfiles = [...effectiveDisplayProfiles]
          .filter((profile) => !!profile.id)
          .sort(
            (a, b) =>
              (a.handle ?? '').localeCompare(b.handle ?? '') ||
              a.id.localeCompare(b.id)
          );
        const handles = collections.distinct(
          sortedEffectiveDisplayProfiles
            .map((profile) => profile.handle?.trim())
            .filter((handle): handle is string => !!handle)
        );
        const hasMoreThanTwoParties = participantProfileIds.length > 2;
        const picture = hasMoreThanTwoParties
          ? null
          : sortedEffectiveDisplayProfiles.find((it) => !!it.pfp)?.pfp;
        if (handles.length || hasMoreThanTwoParties || picture) {
          acc[waveId] = {
            ...(handles.length ? { name: handles.join(', ') } : {}),
            ...(hasMoreThanTwoParties || picture
              ? { picture: picture ?? null }
              : {})
          };
        }
        return acc;
      },
      {} as Record<string, WaveDisplayOverride>
    );
  }
}

export const directMessageWaveDisplayService =
  new DirectMessageWaveDisplayService(userGroupsService, identityFetcher);
