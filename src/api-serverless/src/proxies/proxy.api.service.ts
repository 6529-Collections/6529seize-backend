import { Profile } from '../../../entities/IProfile';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { Logger } from '../../../logging';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import { Time } from '../../../time';
import { CreateNewProfileProxy } from '../generated/models/CreateNewProfileProxy';
import { ProfileProxyEntity } from '../../../entities/IProfileProxy';
import { randomUUID } from 'crypto';
import {
  NewProfileProxyAction,
  ProfileProxiesDb,
  profileProxiesDb
} from '../../../profile-proxies/profile-proxies.db';
import { ConnectionWrapper } from '../../../sql-executor';
import { ProfileAndConsolidations } from '../../../profiles/profile.types';
import { Page } from '../page-request';
import { ProxyApiRequestAction } from './proxies.api.types';
import {
  ProfileProxyActionEntity,
  ProfileProxyActionType
} from '../../../entities/IProfileProxyAction';
import { assertUnreachable } from '../../../helpers';
import { CreateNewProfileProxyActionType } from '../generated/models/CreateNewProfileProxyActionType';

const ACTION_MAP: Record<
  CreateNewProfileProxyActionType,
  ProfileProxyActionType
> = {
  [CreateNewProfileProxyActionType.AllocateRep]:
    ProfileProxyActionType.ALLOCATE_REP,
  [CreateNewProfileProxyActionType.AllocateCic]:
    ProfileProxyActionType.ALLOCATE_CIC,
  [CreateNewProfileProxyActionType.CreateWave]:
    ProfileProxyActionType.CREATE_WAVE,
  [CreateNewProfileProxyActionType.ReadWave]: ProfileProxyActionType.READ_WAVE,
  [CreateNewProfileProxyActionType.CreateDropToWave]:
    ProfileProxyActionType.CREATE_DROP_TO_WAVE,
  [CreateNewProfileProxyActionType.RateWaveDrop]:
    ProfileProxyActionType.RATE_WAVE_DROP
};

export class ProfileProxyApiService {
  private readonly logger = Logger.get(ProfileProxyApiService.name);

  constructor(
    private readonly profilesService: ProfilesService,
    private readonly profileProxiesDb: ProfileProxiesDb
  ) {}

  private async getTargetOrThrow({
    target_id
  }: {
    readonly target_id: string;
  }): Promise<ProfileAndConsolidations> {
    const targetProfile =
      await this.profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        target_id
      );
    if (!targetProfile) {
      throw new NotFoundException(
        `Profile with id ${target_id} does not exist`
      );
    }
    return targetProfile;
  }

  private async targetNotAlreadyProxiedOrThrow({
    target_id,
    created_by_profile_id,
    target_handle
  }: {
    readonly target_id: string;
    readonly created_by_profile_id: string;
    readonly target_handle: string;
  }): Promise<void> {
    const profileProxy =
      await this.profileProxiesDb.findProfileProxyByTargetTypeAndIdAndCreatedByProfileId(
        {
          target_id,
          created_by_profile_id
        }
      );
    if (profileProxy) {
      throw new BadRequestException(
        `Profile proxy for target ${target_handle} already exists`
      );
    }
  }

  public async findProfileProxyByIdOrThrow({
    id,
    connection
  }: {
    readonly id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity> {
    const profileProxy = await this.profileProxiesDb.findProfileProxyById({
      id,
      connection
    });
    if (!profileProxy) {
      throw new NotFoundException(`Profile proxy with id ${id} does not exist`);
    }
    return profileProxy;
  }

  async persistProfileProxy({
    createProfileProxyRequest
  }: {
    readonly createProfileProxyRequest: ProfileProxyEntity;
  }): Promise<ProfileProxyEntity> {
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.insertProfileProxy({
          profileProxy: createProfileProxyRequest,
          connection
        });
        return await this.findProfileProxyByIdOrThrow({
          id: createProfileProxyRequest.id,
          connection
        });
      }
    );
  }

  async createProfileProxy({
    params: { target_id },
    grantorProfile: { external_id: created_by_profile_id }
  }: {
    readonly params: CreateNewProfileProxy;
    readonly grantorProfile: Profile;
  }): Promise<ProfileProxyEntity> {
    const target = await this.getTargetOrThrow({
      target_id
    });
    if (!target.profile?.handle) {
      throw new NotFoundException(
        `Profile with id ${target_id} does not exist`
      );
    }
    await this.targetNotAlreadyProxiedOrThrow({
      target_id,
      created_by_profile_id,
      target_handle: target.profile.handle
    });

    const createProfileProxyRequest: ProfileProxyEntity = {
      id: randomUUID(),
      target_id,
      created_at: Time.currentMillis(),
      created_by: created_by_profile_id
    };
    const profileProxy = await this.persistProfileProxy({
      createProfileProxyRequest
    });
    return profileProxy;
  }

  async getProfileProxyByIdOrThrow({
    proxy_id
  }: {
    readonly proxy_id: string;
  }): Promise<ProfileProxyEntity> {
    return await this.findProfileProxyByIdOrThrow({
      id: proxy_id
    });
  }

  // how to make it infinite scroll
  async getProfileReceivedProfileProxies({
    target_id,
    page,
    page_size,
    sort,
    sort_direction
  }: {
    readonly target_id: string;
    readonly page: number;
    readonly page_size: number;
    readonly sort: string;
    readonly sort_direction: string;
  }): Promise<Page<ProfileProxyEntity>> {
    const [profileProxies, count] = await Promise.all([
      this.profileProxiesDb.findProfileReceivedProfileProxies({
        target_id,
        page,
        page_size,
        sort,
        sort_direction
      }),
      this.profileProxiesDb.countProfileReceivedProfileProxies({
        target_id
      })
    ]);
    return {
      count,
      page: page,
      next: profileProxies.length === page_size,
      data: profileProxies
    };
  }

  private async isActionExists({
    proxy_id,
    action
  }: {
    readonly proxy_id: string;
    readonly action: ProxyApiRequestAction;
  }): Promise<boolean> {
    const action_type = ACTION_MAP[action.action_type];
    const actions =
      await this.profileProxiesDb.findProfileProxyActionsByProxyIdAndActionType(
        {
          proxy_id,
          action_type
        }
      );
    if (!actions.length) {
      return false;
    }
    switch (action_type) {
      case ProfileProxyActionType.ALLOCATE_REP:
        return actions.some((a) => {
          const action_data = JSON.parse(a.action_data);
          if (
            'credit_category' in action_data &&
            action_data.credit_category !== null &&
            'credit_category' in action &&
            action.credit_category !== null
          ) {
            return action_data.credit_category === action.credit_category;
          }
          return true;
        });
      case ProfileProxyActionType.ALLOCATE_CIC:
      case ProfileProxyActionType.CREATE_WAVE:
      case ProfileProxyActionType.READ_WAVE:
      case ProfileProxyActionType.CREATE_DROP_TO_WAVE:
      case ProfileProxyActionType.RATE_WAVE_DROP:
        return true;
      default:
        assertUnreachable(action_type);
    }

    return true;
  }

  public async findProfileProxyActionByIdOrThrow({
    id,
    connection
  }: {
    readonly id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionEntity> {
    const profileProxyAction =
      await this.profileProxiesDb.findProfileProxyActionById({
        id,
        connection
      });
    if (!profileProxyAction) {
      throw new BadRequestException(
        `Profile proxy action with id ${id} not found`
      );
    }
    return profileProxyAction;
  }

  private async persistProfileProxyAction({
    profileProxyAction
  }: {
    readonly profileProxyAction: NewProfileProxyAction;
  }): Promise<ProfileProxyActionEntity> {
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const { actionId } =
          await this.profileProxiesDb.insertProfileProxyAction({
            profileProxyAction,
            connection
          });
        return await this.findProfileProxyActionByIdOrThrow({
          id: actionId,
          connection
        });
      }
    );
  }

  async createProfileProxyAction({
    proxy_id,
    action
  }: {
    readonly proxy_id: string;
    readonly action: ProxyApiRequestAction;
  }): Promise<ProfileProxyActionEntity> {
    const action_exists = await this.isActionExists({ proxy_id, action });
    if (action_exists) {
      throw new BadRequestException('Action already exists');
    }
    const { start_time, end_time, action_type, ...restOfAction } = action;
    const newAction: NewProfileProxyAction = {
      proxy_id,
      action_type: ACTION_MAP[action_type],
      start_time,
      end_time: end_time ?? null,
      action_data: JSON.stringify(restOfAction)
    };
    const profileProxyAction = await this.persistProfileProxyAction({
      profileProxyAction: newAction
    });
    return {
      ...profileProxyAction,
      action_data: JSON.parse(profileProxyAction.action_data),
      is_active: !!profileProxyAction.is_active
    };
  }
}

export const profileProxyApiService = new ProfileProxyApiService(
  profilesService,
  profileProxiesDb
);