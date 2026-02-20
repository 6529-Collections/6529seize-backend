import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../../../sql-executor';
import { WSConnectionEntity } from '../../../entities/IWSConnection';
import {
  DROP_VOTER_STATE_TABLE,
  IDENTITIES_TABLE,
  RATINGS_TABLE,
  WS_CONNECTIONS_TABLE
} from '@/constants';
import { RequestContext } from '../../../request.context';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { ANON_USER_ID } from './ws';

export class WsConnectionRepository extends LazyDbAccessCompatibleService {
  constructor(
    sqlExecutorGetter: () => SqlExecutor,
    private readonly userGroupsService: UserGroupsService
  ) {
    super(sqlExecutorGetter);
  }

  public async save(entity: WSConnectionEntity, ctx: RequestContext) {
    await this.db.execute(
      `insert into ${WS_CONNECTIONS_TABLE} (connection_id, jwt_expiry, identity_id) values (:connection_id, :jwt_expiry, :identity_id)`,
      entity,
      { wrappedConnection: ctx.connection }
    );
  }

  public async updateWaveId(
    params: { connectionId: string; waveId: string | null },
    ctx: RequestContext
  ) {
    await this.db.execute(
      `update ${WS_CONNECTIONS_TABLE} set wave_id = :waveId where connection_id = :connectionId`,
      params,
      { wrappedConnection: ctx.connection }
    );
  }

  public async deleteByConnectionId(connectionId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${WS_CONNECTIONS_TABLE} where connection_id = :connectionId`,
      { connectionId },
      { wrappedConnection: ctx.connection }
    );
  }

  public async getByConnectionId(
    connectionId: string,
    ctx: RequestContext
  ): Promise<WSConnectionEntity | null> {
    return this.db.oneOrNull<WSConnectionEntity>(
      `select * from ${WS_CONNECTIONS_TABLE} where connection_id = :connectionId`,
      { connectionId },
      { wrappedConnection: ctx.connection }
    );
  }

  async getCurrentlyOnlineCommunityMemberConnectionIds(
    { groupId, waveId }: { groupId: string | null; waveId: string },
    ctx: RequestContext
  ): Promise<
    { connectionId: string; profileId: string | null; wave_id: string | null }[]
  > {
    ctx.timer?.start(
      `${this.constructor.name}->getCurrentlyOnlineCommunityMemberConnectionIds`
    );
    if (groupId === null) {
      const result = await this.db
        .execute<{
          connection_id: string;
          profile_id: string | null;
          wave_id: string | null;
        }>(
          `select
        ws.connection_id as connection_id,
        ws.identity_id as profile_id,
        ws.wave_id as wave_id
      from ${WS_CONNECTIONS_TABLE} ws where ws.wave_id = :waveId or ws.wave_id is null `,
          { waveId }
        )
        .then((res) =>
          res.map((it) => ({
            connectionId: it.connection_id,
            wave_id: it.wave_id,
            profileId: it.profile_id === ANON_USER_ID ? null : it.profile_id
          }))
        );
      ctx?.timer?.stop(
        `${this.constructor.name}->getCurrentlyOnlineCommunityMemberConnectionIds`
      );
      return result;
    }
    const viewResult = await this.userGroupsService.getSqlAndParamsByGroupId(
      groupId,
      ctx
    );
    if (viewResult === null) {
      ctx?.timer?.stop(
        `${this.constructor.name}->getCurrentlyOnlineCommunityMemberConnectionIds`
      );
      return [];
    }
    const sql = `
      ${viewResult.sql} 
      select
        ws.connection_id as connection_id,
        ws.identity_id as profile_id,
        ws.wave_id as wave_id
      from ${WS_CONNECTIONS_TABLE} ws
      join ${UserGroupsService.GENERATED_VIEW} cm
      on ws.identity_id = cm.profile_id
    `;
    const params = viewResult.params;
    const result = await this.db
      .execute<{
        connection_id: string;
        profile_id: string | null;
        wave_id: string | null;
      }>(sql, params)
      .then((res) =>
        res.map((it) => ({
          connectionId: it.connection_id,
          wave_id: it.wave_id,
          profileId: it.profile_id === ANON_USER_ID ? null : it.profile_id
        }))
      );
    ctx?.timer?.stop(
      `${this.constructor.name}->getCurrentlyOnlineCommunityMemberConnectionIds`
    );
    return result;
  }

  async getCreditLeftForProfilesForTdhBasedWave({
    profileIds,
    waveId
  }: {
    profileIds: string[];
    waveId: string;
  }): Promise<Record<string, number>> {
    if (!profileIds.length) {
      return {};
    }
    const res = await this.db.execute<{
      profile_id: string;
      credit_left: number;
    }>(
      `
        with given_votes as (select voter_id as profile_id, sum(abs(votes)) as credit_spent from ${DROP_VOTER_STATE_TABLE}
            where wave_id = :waveId and voter_id in (:profileIds)
            group by 1)
        select i.profile_id as profile_id, i.tdh - ifnull(v.credit_spent, 0) as credit_left from ${IDENTITIES_TABLE} i 
             left join given_votes v on v.profile_id = i.profile_id
             where i.profile_id in (:profileIds)
    `,
      { waveId, profileIds }
    );
    return profileIds.reduce(
      (acc, it) => {
        acc[it] = res.find((r) => r.profile_id)?.credit_left ?? 0;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  async getCreditLeftForProfilesForRepBasedWave({
    profileIds,
    waveId
  }: {
    profileIds: string[];
    waveId: string;
  }): Promise<Record<string, number>> {
    if (!profileIds.length) {
      return {};
    }
    const waveProps = await this.db.oneOrNull<{
      rep_giver: string | null;
      rep_category: string | null;
    }>(
      `select voting_credit_category as rep_category, voting_credit_creditor as rep_giver from waves where id = :waveId`,
      { waveId }
    );
    const rep_giver = waveProps?.rep_giver ?? null;
    const rep_category = waveProps?.rep_category ?? null;
    const res = await this.db.execute<{
      profile_id: string;
      credit_left: number;
    }>(
      `
        with given_votes as (select voter_id as profile_id, sum(abs(votes)) as credit_spent from ${DROP_VOTER_STATE_TABLE}
            where wave_id = :waveId and voter_id in (:profileIds)
            group by 1),
        total_reps as (select matter_target_id as profile_id, sum(rating) as rep from ${RATINGS_TABLE} where matter_target_id in (:profileIds) and matter = 'REP' and rating <> 0 ${
          rep_giver ? ` and rater_profile_id = :rep_giver ` : ``
        } ${
          rep_category ? ` and matter_category = :rep_category ` : ``
        } group by 1) select i.profile_id as profile_id, i.rep - ifnull(v.credit_spent, 0) as credit_left from total_reps i 
             left join given_votes v on v.profile_id = i.profile_id
             where i.profile_id in (:profileIds)
    `,
      { waveId, profileIds, rep_giver, rep_category }
    );
    return profileIds.reduce(
      (acc, it) => {
        acc[it] = res.find((r) => r.profile_id)?.credit_left ?? 0;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  async findAllByWaveId(waveId: string): Promise<WSConnectionEntity[]> {
    return this.db.execute<WSConnectionEntity>(
      `
    select * from ${WS_CONNECTIONS_TABLE} where wave_id = :waveId
    `,
      { waveId }
    );
  }

  async findAllConnectionIds(): Promise<string[]> {
    return this.db
      .execute<{ connection_id: string }>(
        `
    select distinct connection_id from ${WS_CONNECTIONS_TABLE}
    `
      )
      .then((res) => res.map((it) => it.connection_id));
  }
}

export const wsConnectionRepository = new WsConnectionRepository(
  dbSupplier,
  userGroupsService
);
