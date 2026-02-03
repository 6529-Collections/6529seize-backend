import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { IdentitySubscriptionEntity } from '../../../entities/IIdentitySubscription';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import {
  DROPS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  IncomingIdentitySubscriptionsParams,
  OutgoingIdentitySubscriptionsParams
} from './identity-subscriptions.routes';
import { Timer } from '../../../time';

export class IdentitySubscriptionsDb extends LazyDbAccessCompatibleService {
  async addIdentitySubscription(
    identitySubscription: Omit<IdentitySubscriptionEntity, 'id'>,
    connection: ConnectionWrapper<any>,
    timer?: Timer
  ) {
    timer?.start('identitySubscriptionsDb->addIdentitySubscription');
    if (identitySubscription.target_type === ActivityEventTargetType.WAVE) {
      const waveId = identitySubscription.target_id;
      await this.db.execute(
        `
        insert into ${WAVE_METRICS_TABLE} 
            (wave_id, drops_count, subscribers_count) 
        values (:waveId, 0, 1) 
        on duplicate key update subscribers_count = (subscribers_count + 1);
      `,
        { waveId },
        { wrappedConnection: connection }
      );
    }
    await this.db.execute(
      `
      insert into ${IDENTITY_SUBSCRIPTIONS_TABLE} (subscriber_id, target_id, target_type, target_action, wave_id, subscribed_to_all_drops)
      values (:subscriber_id, :target_id, :target_type, :target_action, :wave_id, :subscribed_to_all_drops)
    `,
      identitySubscription,
      {
        wrappedConnection: connection
      }
    );
    timer?.stop('identitySubscriptionsDb->addIdentitySubscription');
  }

  async findIdentitySubscriptionActionsOfTargets(
    param: {
      subscriber_id: string;
      target_ids: string[];
      target_type: ActivityEventTargetType;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, ActivityEventAction[]>> {
    if (!param.target_ids.length) {
      return {};
    }
    return this.db
      .execute<{ target_id: string; target_action: ActivityEventAction }>(
        `
      select target_id, target_action from ${IDENTITY_SUBSCRIPTIONS_TABLE} 
      where subscriber_id = :subscriber_id 
      and target_id in (:target_ids) and target_type = :target_type`,
        param,
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((result) =>
        result.reduce(
          (acc, it) => {
            if (!acc[it.target_id]) {
              acc[it.target_id] = [];
            }
            acc[it.target_id].push(it.target_action);
            return acc;
          },
          {} as Record<string, ActivityEventAction[]>
        )
      );
  }

  async findIdentitySubscriptionActionsOfTarget(
    param: {
      subscriber_id: string;
      target_id: string;
      target_type: ActivityEventTargetType;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<ActivityEventAction[]> {
    return this.db
      .execute<{ target_action: ActivityEventAction }>(
        `
      select target_action from ${IDENTITY_SUBSCRIPTIONS_TABLE} 
      where subscriber_id = :subscriber_id 
      and target_id = :target_id and target_type = :target_type`,
        param,
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) => it.map((it) => it.target_action));
  }

  async deleteIdentitySubscription(
    param: {
      subscriber_id: string;
      target_type: ActivityEventTargetType;
      target_id: string;
      target_action: ActivityEventAction;
    },
    connection: ConnectionWrapper<any>
  ) {
    if (param.target_type === ActivityEventTargetType.WAVE) {
      const waveId = param.target_id;
      await this.db.execute(
        `
        insert into ${WAVE_METRICS_TABLE} 
            (wave_id, drops_count, subscribers_count) 
        values (:waveId, 0, 1) 
        on duplicate key update subscribers_count = (subscribers_count - 1);
      `,
        { waveId },
        { wrappedConnection: connection }
      );
    }
    await this.db.execute(
      `
      delete from ${IDENTITY_SUBSCRIPTIONS_TABLE}
      where subscriber_id = :subscriber_id
      and target_id = :target_id
      and target_type = :target_type
      and target_action = :target_action
    `,
      param,
      {
        wrappedConnection: connection
      }
    );
  }

  async findSubscriberIdsAndActionsForTarget(
    params: IncomingIdentitySubscriptionsParams
  ): Promise<Record<string, ActivityEventAction[]>> {
    return this.db
      .execute<{ id: string; actions: string }>(
        `
      with scr as (select s.subscriber_id as id, group_concat(target_action) as actions
             from ${IDENTITY_SUBSCRIPTIONS_TABLE} s
             where s.target_id = :target_id
               and s.target_type = :target_type
             group by 1)
      select scr.*
      from scr
               join ${IDENTITIES_TABLE} i on scr.id = i.profile_id
      order by i.level_raw desc
      limit :limit offset :offset
    `,
        {
          ...params,
          offset: (params.page - 1) * params.page_size,
          limit: params.page_size
        }
      )
      .then((result) =>
        result.reduce(
          (acc, it) => {
            acc[it.id] = it.actions.split(',') as ActivityEventAction[];
            return acc;
          },
          {} as Record<string, ActivityEventAction[]>
        )
      );
  }

  async findTargetIdsAndActionsForTarget(
    params: OutgoingIdentitySubscriptionsParams,
    eligibleGroupIds: string[]
  ): Promise<Record<string, ActivityEventAction[]>> {
    return this.db
      .execute<{ id: string; actions: string }>(
        `
      with scr as (select s.target_id as id, group_concat(target_action) as actions
             from ${IDENTITY_SUBSCRIPTIONS_TABLE} s
             ${
               params.target_type === ActivityEventTargetType.WAVE
                 ? `join ${WAVES_TABLE} w on s.target_id = w.id and (w.visibility_group_id is null ${
                     eligibleGroupIds.length
                       ? `or w.visibility_group_id in (:eligibleGroupIds)`
                       : ``
                   })`
                 : ''
             }
          ${
            params.target_type === ActivityEventTargetType.DROP
              ? `join ${DROPS_TABLE} d on s.target_id = d.id
              join ${WAVES_TABLE} w on d.wave_id = w.id and (w.visibility_group_id is null ${
                eligibleGroupIds.length
                  ? `or w.visibility_group_id in (:eligibleGroupIds)`
                  : ``
              })`
              : ''
          }
             where s.subscriber_id = :subscriber_id
               and s.target_type = :target_type
             group by 1)
      select scr.* from scr
      order by scr.id desc
      limit :limit offset :offset
    `,
        {
          ...params,
          eligibleGroupIds,
          offset: (params.page - 1) * params.page_size,
          limit: params.page_size
        }
      )
      .then((result) =>
        result.reduce(
          (acc, it) => {
            acc[it.id] = it.actions.split(',') as ActivityEventAction[];
            return acc;
          },
          {} as Record<string, ActivityEventAction[]>
        )
      );
  }

  async countDistinctSubscriberIdsForTarget(
    params: Omit<IncomingIdentitySubscriptionsParams, 'page' | 'page_size'>
  ): Promise<number> {
    return this.db
      .oneOrNull<{
        cnt: number;
      }>(
        `select count(distinct subscriber_id) as cnt from ${IDENTITY_SUBSCRIPTIONS_TABLE} where target_id = :target_id and target_type = :target_type`,
        params
      )
      .then((it) => it?.cnt ?? 0);
  }

  async countWaveSubscribers(waveId: string) {
    return this.countDistinctSubscriberIdsForTarget({
      target_id: waveId,
      target_type: ActivityEventTargetType.WAVE
    });
  }

  async countTargetIdsAndActionsForTarget(
    params: OutgoingIdentitySubscriptionsParams,
    eligibleGroupIds: string[]
  ): Promise<number> {
    return this.db
      .oneOrNull<{ cnt: number }>(
        `select count(distinct s.target_id) as cnt from ${IDENTITY_SUBSCRIPTIONS_TABLE} s 
        ${
          params.target_type === ActivityEventTargetType.WAVE
            ? `join ${WAVES_TABLE} w on s.target_id = w.id and (w.visibility_group_id is null ${
                eligibleGroupIds.length
                  ? `or w.visibility_group_id in (:eligibleGroupIds)`
                  : ``
              })`
            : ''
        }
          ${
            params.target_type === ActivityEventTargetType.DROP
              ? `join ${DROPS_TABLE} d on s.target_id = d.id
              join ${WAVES_TABLE} w on d.wave_id = w.id and (w.visibility_group_id is null ${
                eligibleGroupIds.length
                  ? `or w.visibility_group_id in (:eligibleGroupIds)`
                  : ``
              })`
              : ''
          }
        where s.subscriber_id = :subscriber_id and s.target_type = :target_type`,
        {
          ...params,
          eligibleGroupIds,
          offset: (params.page - 1) * params.page_size,
          limit: params.page_size
        }
      )
      .then((result) => result?.cnt ?? 0);
  }

  async findWaveSubscribers(
    waveId: string,
    connection: ConnectionWrapper<any>
  ) {
    return this.db
      .execute<{
        subscriber_id: string;
      }>(
        `select subscriber_id from ${IDENTITY_SUBSCRIPTIONS_TABLE} where target_id = :waveId and target_type = :target_type`,
        { waveId, target_type: ActivityEventTargetType.WAVE },
        { wrappedConnection: connection }
      )
      .then((it) => it.map((it) => it.subscriber_id));
  }

  async findWaveSubscribedAllSubscribers(
    waveId: string,
    connection: ConnectionWrapper<any>
  ) {
    return this.db
      .execute<{
        subscriber_id: string;
      }>(
        `select subscriber_id from ${IDENTITY_SUBSCRIPTIONS_TABLE} where target_id = :waveId and target_type = :target_type and subscribed_to_all_drops = true`,
        { waveId, target_type: ActivityEventTargetType.WAVE },
        { wrappedConnection: connection }
      )
      .then((it) => it.map((it) => it.subscriber_id));
  }

  async updateIdentityIdsInSubscriptions(
    sourceIdentity: string,
    target: string,
    connection: ConnectionWrapper<any>
  ) {
    // Step 1: Delete any rows that would conflict after changing subscriber_id
    await this.db.execute(
      `
      DELETE FROM ${IDENTITY_SUBSCRIPTIONS_TABLE}
      WHERE subscriber_id = :target
        AND target_id IN (
          SELECT target_id FROM (
            SELECT target_id FROM ${IDENTITY_SUBSCRIPTIONS_TABLE}
            WHERE subscriber_id = :sourceIdentity
          ) AS temp
        )
      `,
      { sourceIdentity, target },
      { wrappedConnection: connection }
    );

    // Step 2: Update subscriber_id from sourceIdentity → target
    await this.db.execute(
      `
      UPDATE ${IDENTITY_SUBSCRIPTIONS_TABLE}
      SET subscriber_id = :target
      WHERE subscriber_id = :sourceIdentity
      `,
      { sourceIdentity, target },
      { wrappedConnection: connection }
    );

    // Step 3: Delete any rows that would conflict after changing target_id (only where target_type = 'IDENTITY')
    await this.db.execute(
      `
      DELETE FROM ${IDENTITY_SUBSCRIPTIONS_TABLE}
      WHERE target_id = :target
        AND target_type = '${ActivityEventTargetType.IDENTITY}'
        AND subscriber_id IN (
          SELECT subscriber_id FROM (
            SELECT subscriber_id FROM ${IDENTITY_SUBSCRIPTIONS_TABLE}
            WHERE target_id = :sourceIdentity
              AND target_type = '${ActivityEventTargetType.IDENTITY}'
          ) AS temp
        )
      `,
      { sourceIdentity, target },
      { wrappedConnection: connection }
    );

    // Step 4: Update target_id from sourceIdentity → target (only where target_type = 'IDENTITY')
    await this.db.execute(
      `
      UPDATE ${IDENTITY_SUBSCRIPTIONS_TABLE}
      SET target_id = :target
      WHERE target_id = :sourceIdentity
        AND target_type = '${ActivityEventTargetType.IDENTITY}'
      `,
      { sourceIdentity, target },
      { wrappedConnection: connection }
    );
  }

  async resyncWaveSubscriptionsMetrics(connection?: ConnectionWrapper<any>) {
    await this.db.execute(
      `
        update ${WAVE_METRICS_TABLE}
        inner join (select target_id as wave_id, count(distinct subscriber_id) as followers_count
                    from ${IDENTITY_SUBSCRIPTIONS_TABLE}
                    where target_type = 'WAVE' and target_action = 'DROP_CREATED' group by 1) x on x.wave_id = ${WAVE_METRICS_TABLE}.wave_id
        set ${WAVE_METRICS_TABLE}.subscribers_count = x.followers_count
        where ${WAVE_METRICS_TABLE}.subscribers_count <> x.followers_count
    `,
      undefined,
      { wrappedConnection: connection }
    );
  }

  async getWaveSubscription(
    identityId: string,
    waveId: string
  ): Promise<boolean> {
    return this.db
      .oneOrNull<{
        subscribed_to_all_drops: boolean;
      }>(
        `select subscribed_to_all_drops from ${IDENTITY_SUBSCRIPTIONS_TABLE} where subscriber_id = :identityId and target_id = :waveId and target_type = :target_type`,
        { identityId, waveId, target_type: ActivityEventTargetType.WAVE }
      )
      .then((it) => it?.subscribed_to_all_drops ?? false);
  }

  async subscribeToAllDrops(
    identityId: string,
    waveId: string,
    connection?: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${IDENTITY_SUBSCRIPTIONS_TABLE} set subscribed_to_all_drops = true where subscriber_id = :identityId and target_id = :waveId and target_type = :target_type`,
      { identityId, waveId, target_type: ActivityEventTargetType.WAVE },
      { wrappedConnection: connection }
    );
  }

  async unsubscribeFromAllDrops(
    identityId: string,
    waveId: string,
    connection?: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${IDENTITY_SUBSCRIPTIONS_TABLE} set subscribed_to_all_drops = false where subscriber_id = :identityId and target_id = :waveId and target_type = :target_type`,
      { identityId, waveId, target_type: ActivityEventTargetType.WAVE },
      { wrappedConnection: connection }
    );
  }
}

export const identitySubscriptionsDb = new IdentitySubscriptionsDb(dbSupplier);
