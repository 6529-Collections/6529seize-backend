import { randomUUID } from 'crypto';
import {
  PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE,
  PROFILE_PROXIES_TABLE,
  PROFILE_PROXY_ACTIONS_TABLE
} from '@/constants';
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

  async findProfileProxiesByGrantorAndGrantee({
    grantor,
    grantee
  }: {
    readonly grantor: string;
    readonly grantee: string;
  }): Promise<ProfileProxyEntity[]> {
    return this.db.execute(
      `select * from ${PROFILE_PROXIES_TABLE} where created_by = :grantor and target_id = :grantee order by created_at ASC`,
      {
        grantor,
        grantee
      }
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
      `insert into ${PROFILE_PROXY_ACTIONS_TABLE} (id, proxy_id, action_type, credit_amount, credit_spent, start_time, end_time, created_at) values (:id, :proxy_id, :action_type, :credit_amount, :credit_spent, :start_time, :end_time, :created_at)`,
      {
        id: actionId,
        proxy_id: profileProxyAction.proxy_id,
        action_type: profileProxyAction.action_type,
        credit_amount: profileProxyAction.credit_amount,
        credit_spent: profileProxyAction.credit_spent,
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
      is_active: !!action.is_active
    };
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
    const actions = await this.db.execute(
      `select * from ${PROFILE_PROXY_ACTIONS_TABLE} where proxy_id = :proxy_id and action_type = :action_type`,
      { proxy_id, action_type },
      opts
    );
    return actions.map((action) => ({
      ...action,
      is_active: !!action.is_active
    }));
  }

  async findProfileProxyReceivedActionsByProfileId({
    target_id,
    connection
  }: {
    readonly target_id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const actions = await this.db.execute(
      `select ${PROFILE_PROXY_ACTIONS_TABLE}.* from ${PROFILE_PROXY_ACTIONS_TABLE} join ${PROFILE_PROXIES_TABLE} on ${PROFILE_PROXY_ACTIONS_TABLE}.proxy_id = ${PROFILE_PROXIES_TABLE}.id where ${PROFILE_PROXIES_TABLE}.target_id = :target_id`,
      { target_id },
      opts
    );
    return actions.map((action) => ({
      ...action,
      is_active: !!action.is_active
    }));
  }

  async findProfileProxyGrantedActionsByProfileId({
    created_by,
    connection
  }: {
    readonly created_by: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const actions = await this.db.execute(
      `select ${PROFILE_PROXY_ACTIONS_TABLE}.* from ${PROFILE_PROXY_ACTIONS_TABLE} join ${PROFILE_PROXIES_TABLE} on ${PROFILE_PROXY_ACTIONS_TABLE}.proxy_id = ${PROFILE_PROXIES_TABLE}.id where ${PROFILE_PROXIES_TABLE}.created_by = :created_by`,
      { created_by },
      opts
    );
    return actions.map((action) => ({
      ...action,
      is_active: !!action.is_active
    }));
  }

  async findProfileProxyGrantedActionsByGrantorAndGrantee({
    grantor,
    grantee
  }: {
    readonly grantor: string;
    readonly grantee: string;
  }): Promise<ProfileProxyActionEntity[]> {
    const actions = await this.db.execute(
      `
      select ${PROFILE_PROXY_ACTIONS_TABLE}.* 
      from ${PROFILE_PROXY_ACTIONS_TABLE} 
      join ${PROFILE_PROXIES_TABLE} on ${PROFILE_PROXY_ACTIONS_TABLE}.proxy_id = ${PROFILE_PROXIES_TABLE}.id 
      where ${PROFILE_PROXIES_TABLE}.created_by = :grantor and ${PROFILE_PROXIES_TABLE}.target_id = :grantee
      `,
      { grantor, grantee }
    );
    return actions.map((action) => ({
      ...action,
      is_active: !!action.is_active
    }));
  }

  async findProfileProxyActionsByProxyId({
    proxy_id,
    connection
  }: {
    readonly proxy_id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyActionEntity[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    const actions = await this.db.execute(
      `select * from ${PROFILE_PROXY_ACTIONS_TABLE} where proxy_id = :proxy_id`,
      { proxy_id },
      opts
    );
    return actions.map((action) => ({
      ...action,
      is_active: !!action.is_active
    }));
  }

  async findActiveProfileProxyActionsByProxyIds({
    proxy_ids
  }: {
    readonly proxy_ids: string[];
  }): Promise<ProfileProxyActionEntity[]> {
    if (!proxy_ids.length) {
      return [];
    }
    const now = Time.currentMillis();
    return await this.db.execute<ProfileProxyActionEntity>(
      `select * from ${PROFILE_PROXY_ACTIONS_TABLE} 
      where proxy_id in (:proxy_ids) 
      and start_time <= :now 
      and (end_time is null or end_time > :now)
      and (revoked_at is null or revoked_at > :now)
      and (rejected_at is null or rejected_at > :now)
      and (accepted_at is not null and accepted_at < :now)`,
      { proxy_ids, now }
    );
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

  async updateProfileProxyAction({
    action_id,
    credit_amount,
    end_time,
    connection
  }: {
    readonly action_id: string;
    readonly credit_amount?: number;
    readonly end_time?: number | null;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<void> {
    if (!credit_amount && end_time === undefined) {
      return;
    }
    const params: Record<string, any> = { id: action_id };
    let query = `update ${PROFILE_PROXY_ACTIONS_TABLE} set `;
    if (credit_amount) {
      query += `credit_amount = :credit_amount`;
      params.credit_amount = credit_amount;
    }
    if (end_time !== undefined) {
      query += `${credit_amount ? ', ' : ''}end_time = :end_time`;
      params.end_time = end_time;
    }
    query += ` where id = :id`;

    await this.db.execute(query, params, { wrappedConnection: connection });
  }

  async incrementCreditSpentForAction(
    param: { credit_spent_delta: number; id: string },
    connection?: ConnectionWrapper<any>
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${PROFILE_PROXY_ACTIONS_TABLE}
        set credit_spent = IFNULL(credit_spent, 0) + :credit_spent_delta
        where id = :id
          and (credit_amount is null or credit_amount - IFNULL(credit_spent, 0) >= :credit_spent_delta)`,
      param,
      connection ? { wrappedConnection: connection } : undefined
    );
    return this.getAffectedRows(result) === 1;
  }

  async getCreditSpentByActionIds({
    action_ids,
    connection
  }: {
    readonly action_ids: string[];
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<Record<string, number>> {
    if (!action_ids.length) {
      return {};
    }
    const rows = await this.db.execute<{
      id: string;
      credit_spent: number | null;
    }>(
      `select id, credit_spent from ${PROFILE_PROXY_ACTIONS_TABLE} where id in (:action_ids)`,
      { action_ids },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows.reduce(
      (acc, row) => {
        acc[row.id] = row.credit_spent ?? 0;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  private getAffectedRows(result: any): number {
    if (!result) {
      return 0;
    }
    if (typeof result === 'object' && 'affectedRows' in result) {
      return (result as any).affectedRows ?? 0;
    }
    return Array.isArray(result) && typeof result[1] === 'number'
      ? (result as any)[1]
      : 0;
  }

  async deleteAllProxiesAndActionsForProfile(
    profileId: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `delete balances from ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE} balances
      join ${PROFILE_PROXY_ACTIONS_TABLE} actions on balances.proxy_action_id = actions.id
      join ${PROFILE_PROXIES_TABLE} proxies on actions.proxy_id = proxies.id
      where proxies.target_id = :profileId or proxies.created_by = :profileId`,
      { profileId },
      { wrappedConnection: connectionHolder }
    );

    await this.db.execute(
      `delete from ${PROFILE_PROXY_ACTIONS_TABLE} where proxy_id in (select id from ${PROFILE_PROXIES_TABLE} where target_id = :profileId or created_by = :profileId)`,
      { profileId },
      { wrappedConnection: connectionHolder }
    );

    await this.db.execute(
      `delete from ${PROFILE_PROXIES_TABLE} where target_id = :profileId or created_by = :profileId`,
      { profileId },
      { wrappedConnection: connectionHolder }
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
