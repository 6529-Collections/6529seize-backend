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

import { ProxyApiRequestAction } from './proxies.api.types';
import {
  ProfileProxyActionEntity,
  ApiProfileProxyActionType
} from '../../../entities/IProfileProxyAction';
import { assertUnreachable } from '../../../helpers';
import { ProfileProxyActionType } from '../generated/models/ProfileProxyActionType';
import { ProfileProxy } from '../generated/models/ProfileProxy';
import { profileProxiesMapper, ProfileProxiesMapper } from './proxies.mapper';
import { AcceptActionRequestActionEnum } from '../generated/models/AcceptActionRequest';

const ACTION_MAP: Record<ProfileProxyActionType, ApiProfileProxyActionType> = {
  [ProfileProxyActionType.AllocateRep]: ApiProfileProxyActionType.ALLOCATE_REP,
  [ProfileProxyActionType.AllocateCic]: ApiProfileProxyActionType.ALLOCATE_CIC,
  [ProfileProxyActionType.CreateWave]: ApiProfileProxyActionType.CREATE_WAVE,
  [ProfileProxyActionType.ReadWave]: ApiProfileProxyActionType.READ_WAVE,
  [ProfileProxyActionType.CreateDropToWave]:
    ApiProfileProxyActionType.CREATE_DROP_TO_WAVE,
  [ProfileProxyActionType.RateWaveDrop]:
    ApiProfileProxyActionType.RATE_WAVE_DROP
};

interface CanDoAcceptancePayload {
  readonly action_id: string;
  readonly proxy_id: string;
  readonly profile_id: string;
}

export class ProfileProxyApiService {
  private readonly logger = Logger.get(ProfileProxyApiService.name);

  constructor(
    private readonly profilesService: ProfilesService,
    private readonly profileProxiesDb: ProfileProxiesDb,
    private readonly profileProxiesMapper: ProfileProxiesMapper
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

  private async findProfileProxyByIdOrThrow({
    id,
    connection
  }: {
    readonly id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxy> {
    const profileProxy = await this.profileProxiesDb.findProfileProxyById({
      id,
      connection
    });
    if (!profileProxy) {
      throw new NotFoundException(`Profile proxy with id ${id} does not exist`);
    }
    const mappedProfileProxy =
      await this.profileProxiesMapper.profileProxyEntitiesToApiProfileProxies({
        profileProxyEntities: [profileProxy],
        actions: await this.profileProxiesDb.findProfileProxyActionsByProxyId({
          proxy_id: id,
          connection
        })
      });

    if (!mappedProfileProxy.length) {
      throw new Error('Something went wrong getting profile proxy');
    }
    return mappedProfileProxy[0];
  }

  async persistProfileProxy({
    createProfileProxyRequest
  }: {
    readonly createProfileProxyRequest: ProfileProxyEntity;
  }): Promise<ProfileProxy> {
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
  }): Promise<ProfileProxy> {
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
    return await this.persistProfileProxy({
      createProfileProxyRequest
    });
  }

  async getProfileProxyByIdOrThrow({
    proxy_id
  }: {
    readonly proxy_id: string;
  }): Promise<ProfileProxy> {
    return await this.findProfileProxyByIdOrThrow({
      id: proxy_id
    });
  }

  async getProfileReceivedProfileProxies({
    target_id
  }: {
    readonly target_id: string;
  }): Promise<ProfileProxy[]> {
    const actions =
      await this.profileProxiesDb.findProfileProxyReceivedActionsByProfileId({
        target_id
      });
    const profileProxies =
      await this.profileProxiesDb.findProfileReceivedProfileProxies({
        target_id
      });

    return await this.profileProxiesMapper.profileProxyEntitiesToApiProfileProxies(
      {
        profileProxyEntities: profileProxies,
        actions
      }
    );
  }

  async getProfileGrantedProfileProxies({
    created_by
  }: {
    readonly created_by: string;
  }): Promise<ProfileProxy[]> {
    const actions =
      await this.profileProxiesDb.findProfileProxyGrantedActionsByProfileId({
        created_by
      });
    const profileProxies =
      await this.profileProxiesDb.findProfileGrantedProfileProxies({
        created_by
      });
    return await this.profileProxiesMapper.profileProxyEntitiesToApiProfileProxies(
      {
        profileProxyEntities: profileProxies,
        actions
      }
    );
  }

  async getProfileReceivedAndGrantedProxies({
    profile_id
  }: {
    readonly profile_id: string;
  }): Promise<ProfileProxy[]> {
    const [receivedProxies, grantedProxies] = await Promise.all([
      this.getProfileReceivedProfileProxies({ target_id: profile_id }),
      this.getProfileGrantedProfileProxies({ created_by: profile_id })
    ]);
    return [...receivedProxies, ...grantedProxies].sort(
      (a, d) => d.created_at - a.created_at
    );
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
      case ApiProfileProxyActionType.ALLOCATE_REP:
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
      case ApiProfileProxyActionType.ALLOCATE_CIC:
      case ApiProfileProxyActionType.CREATE_WAVE:
      case ApiProfileProxyActionType.READ_WAVE:
      case ApiProfileProxyActionType.CREATE_DROP_TO_WAVE:
      case ApiProfileProxyActionType.RATE_WAVE_DROP:
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
      is_active: !!profileProxyAction.is_active
    };
  }

  private async getProfileProxyAndAction({
    action_id,
    proxy_id
  }: {
    action_id: string;
    proxy_id: string;
  }): Promise<{
    profileProxy: ProfileProxy;
    profileProxyAction: ProfileProxyActionEntity;
  }> {
    const [profileProxy, profileProxyAction] = await Promise.all([
      this.getProfileProxyByIdOrThrow({
        proxy_id
      }),
      this.findProfileProxyActionByIdOrThrow({
        id: action_id
      })
    ]);
    if (profileProxyAction.proxy_id !== proxy_id) {
      throw new BadRequestException(
        `Action with id ${action_id} does not belong to proxy with id ${proxy_id}`
      );
    }
    return { profileProxy, profileProxyAction };
  }

  private async canAcceptActionOrThrow({
    action_id,
    proxy_id,
    profile_id
  }: {
    readonly action_id: string;
    readonly proxy_id: string;
    readonly profile_id: string;
  }): Promise<void> {
    const { profileProxy, profileProxyAction } =
      await this.getProfileProxyAndAction({
        action_id,
        proxy_id
      });

    if (profileProxy.granted_to.id !== profile_id) {
      throw new BadRequestException(
        'You are not the target of this proxy action'
      );
    }

    if (profileProxyAction.revoked_at) {
      throw new BadRequestException('Action has been revoked');
    }

    if (profileProxyAction.accepted_at) {
      throw new BadRequestException('Action has already been accepted');
    }

    const now = Time.currentMillis();
    if (profileProxyAction.end_time && profileProxyAction.end_time < now) {
      throw new BadRequestException('Action has expired');
    }
  }

  private async canRejectActionOrThrow({
    action_id,
    proxy_id,
    profile_id
  }: CanDoAcceptancePayload): Promise<void> {
    const { profileProxy, profileProxyAction } =
      await this.getProfileProxyAndAction({
        action_id,
        proxy_id
      });

    if (profileProxy.granted_to.id !== profile_id) {
      throw new BadRequestException(
        'You are not the target of this proxy action'
      );
    }

    if (profileProxyAction.revoked_at) {
      throw new BadRequestException('Action has been revoked');
    }

    if (profileProxyAction.rejected_at) {
      throw new BadRequestException('Action has already been rejected');
    }

    const now = Time.currentMillis();
    if (profileProxyAction.end_time && profileProxyAction.end_time < now) {
      throw new BadRequestException('Action has expired');
    }
  }

  private async canRevokeOrThrow({
    action_id,
    proxy_id,
    profile_id
  }: CanDoAcceptancePayload): Promise<void> {
    const { profileProxy, profileProxyAction } =
      await this.getProfileProxyAndAction({
        action_id,
        proxy_id
      });

    if (profileProxy.created_by.id !== profile_id) {
      throw new BadRequestException(
        'You are not the creator of this proxy action'
      );
    }

    if (profileProxyAction.revoked_at) {
      throw new BadRequestException('Action has been revoked');
    }
  }

  private async canRestoreOrThrow({
    action_id,
    proxy_id,
    profile_id
  }: CanDoAcceptancePayload): Promise<void> {
    const { profileProxy, profileProxyAction } =
      await this.getProfileProxyAndAction({
        action_id,
        proxy_id
      });

    if (profileProxy.created_by.id !== profile_id) {
      throw new BadRequestException(
        'You are not the creator of this proxy action'
      );
    }

    if (!profileProxyAction.revoked_at) {
      throw new BadRequestException('Action has not been revoked');
    }
  }

  private async acceptProfileProxyAction({
    proxy_id,
    action_id,
    profile_id
  }: CanDoAcceptancePayload): Promise<ProfileProxyActionEntity> {
    await this.canAcceptActionOrThrow({ action_id, proxy_id, profile_id });
    const action = await this.findProfileProxyActionByIdOrThrow({
      id: action_id
    });
    const is_active = !action.revoked_at;
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.acceptProfileProxyAction({
          action_id,
          connection,
          is_active
        });
        return await this.findProfileProxyActionByIdOrThrow({
          id: action_id,
          connection
        });
      }
    );
  }

  private async rejectProfileProxyAction({
    proxy_id,
    action_id,
    profile_id
  }: CanDoAcceptancePayload): Promise<ProfileProxyActionEntity> {
    await this.canRejectActionOrThrow({ action_id, proxy_id, profile_id });
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.rejectProfileProxyAction({
          action_id,
          connection
        });
        return await this.findProfileProxyActionByIdOrThrow({
          id: action_id,
          connection
        });
      }
    );
  }

  private async revokeProfileProxyAction({
    proxy_id,
    action_id,
    profile_id
  }: CanDoAcceptancePayload): Promise<ProfileProxyActionEntity> {
    await this.canRevokeOrThrow({ action_id, proxy_id, profile_id });
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.revokeProfileProxyAction({
          action_id,
          connection
        });
        return await this.findProfileProxyActionByIdOrThrow({
          id: action_id,
          connection
        });
      }
    );
  }

  private async restoreProfileProxyAction({
    proxy_id,
    action_id,
    profile_id
  }: CanDoAcceptancePayload): Promise<ProfileProxyActionEntity> {
    await this.canRestoreOrThrow({ action_id, proxy_id, profile_id });
    const action = await this.findProfileProxyActionByIdOrThrow({
      id: action_id
    });
    const is_active = !!action.accepted_at && !action.rejected_at;
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.restoreProfileProxyAction({
          action_id,
          connection,
          is_active
        });
        return await this.findProfileProxyActionByIdOrThrow({
          id: action_id,
          connection
        });
      }
    );
  }

  async changeProfileProxyActionStatus({
    acceptance_type,
    ...payload
  }: {
    readonly proxy_id: string;
    readonly action_id: string;
    readonly acceptance_type: AcceptActionRequestActionEnum;
    readonly profile_id: string;
  }): Promise<ProfileProxyActionEntity> {
    switch (acceptance_type) {
      case AcceptActionRequestActionEnum.Accept:
        return await this.acceptProfileProxyAction(payload);
      case AcceptActionRequestActionEnum.Reject:
        return await this.rejectProfileProxyAction(payload);
      case AcceptActionRequestActionEnum.Revoke:
        return await this.revokeProfileProxyAction(payload);
      case AcceptActionRequestActionEnum.Restore:
        return await this.restoreProfileProxyAction(payload);
      default:
        assertUnreachable(acceptance_type);
        return await this.findProfileProxyActionByIdOrThrow({
          id: payload.action_id
        });
    }
  }
}

export const profileProxyApiService = new ProfileProxyApiService(
  profilesService,
  profileProxiesDb,
  profileProxiesMapper
);
