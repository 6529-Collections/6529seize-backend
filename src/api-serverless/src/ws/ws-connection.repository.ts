import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../../../sql-executor';
import { WSConnectionEntity } from '../../../entities/IWSConnection';
import {
  DROP_VOTER_STATE_TABLE,
  IDENTITIES_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  TDH_NFT_TABLE,
  USER_GROUPS_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_TABLE,
  WS_CONNECTIONS_TABLE
} from '@/constants';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { RequestContext } from '../../../request.context';
import { WaveCreditType } from '../../../entities/IWave';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { ANON_USER_ID } from './ws';

export class WsConnectionRepository extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

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
    {
      groupId,
      waveId
    }: {
      groupId: string | null;
      waveId: string;
    },
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

  async getCurrentlyOnlineCommunityMemberConnectionIdsWithDirectGroupMemberFallback(
    params: { groupId: string | null; waveId: string },
    ctx: RequestContext
  ): Promise<
    { connectionId: string; profileId: string | null; wave_id: string | null }[]
  > {
    try {
      return await this.getCurrentlyOnlineCommunityMemberConnectionIds(
        params,
        ctx
      );
    } catch (error) {
      if (params.groupId === null) {
        throw error;
      }
      this.logger.warn(
        `Could not resolve websocket community group ${params.groupId}; falling back to direct group members`,
        error
      );
      return await this.findDirectGroupMemberConnectionIds({
        groupId: params.groupId,
        waveId: params.waveId
      });
    }
  }

  private async findDirectGroupMemberConnectionIds({
    groupId,
    waveId
  }: {
    groupId: string;
    waveId: string;
  }): Promise<
    { connectionId: string; profileId: string | null; wave_id: string | null }[]
  > {
    return this.db
      .execute<{
        connection_id: string;
        profile_id: string | null;
        wave_id: string | null;
      }>(
        `select
          ws.connection_id as connection_id,
          ws.identity_id as profile_id,
          ws.wave_id as wave_id
        from ${WS_CONNECTIONS_TABLE} ws
        join ${USER_GROUPS_TABLE} ug
          on ug.id = :groupId
        join ${PROFILE_GROUPS_TABLE} pg
          on ug.profile_group_id = pg.profile_group_id
         and ws.identity_id = pg.profile_id
        where ws.wave_id = :waveId or ws.wave_id is null`,
        { groupId, waveId }
      )
      .then((res) =>
        res.map((it) => ({
          connectionId: it.connection_id,
          wave_id: it.wave_id,
          profileId: it.profile_id === ANON_USER_ID ? null : it.profile_id
        }))
      );
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
    const waveProps = await this.db.oneOrNull<{
      credit_type: WaveCreditType;
    }>(
      `select voting_credit_type as credit_type
         from ${WAVES_TABLE}
         where id = :waveId`,
      { waveId }
    );
    if (!waveProps) {
      return profileIds.reduce(
        (acc, profileId) => {
          acc[profileId] = 0;
          return acc;
        },
        {} as Record<string, number>
      );
    }
    switch (waveProps.credit_type) {
      case WaveCreditType.TDH:
      case WaveCreditType.XTDH:
      case WaveCreditType.TDH_PLUS_XTDH: {
        let creditSql = 'MAX(i.tdh)';
        if (waveProps.credit_type === WaveCreditType.XTDH) {
          creditSql = 'FLOOR(MAX(i.xtdh))';
        } else if (waveProps.credit_type === WaveCreditType.TDH_PLUS_XTDH) {
          creditSql = 'FLOOR(MAX(i.tdh + i.xtdh))';
        }
        const res = await this.db.execute<{
          profile_id: string;
          credit_left: number;
        }>(
          `
            with given_votes as (
              select voter_id as profile_id, sum(abs(votes)) as credit_spent
              from ${DROP_VOTER_STATE_TABLE}
              where wave_id = :waveId and voter_id in (:profileIds)
              group by 1
            ),
            profile_credit as (
              select i.profile_id as profile_id, ${creditSql} as total_credit
              from ${IDENTITIES_TABLE} i
              where i.profile_id in (:profileIds)
              group by i.profile_id
            )
            select pc.profile_id as profile_id,
                   pc.total_credit - ifnull(v.credit_spent, 0) as credit_left
            from profile_credit pc
            left join given_votes v on v.profile_id = pc.profile_id
          `,
          { waveId, profileIds }
        );
        return profileIds.reduce(
          (acc, profileId) => {
            acc[profileId] =
              res.find((row) => row.profile_id === profileId)?.credit_left ?? 0;
            return acc;
          },
          {} as Record<string, number>
        );
      }
      case WaveCreditType.CARD_SET_TDH: {
        const configuredCardCount = await this.db
          .oneOrNull<{ cnt: number }>(
            `
              select count(*) as cnt
              from ${WAVE_VOTING_CREDIT_NFTS_TABLE}
              where wave_id = :waveId
            `,
            { waveId }
          )
          .then((row) => row?.cnt ?? 0);
        if (!configuredCardCount) {
          throw new CustomApiCompliantException(
            500,
            `Wave ${waveId} is misconfigured: CARD_SET_TDH requires voting credit nfts [configuredCardCount=${configuredCardCount}]`
          );
        }
        const res = await this.db.execute<{
          profile_id: string;
          credit_left: number;
        }>(
          `
            with given_votes as (
              select voter_id as profile_id, sum(abs(votes)) as credit_spent
              from ${DROP_VOTER_STATE_TABLE}
              where wave_id = :waveId and voter_id in (:profileIds)
              group by 1
            ),
            profile_consolidation_keys as (
              select distinct profile_id, consolidation_key
              from ${IDENTITIES_TABLE}
              where profile_id in (:profileIds)
            ),
            profile_credit as (
              select p.profile_id as profile_id,
                     coalesce(sum(tn.boosted_tdh), 0) as total_credit
              from profile_consolidation_keys p
              join ${WAVE_VOTING_CREDIT_NFTS_TABLE} wvcn
                on wvcn.wave_id = :waveId
              left join ${TDH_NFT_TABLE} tn
                on tn.consolidation_key = p.consolidation_key
               and tn.contract = wvcn.contract
               and tn.id = wvcn.token_id
              group by p.profile_id
            )
            select pc.profile_id as profile_id,
                   pc.total_credit - ifnull(v.credit_spent, 0) as credit_left
            from profile_credit pc
            left join given_votes v on v.profile_id = pc.profile_id
          `,
          { waveId, profileIds }
        );
        return profileIds.reduce(
          (acc, profileId) => {
            acc[profileId] =
              res.find((row) => row.profile_id === profileId)?.credit_left ?? 0;
            return acc;
          },
          {} as Record<string, number>
        );
      }
      default:
        this.logger.warn(
          `[UNEXPECTED TDH CREDIT TYPE LOOKUP] [waveId=${waveId}] [creditType=${waveProps.credit_type}] [profileIds=${profileIds.join(',')}]`
        );
        return profileIds.reduce(
          (acc, profileId) => {
            acc[profileId] = 0;
            return acc;
          },
          {} as Record<string, number>
        );
    }
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

  async findWaveVisibilityGroupId(
    waveId: string
  ): Promise<string | null | undefined> {
    return this.db
      .oneOrNull<{
        visibility_group_id: string | null;
      }>(`select visibility_group_id from ${WAVES_TABLE} where id = :waveId`, {
        waveId
      })
      .then((row) => row?.visibility_group_id);
  }

  async findConnectionIdsByIdentityId(identityId: string): Promise<string[]> {
    if (!identityId || identityId === ANON_USER_ID) {
      return [];
    }
    return this.db
      .execute<{
        connection_id: string;
      }>(
        `select connection_id from ${WS_CONNECTIONS_TABLE} where identity_id = :identityId`,
        { identityId }
      )
      .then((res) => res.map((it) => it.connection_id));
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
