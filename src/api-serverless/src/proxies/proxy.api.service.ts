import { BadRequestException, NotFoundException } from '../../../exceptions';
import { Time } from '../../../time';
import { ApiCreateNewProfileProxy } from '../generated/models/ApiCreateNewProfileProxy';
import { ProfileProxyEntity } from '../../../entities/IProfileProxy';
import { randomUUID } from 'crypto';
import {
  NewProfileProxyAction,
  ProfileProxiesDb,
  profileProxiesDb
} from '../../../profile-proxies/profile-proxies.db';
import { ConnectionWrapper } from '../../../sql-executor';

import { ProxyApiRequestAction } from './proxies.api.types';
import {
  ProfileProxyActionEntity,
  ProfileProxyActionType
} from '../../../entities/IProfileProxyAction';
import { assertUnreachable } from '../../../assertions';
import { ApiProfileProxy } from '../generated/models/ApiProfileProxy';
import { profileProxiesMapper, ProfileProxiesMapper } from './proxies.mapper';
import { AcceptActionRequestActionEnum } from '../generated/models/AcceptActionRequest';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { ApiProfileProxyActionType } from '../generated/models/ApiProfileProxyActionType';
import { ApiProfileProxyAction } from '../generated/models/ApiProfileProxyAction';
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { profileActivityLogsDb } from '../../../profileActivityLogs/profile-activity-logs.db';

const ACTION_MAP: Record<ApiProfileProxyActionType, ProfileProxyActionType> = {
  [ApiProfileProxyActionType.AllocateRep]: ProfileProxyActionType.ALLOCATE_REP,
  [ApiProfileProxyActionType.AllocateCic]: ProfileProxyActionType.ALLOCATE_CIC,
  [ApiProfileProxyActionType.CreateWave]: ProfileProxyActionType.CREATE_WAVE,
  [ApiProfileProxyActionType.ReadWave]: ProfileProxyActionType.READ_WAVE,
  [ApiProfileProxyActionType.CreateDropToWave]:
    ProfileProxyActionType.CREATE_DROP_TO_WAVE,
  [ApiProfileProxyActionType.RateWaveDrop]:
    ProfileProxyActionType.RATE_WAVE_DROP
};

const ACTION_HAVE_CREDIT: Record<ProfileProxyActionType, boolean> = {
  [ProfileProxyActionType.ALLOCATE_REP]: true,
  [ProfileProxyActionType.ALLOCATE_CIC]: true,
  [ProfileProxyActionType.CREATE_WAVE]: false,
  [ProfileProxyActionType.READ_WAVE]: false,
  [ProfileProxyActionType.CREATE_DROP_TO_WAVE]: false,
  [ProfileProxyActionType.RATE_WAVE_DROP]: false
};

interface CanDoAcceptancePayload {
  readonly action_id: string;
  readonly proxy_id: string;
  readonly profile_id: string;
}

export class ProfileProxyApiService {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly profileProxiesDb: ProfileProxiesDb,
    private readonly profileProxiesMapper: ProfileProxiesMapper
  ) {}

  private async getTargetOrThrow({
    target_id
  }: {
    readonly target_id: string;
  }): Promise<ApiIdentity> {
    const targetIdentity =
      await this.identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        {
          identityKey: target_id
        },
        {}
      );
    if (!targetIdentity?.handle) {
      throw new NotFoundException(
        `Profile with id ${target_id} does not exist`
      );
    }
    return targetIdentity;
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
  }): Promise<ApiProfileProxy> {
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
  }): Promise<ApiProfileProxy> {
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.insertProfileProxy({
          profileProxy: createProfileProxyRequest,
          connection
        });
        await profileActivityLogsDb.insert(
          {
            profile_id: createProfileProxyRequest.created_by,
            contents: JSON.stringify({
              proxy_id: createProfileProxyRequest.id
            }),
            target_id: createProfileProxyRequest.target_id,
            type: ProfileActivityLogType.PROXY_CREATED,
            proxy_id: null,
            additional_data_1: null,
            additional_data_2: null
          },
          connection
        );
        return await this.findProfileProxyByIdOrThrow({
          id: createProfileProxyRequest.id,
          connection
        });
      }
    );
  }

  async createProfileProxy({
    params: { target_id },
    grantorProfileId
  }: {
    readonly params: ApiCreateNewProfileProxy;
    readonly grantorProfileId: string;
  }): Promise<ApiProfileProxy> {
    const target = await this.getTargetOrThrow({
      target_id
    });
    if (!target.handle) {
      throw new NotFoundException(
        `Profile with id ${target_id} does not exist`
      );
    }
    await this.targetNotAlreadyProxiedOrThrow({
      target_id,
      created_by_profile_id: grantorProfileId,
      target_handle: target.handle
    });

    const createProfileProxyRequest: ProfileProxyEntity = {
      id: randomUUID(),
      target_id,
      created_at: Time.currentMillis(),
      created_by: grantorProfileId
    };
    return await this.persistProfileProxy({
      createProfileProxyRequest
    });
  }

  async getProfileProxyByIdOrThrow({
    proxy_id
  }: {
    readonly proxy_id: string;
  }): Promise<ApiProfileProxy> {
    return await this.findProfileProxyByIdOrThrow({
      id: proxy_id
    });
  }

  async getProfileReceivedProfileProxies({
    target_id
  }: {
    readonly target_id: string;
  }): Promise<ApiProfileProxy[]> {
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
  }): Promise<ApiProfileProxy[]> {
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
  }): Promise<ApiProfileProxy[]> {
    const [receivedProxies, grantedProxies] = await Promise.all([
      this.getProfileReceivedProfileProxies({ target_id: profile_id }),
      this.getProfileGrantedProfileProxies({ created_by: profile_id })
    ]);
    return [...receivedProxies, ...grantedProxies].sort(
      (a, d) => d.created_at - a.created_at
    );
  }

  async getProxyByGrantedByAndGrantedTo({
    granted_by_profile_id,
    granted_to_profile_id
  }: {
    readonly granted_by_profile_id: string;
    readonly granted_to_profile_id: string;
  }): Promise<ApiProfileProxy | null> {
    const [actions, profileProxies] = await Promise.all([
      this.profileProxiesDb.findProfileProxyGrantedActionsByGrantorAndGrantee({
        grantor: granted_by_profile_id,
        grantee: granted_to_profile_id
      }),
      this.profileProxiesDb.findProfileProxiesByGrantorAndGrantee({
        grantor: granted_by_profile_id,
        grantee: granted_to_profile_id
      })
    ]);
    return await this.profileProxiesMapper
      .profileProxyEntitiesToApiProfileProxies({
        profileProxyEntities: profileProxies,
        actions
      })
      .then((it) => it[0] ?? null);
  }

  async hasActiveProxyAction({
    granted_by_profile_id,
    granted_to_profile_id,
    action
  }: {
    readonly granted_by_profile_id: string;
    readonly granted_to_profile_id: string;
    readonly action: ProfileProxyActionType;
  }): Promise<boolean> {
    const proxy = await this.getProxyByGrantedByAndGrantedTo({
      granted_by_profile_id,
      granted_to_profile_id
    });
    return !!proxy?.actions
      ?.filter(isProxyActionActive)
      ?.find((it) => it.action_type === action.toString());
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
    return !!actions.length;
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

  private async persistProfileProxyAction(
    {
      profileProxyAction
    }: {
      readonly profileProxyAction: NewProfileProxyAction;
    },
    proxy: ApiProfileProxy
  ): Promise<ProfileProxyActionEntity> {
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const { actionId } =
          await this.profileProxiesDb.insertProfileProxyAction({
            profileProxyAction,
            connection
          });
        await profileActivityLogsDb.insert(
          {
            profile_id: proxy.created_by.id,
            contents: JSON.stringify({
              proxy_id: profileProxyAction.proxy_id,
              action_id: actionId,
              type: profileProxyAction.action_type
            }),
            target_id: proxy.granted_to.id,
            type: ProfileActivityLogType.PROXY_ACTION_CREATED,
            proxy_id: null,
            additional_data_1: null,
            additional_data_2: null
          },
          connection
        );
        return await this.findProfileProxyActionByIdOrThrow({
          id: actionId,
          connection
        });
      }
    );
  }

  async createProfileProxyAction({
    proxy,
    action
  }: {
    readonly proxy: ApiProfileProxy;
    readonly action: ProxyApiRequestAction;
  }): Promise<ProfileProxyActionEntity> {
    const action_exists = await this.isActionExists({
      proxy_id: proxy.id,
      action
    });
    if (action_exists) {
      throw new BadRequestException('Action already exists');
    }
    const newAction: NewProfileProxyAction = {
      proxy_id: proxy.id,
      action_type: ACTION_MAP[action.action_type],
      start_time: Time.currentMillis(),
      end_time: action.end_time ?? null,
      credit_amount: 'credit_amount' in action ? action.credit_amount : null,
      credit_spent: 'credit_amount' in action ? 0 : null
    };
    const profileProxyAction = await this.persistProfileProxyAction(
      {
        profileProxyAction: newAction
      },
      proxy
    );
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
    profileProxy: ApiProfileProxy;
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
    const proxy = await this.findProfileProxyByIdOrThrow({
      id: proxy_id
    });
    const is_active = !action.revoked_at;
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.acceptProfileProxyAction({
          action_id,
          connection,
          is_active
        });
        await profileActivityLogsDb.insert(
          {
            profile_id: proxy.granted_to.id,
            contents: JSON.stringify({
              proxy_id,
              action_id,
              type: action.action_type,
              state_change_type: AcceptActionRequestActionEnum.Accept
            }),
            target_id: proxy.created_by.id,
            type: ProfileActivityLogType.PROXY_ACTION_STATE_CHANGED,
            proxy_id: null,
            additional_data_1: null,
            additional_data_2: null
          },
          connection
        );
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
    const action = await this.findProfileProxyActionByIdOrThrow({
      id: action_id
    });
    const proxy = await this.findProfileProxyByIdOrThrow({
      id: proxy_id
    });
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.rejectProfileProxyAction({
          action_id,
          connection
        });
        await profileActivityLogsDb.insert(
          {
            profile_id: proxy.granted_to.id,
            contents: JSON.stringify({
              proxy_id,
              action_id,
              type: action.action_type,
              state_change_type: AcceptActionRequestActionEnum.Reject
            }),
            target_id: proxy.created_by.id,
            type: ProfileActivityLogType.PROXY_ACTION_STATE_CHANGED,
            proxy_id: null,
            additional_data_1: null,
            additional_data_2: null
          },
          connection
        );
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
    const action = await this.findProfileProxyActionByIdOrThrow({
      id: action_id
    });
    const proxy = await this.findProfileProxyByIdOrThrow({
      id: proxy_id
    });
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.revokeProfileProxyAction({
          action_id,
          connection
        });
        await profileActivityLogsDb.insert(
          {
            profile_id: proxy.created_by.id,
            contents: JSON.stringify({
              proxy_id,
              action_id,
              type: action.action_type,
              state_change_type: AcceptActionRequestActionEnum.Revoke
            }),
            target_id: proxy.granted_to.id,
            type: ProfileActivityLogType.PROXY_ACTION_STATE_CHANGED,
            proxy_id: null,
            additional_data_1: null,
            additional_data_2: null
          },
          connection
        );
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
    const proxy = await this.findProfileProxyByIdOrThrow({
      id: proxy_id
    });
    const is_active = !!action.accepted_at && !action.rejected_at;
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.restoreProfileProxyAction({
          action_id,
          connection,
          is_active
        });
        await profileActivityLogsDb.insert(
          {
            profile_id: proxy.created_by.id,
            contents: JSON.stringify({
              proxy_id,
              action_id,
              type: action.action_type,
              state_change_type: AcceptActionRequestActionEnum.Restore
            }),
            target_id: proxy.granted_to.id,
            type: ProfileActivityLogType.PROXY_ACTION_STATE_CHANGED,
            proxy_id: null,
            additional_data_1: null,
            additional_data_2: null
          },
          connection
        );
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
        throw new BadRequestException('Invalid acceptance type');
    }
  }

  async updateProfileProxyAction({
    profile_id,
    proxy_id,
    action_id,
    credit_amount,
    end_time
  }: {
    readonly proxy_id: string;
    readonly action_id: string;
    readonly profile_id: string;
    readonly credit_amount?: number;
    readonly end_time?: number | null;
  }): Promise<ProfileProxyActionEntity> {
    if (!credit_amount && end_time === undefined) {
      throw new BadRequestException(
        'Credit amount or end time must be provided'
      );
    }
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
    if (
      !!credit_amount &&
      !ACTION_HAVE_CREDIT[profileProxyAction.action_type]
    ) {
      throw new BadRequestException('Action does not have credit');
    }

    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.updateProfileProxyAction({
          action_id,
          credit_amount,
          end_time,
          connection
        });
        await profileActivityLogsDb.insert(
          {
            profile_id: profileProxy.created_by.id,
            contents: JSON.stringify({
              proxy_id,
              action_id,
              type: profileProxyAction.action_type,
              credit_amount,
              end_time
            }),
            target_id: profileProxy.granted_to.id,
            type: ProfileActivityLogType.PROXY_ACTION_CHANGED,
            proxy_id: null,
            additional_data_1: null,
            additional_data_2: null
          },
          connection
        );
        return await this.findProfileProxyActionByIdOrThrow({
          id: action_id,
          connection
        });
      }
    );
  }
}

export function isProxyActionActive(action: ApiProfileProxyAction): boolean {
  const now = Time.now();
  return (
    !!action.accepted_at &&
    Time.millis(action.accepted_at).lte(now) &&
    (!action.start_time || Time.millis(action.start_time).lte(now)) &&
    (!action.end_time || Time.millis(action.end_time).gte(now)) &&
    (!action.rejected_at || Time.millis(action.rejected_at).gte(now)) &&
    (!action.revoked_at || Time.millis(action.revoked_at).gte(now))
  );
}

export const profileProxyApiService = new ProfileProxyApiService(
  identityFetcher,
  profileProxiesDb,
  profileProxiesMapper
);
