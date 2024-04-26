import { randomUUID } from 'crypto';
import {
  ProfileProxyActionEntity,
  ProfileProxyActionType
} from '../../../entities/IProfileProxyAction';
import { Logger } from '../../../logging';
import {
  profileProxyActionsDb,
  ProfileProxyActionsDb
} from '../../../profile-proxy-actions/profile-proxy-actions.db';
import { CreateNewProfileProxyActionType } from '../generated/models/CreateNewProfileProxyActionType';
import { ProxyApiRequestAction } from './proxies.api.types';
import { Time } from '../../../time';
import { ConnectionWrapper } from '../../../sql-executor';
import { BadRequestException } from '../../../exceptions';
import { assertUnreachable } from '../../../helpers';

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

export class ProfileProxyActionApiService {
  private readonly logger = Logger.get(ProfileProxyActionApiService.name);

  constructor(private readonly profileProxyActionsDb: ProfileProxyActionsDb) {}

  public async findProfileProxyActionByIdOrThrow({
    id,
    connection
  }: {
    readonly id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionEntity> {
    const profileProxyAction =
      await this.profileProxyActionsDb.findProfileProxyActionById({
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
    readonly profileProxyAction: ProfileProxyActionEntity;
  }): Promise<ProfileProxyActionEntity> {
    return await this.profileProxyActionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxyActionsDb.insertProfileProxyAction({
          profileProxyAction,
          connection
        });
        return await this.findProfileProxyActionByIdOrThrow({
          id: profileProxyAction.id,
          connection
        });
      }
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
      await this.profileProxyActionsDb.findProfileProxyActionsByProxyIdAndActionType(
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
            'category' in action_data &&
            action_data.category !== null &&
            'category' in action &&
            action.category !== null
          ) {
            return action_data.category === action.category;
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
    const newAction: ProfileProxyActionEntity = {
      id: randomUUID(),
      proxy_id,
      created_at: Time.currentMillis(),
      action_type: ACTION_MAP[action_type],
      start_time,
      end_time: end_time ?? null,
      action_data: JSON.stringify(restOfAction),
      accepted_at: null,
      rejected_at: null,
      revoked_at: null,
      is_active: false
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

export const profileProxyActionApiService = new ProfileProxyActionApiService(
  profileProxyActionsDb
);
