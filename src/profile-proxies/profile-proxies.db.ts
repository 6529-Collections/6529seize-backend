import { randomUUID } from 'crypto';
import {
  PROFILE_PROXIES_TABLE,
  PROFILE_PROXY_ACTIONS_TABLE
} from '../constants';
import { ProfileProxyEntity } from '../entities/IProfileProxy';
import {
  ApiProfileProxyActionType,
  ProfileProxyActionApiEntity,
  ProfileProxyActionEntity
} from '../entities/IProfileProxyAction';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { Time } from '../time';

export class ProfileProxiesDb extends LazyDbAccessCompatibleService {
  async insertProfileProxy({
    profileProxy,
    connection
  }: {
    readonly profileProxy: ProfileProxyEntity;
    readonly connection: ConnectionWrapper<any>;
  }): Promise<void> {
    await this.db.execute(
      `insert into ${PROFILE_PROXIES_TABLE} (id, target_id, created_at, created_by) values (:id, :target_id, :created_at, :created_by)`,
      profileProxy,
      { wrappedConnection: connection }
    );
  }

  async findProfileProxyById({
    id,
    connection
  }: {
    readonly id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `select * from ${PROFILE_PROXIES_TABLE} where id = :id`,
        { id },
        opts
      )
      .then((result) => result[0] ?? null);
  }

  async findProfileProxyByTargetTypeAndIdAndCreatedByProfileId({
    target_id,
    created_by_profile_id,
    connection
  }: {
    readonly target_id: string;
    readonly created_by_profile_id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `select * from ${PROFILE_PROXIES_TABLE} where target_id = :target_id and created_by = :created_by`,
        { target_id, created_by: created_by_profile_id },
        opts
      )
      .then((result) => result[0] ?? null);
  }

  async findProfileReceivedProfileProxies({
    target_id,
    connection
  }: {
    readonly target_id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `select * from ${PROFILE_PROXIES_TABLE} where target_id = :target_id order by created_at ASC`,
      {
        target_id
      },
      opts
    );
  }

  async findProfileGrantedProfileProxies({
    created_by,
    connection
  }: {
    readonly created_by: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `select * from ${PROFILE_PROXIES_TABLE} where created_by = :created_by order by created_at ASC`,
      {
        created_by
      },
      opts
    );
  }

  async insertProfileProxyAction({
    profileProxyAction,
    connection
  }: {
    readonly profileProxyAction: NewProfileProxyAction;
    readonly connection: ConnectionWrapper<any>;
  }): Promise<{ actionId: string }> {
    const actionId = randomUUID();
    await this.db.execute(
      `insert into ${PROFILE_PROXY_ACTIONS_TABLE} (id, proxy_id, action_type, action_data, start_time, end_time, created_at) values (:id, :proxy_id, :action_type, :action_data, :start_time, :end_time, :created_at)`,
      {
        id: actionId,
        proxy_id: profileProxyAction.proxy_id,
        action_type: profileProxyAction.action_type,
        action_data: profileProxyAction.action_data,
        start_time: profileProxyAction.start_time,
        end_time: profileProxyAction.end_time,
        created_at: Time.currentMillis()
      },
      { wrappedConnection: connection }
    );
    return { actionId };
  }

  async findProfileProxyActionById({
    id,
    connection
  }: {
    readonly id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionApiEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const actions = await this.db.execute(
      `select * from ${PROFILE_PROXY_ACTIONS_TABLE} where id = :id`,
      { id },
      opts
    );
    if (!actions.length) {
      return null;
    }
    const action = actions[0];
    return {
      ...action,
      action_data: JSON.parse(action.action_data),
      is_active: !!action.is_active
    };
  }

  async findProfileProxyActionsByProxyIdAndActionType({
    proxy_id,
    action_type,
    connection
  }: {
    readonly proxy_id: string;
    readonly action_type: ApiProfileProxyActionType;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionApiEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const actions = await this.db.execute(
      `select * from ${PROFILE_PROXY_ACTIONS_TABLE} where proxy_id = :proxy_id and action_type = :action_type`,
      { proxy_id, action_type },
      opts
    );
    return actions.map((action) => ({
      ...action,
      action_data: JSON.parse(action.action_data),
      is_active: !!action.is_active
    }));
  }

  async findProfileProxyReceivedActionsByProfileId({
    target_id,
    connection
  }: {
    readonly target_id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionApiEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const actions = await this.db.execute(
      `select ${PROFILE_PROXY_ACTIONS_TABLE}.* from ${PROFILE_PROXY_ACTIONS_TABLE} join ${PROFILE_PROXIES_TABLE} on ${PROFILE_PROXY_ACTIONS_TABLE}.proxy_id = ${PROFILE_PROXIES_TABLE}.id where ${PROFILE_PROXIES_TABLE}.target_id = :target_id`,
      { target_id },
      opts
    );
    return actions.map((action) => ({
      ...action,
      action_data: JSON.parse(action.action_data),
      is_active: !!action.is_active
    }));
  }

  async findProfileProxyGrantedActionsByProfileId({
    created_by,
    connection
  }: {
    readonly created_by: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionApiEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const actions = await this.db.execute(
      `select ${PROFILE_PROXY_ACTIONS_TABLE}.* from ${PROFILE_PROXY_ACTIONS_TABLE} join ${PROFILE_PROXIES_TABLE} on ${PROFILE_PROXY_ACTIONS_TABLE}.proxy_id = ${PROFILE_PROXIES_TABLE}.id where ${PROFILE_PROXIES_TABLE}.created_by = :created_by`,
      { created_by },
      opts
    );
    return actions.map((action) => ({
      ...action,
      action_data: JSON.parse(action.action_data),
      is_active: !!action.is_active
    }));
  }

  async findProfileProxyActionsByProxyId({
    proxy_id,
    connection
  }: {
    readonly proxy_id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionApiEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const actions = await this.db.execute(
      `select * from ${PROFILE_PROXY_ACTIONS_TABLE} where proxy_id = :proxy_id`,
      { proxy_id },
      opts
    );
    return actions.map((action) => ({
      ...action,
      action_data: JSON.parse(action.action_data),
      is_active: !!action.is_active
    }));
  }

  async acceptProfileProxyAction({
    action_id,
    is_active,
    connection
  }: {
    readonly action_id: string;
    readonly is_active: boolean;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<void> {
    await this.db.execute(
      `update ${PROFILE_PROXY_ACTIONS_TABLE} set accepted_at = :accepted_at, rejected_at = :rejected_at, is_active = :is_active where id = :id`,
      {
        id: action_id,
        accepted_at: Time.currentMillis(),
        rejected_at: null,
        is_active
      },
      { wrappedConnection: connection }
    );
  }

  async rejectProfileProxyAction({
    action_id,
    connection
  }: {
    readonly action_id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<void> {
    await this.db.execute(
      `update ${PROFILE_PROXY_ACTIONS_TABLE} set rejected_at = :rejected_at, accepted_at = :accepted_at, is_active = :is_active where id = :id`,
      {
        id: action_id,
        rejected_at: Time.currentMillis(),
        accepted_at: null,
        is_active: false
      },
      { wrappedConnection: connection }
    );
  }

  async revokeProfileProxyAction({
    action_id,
    connection
  }: {
    readonly action_id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<void> {
    await this.db.execute(
      `update ${PROFILE_PROXY_ACTIONS_TABLE} set revoked_at = :revoked_at, is_active = :is_active where id = :id`,
      { id: action_id, revoked_at: Time.currentMillis(), is_active: false },
      { wrappedConnection: connection }
    );
  }

  async restoreProfileProxyAction({
    action_id,
    is_active,
    connection
  }: {
    readonly action_id: string;
    readonly is_active: boolean;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<void> {
    await this.db.execute(
      `update ${PROFILE_PROXY_ACTIONS_TABLE} set revoked_at = :revoked_at, is_active = :is_active where id = :id`,
      { id: action_id, revoked_at: null, is_active },
      { wrappedConnection: connection }
    );
  }

  async updateProfileProxyActionEndTime({
    action_id,
    end_time,
    connection
  }: {
    readonly action_id: string;
    readonly end_time: number;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<void> {
    await this.db.execute(
      `update ${PROFILE_PROXY_ACTIONS_TABLE} set end_time = :end_time where id = :id`,
      { id: action_id, end_time },
      { wrappedConnection: connection }
    );
  }

  async updateProfileProxyActionData({
    action_id,
    action_data,
    connection
  }: {
    readonly action_id: string;
    readonly action_data: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<void> {
    await this.db.execute(
      `update ${PROFILE_PROXY_ACTIONS_TABLE} set action_data = :action_data where id = :id`,
      { id: action_id, action_data },
      { wrappedConnection: connection }
    );
  }
}

export const profileProxiesDb = new ProfileProxiesDb(dbSupplier);

export type NewProfileProxyAction = Omit<
  ProfileProxyActionEntity,
  | 'id'
  | 'created_at'
  | 'accepted_at'
  | 'rejected_at'
  | 'revoked_at'
  | 'is_active'
>;
