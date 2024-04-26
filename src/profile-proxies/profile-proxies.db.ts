import { randomUUID } from 'crypto';
import {
  PROFILE_PROXIES_TABLE,
  PROFILE_PROXY_ACTIONS_TABLE
} from '../constants';
import { ProfileProxyEntity } from '../entities/IProfileProxy';
import {
  ProfileProxyActionEntity,
  ProfileProxyActionType
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
    page,
    page_size,
    sort,
    sort_direction,
    connection
  }: {
    readonly target_id: string;
    readonly page: number;
    readonly page_size: number;
    readonly sort: string;
    readonly sort_direction: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `select * from ${PROFILE_PROXIES_TABLE} where target_id = :target_id order by ${sort} ${sort_direction} limit :limit offset :offset`,
      {
        target_id,
        limit: page_size,
        offset: (page - 1) * page_size
      },
      opts
    );
  }

  async countProfileReceivedProfileProxies({
    target_id,
    connection
  }: {
    target_id: string;
    connection?: ConnectionWrapper<any>;
  }): Promise<number> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const dbResult: { cnt: number }[] = await this.db.execute(
      `select count(*) as cnt from ${PROFILE_PROXIES_TABLE} where target_id = :target_id`,
      { target_id },
      opts
    );
    return dbResult.at(0)?.cnt ?? 0;
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
  }): Promise<ProfileProxyActionEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `select * from ${PROFILE_PROXY_ACTIONS_TABLE} where id = :id`,
        { id },
        opts
      )
      .then((result) => result[0] ?? null);
  }

  async findProfileProxyActionsByProxyIdAndActionType({
    proxy_id,
    action_type,
    connection
  }: {
    readonly proxy_id: string;
    readonly action_type: ProfileProxyActionType;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `select * from ${PROFILE_PROXY_ACTIONS_TABLE} where proxy_id = :proxy_id and action_type = :action_type`,
      { proxy_id, action_type },
      opts
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
