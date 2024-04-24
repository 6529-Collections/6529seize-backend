import { PROFILE_PROXY_ACTIONS_TABLE } from '../constants';
import { ProfileProxyActionEntity, ProfileProxyActionType } from '../entities/IProfileProxyAction';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';

export class ProfileProxyActionsDb extends LazyDbAccessCompatibleService {
  async insertProfileProxyAction({
    profileProxyAction,
    connection
  }: {
    readonly profileProxyAction: ProfileProxyActionEntity;
    readonly connection: ConnectionWrapper<any>;
  }): Promise<void> {
    await this.db.execute(
      `insert into ${PROFILE_PROXY_ACTIONS_TABLE} (id, proxy_id, action_type, action_data, start_time, end_time, created_at, accepted_at, rejected_at, revoked_at, is_active) values (:id, :proxy_id, :action_type, :action_data, :start_time, :end_time, :created_at, :accepted_at, :rejected_at, :revoked_at, :is_active)`,
      {
        id: profileProxyAction.id,
        proxy_id: profileProxyAction.proxy_id,
        action_type: profileProxyAction.action_type,
        action_data: profileProxyAction.action_data,
        start_time: profileProxyAction.start_time,
        end_time: profileProxyAction.end_time,
        created_at: profileProxyAction.created_at,
        accepted_at: profileProxyAction.accepted_at,
        rejected_at: profileProxyAction.rejected_at,
        revoked_at: profileProxyAction.revoked_at,
        is_active: profileProxyAction.is_active
      },
      { wrappedConnection: connection }
    );
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

export const profileProxyActionsDb = new ProfileProxyActionsDb(dbSupplier);
