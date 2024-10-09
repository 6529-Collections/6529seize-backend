import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../sql-executor';
import {
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropReferencedNftEntity,
  DropType
} from '../entities/IDrop';
import {
  ACTIVITY_EVENTS_TABLE,
  DELETED_DROPS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROP_RELATIONS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  RATINGS_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_TABLE
} from '../constants';
import {
  userGroupsService,
  UserGroupsService
} from '../api-serverless/src/community-members/user-groups.service';
import { Time, Timer } from '../time';
import { DropVoteCreditSpending } from '../entities/IDropVoteCreditSpending';
import { RateMatter } from '../entities/IRating';
import { PageSortDirection } from '../api-serverless/src/page-request';
import { WaveEntity } from '../entities/IWave';
import { NotFoundException } from '../exceptions';
import { RequestContext } from '../request.context';
import { ActivityEventTargetType } from '../entities/IActivityEvent';
import { DeletedDropEntity } from '../entities/IDeletedDrop';
import { DropRelationEntity } from '../entities/IDropRelation';
import { DropSearchStrategy } from '../api-serverless/src/generated/models/DropSearchStrategy';

const mysql = require('mysql');

export class DropsDb extends LazyDbAccessCompatibleService {
  constructor(
    supplyDb: () => SqlExecutor,
    private readonly userGroupsService: UserGroupsService
  ) {
    super(supplyDb);
  }

  async getDropsByIds(
    ids: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropEntity[]> {
    if (!ids.length) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROPS_TABLE} where id in (:ids)`,
      {
        ids
      },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async insertDrop(
    newDropEntity: NewDropEntity,
    connection: ConnectionWrapper<any>
  ) {
    const dropId = newDropEntity.id;
    const waveId = newDropEntity.wave_id;
    const replyToDropId = newDropEntity.reply_to_drop_id;
    const newDropSerialNo = newDropEntity.serial_no;
    const now = Time.currentMillis();
    await Promise.all([
      this.db.execute(
        `
        insert into ${WAVE_METRICS_TABLE} 
            (wave_id, drops_count, subscribers_count, participatory_drops_count, latest_drop_timestamp) 
        values (:waveId, ${
          newDropEntity.drop_type === DropType.CHAT ? 1 : 0
        }, 0, ${
          newDropEntity.drop_type === DropType.PARTICIPATORY ? 1 : 0
        }, :now) 
        on duplicate key update drops_count = (drops_count + ${
          newDropEntity.drop_type === DropType.CHAT ? 1 : 0
        }), participatory_drops_count = (participatory_drops_count + ${
          newDropEntity.drop_type === DropType.PARTICIPATORY ? 1 : 0
        }), latest_drop_timestamp = :now
      `,
        { waveId, now },
        { wrappedConnection: connection }
      ),
      this.db.execute(
        `
            insert into ${WAVE_DROPPER_METRICS_TABLE}
                (wave_id, dropper_id, drops_count, participatory_drops_count, latest_drop_timestamp)
            values (:waveId, :dropperId, ${
              newDropEntity.drop_type === DropType.CHAT ? 1 : 0
            }, ${
          newDropEntity.drop_type === DropType.PARTICIPATORY ? 1 : 0
        }, :now)
            on duplicate key update drops_count = (drops_count + ${
              newDropEntity.drop_type === DropType.CHAT ? 1 : 0
            }), participatory_drops_count = (participatory_drops_count + ${
          newDropEntity.drop_type === DropType.PARTICIPATORY ? 1 : 0
        }), latest_drop_timestamp = :now
        `,
        { waveId, dropperId: newDropEntity.author_id, now },
        { wrappedConnection: connection }
      ),
      this.db.execute(
        `insert into ${DROPS_TABLE} (
                            id,
                            author_id,
                            drop_type,
                            wave_id,
                            created_at, 
                            updated_at,
                            title,
                            parts_count,
                            reply_to_drop_id,
                            reply_to_part_id${
                              newDropSerialNo !== null ? `, serial_no` : ``
                            }
    ) values (
              :id,
              :author_id,
              :drop_type,
              :wave_id,
              :created_at,
              :updated_at,
              :title,
              :parts_count,
              :reply_to_drop_id,
              :reply_to_part_id
              ${newDropSerialNo !== null ? `, :serial_no` : ``}
             )`,

        { ...newDropEntity },
        { wrappedConnection: connection }
      )
    ]);
    if (replyToDropId) {
      const serialNo = await this.db
        .oneOrNull<{ serial_no: number }>(
          `select serial_no from ${DROPS_TABLE} where id = :id and wave_id = :wave_id`,
          { id: dropId, wave_id: waveId },
          { wrappedConnection: connection }
        )
        .then((it) => it!.serial_no);
      const existingDropRelations = await this.db.execute<DropRelationEntity>(
        `select * from ${DROP_RELATIONS_TABLE} where child_id = :child_id and wave_id = :wave_id`,
        {
          child_id: replyToDropId,
          wave_id: waveId
        },
        { wrappedConnection: connection }
      );
      const newRelations: Omit<DropRelationEntity, 'id'>[] =
        existingDropRelations.map((it) => ({
          ...it,
          id: undefined,
          child_id: dropId,
          child_serial_no: serialNo,
          waveId: waveId
        }));
      newRelations.push({
        parent_id: replyToDropId,
        child_id: dropId,
        child_serial_no: serialNo,
        wave_id: waveId
      });
      await this.db.execute(
        `delete from ${DROP_RELATIONS_TABLE} where child_id = :id`,
        { id: dropId },
        { wrappedConnection: connection }
      );
      const insertRelationsSql = `
        insert into ${DROP_RELATIONS_TABLE} (
            parent_id,
            child_id,
            child_serial_no,
            wave_id
        ) values ${newRelations
          .map(
            (relation) =>
              `(${mysql.escape(relation.parent_id)}, ${mysql.escape(
                relation.child_id
              )}, ${mysql.escape(relation.child_serial_no)}, ${mysql.escape(
                relation.wave_id
              )})`
          )
          .join(', ')}
        `;
      await this.db.execute(
        insertRelationsSql,
        {},
        { wrappedConnection: connection }
      );
    }
  }

  async insertMentions(
    mentions: Omit<DropMentionEntity, 'id'>[],
    connection: ConnectionWrapper<any>
  ) {
    for (const mention of mentions) {
      await this.db.execute(
        `insert into ${DROPS_MENTIONS_TABLE} (
                            drop_id, 
                            mentioned_profile_id,
                            handle_in_content,
                            wave_id
    ) values (
              :drop_id, 
              :mentioned_profile_id,
              :handle_in_content,
              :wave_id
   )`,
        mention,
        { wrappedConnection: connection }
      );
    }
  }

  async insertReferencedNfts(
    references: Omit<DropReferencedNftEntity, 'id'>[],
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start('dropsDb->insertReferencedNfts');
    await Promise.all(
      references.map((reference) =>
        this.db.execute(
          `insert into ${DROP_REFERENCED_NFTS_TABLE} (
                            drop_id, 
                            contract,
                            token,
                            name,
                            wave_id
    ) values (
              :drop_id, 
              :contract,
              :token,
              :name,
              :wave_id
             )`,
          reference,
          { wrappedConnection: connection }
        )
      )
    );
    timer.stop('dropsDb->insertReferencedNfts');
  }

  async insertDropMetadata(
    metadatas: Omit<DropMetadataEntity, 'id'>[],
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start(`dropsDb->insertDropMetadata`);
    await Promise.all(
      metadatas.map((metadata) =>
        this.db.execute(
          `insert into ${DROP_METADATA_TABLE} (
                            drop_id, 
                            data_key,
                            data_value,
                            wave_id
    ) values (
              :drop_id, 
              :data_key,
              :data_value,
              :wave_id
             )`,
          metadata,
          { wrappedConnection: connection }
        )
      )
    );
    timer.stop(`dropsDb->insertDropMetadata`);
  }

  async findDropById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<DropEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `
        select d.* from ${DROPS_TABLE} d where d.id = :id
        `,
        {
          id
        },
        opts
      )
      .then((it) => it[0] || null);
  }

  async findDropByIdWithEligibilityCheck(
    id: string,
    group_ids_user_is_eligible_for: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `
        select d.* from ${DROPS_TABLE} d
         join waves w on d.wave_id = w.id and (${
           group_ids_user_is_eligible_for.length
             ? `w.visibility_group_id in (:group_ids_user_is_eligible_for) or w.admin_group_id in (:group_ids_user_is_eligible_for) or`
             : ``
         } w.visibility_group_id is null)
         where d.id = :id
        `,
        {
          id,
          group_ids_user_is_eligible_for
        },
        opts
      )
      .then((it) => it[0] || null);
  }

  async findDropByIdAndAuthor(
    {
      id,
      author_id,
      eligible_groups
    }: { id: string; author_id: string; eligible_groups?: string[] },
    { connection, timer }: RequestContext
  ): Promise<DropEntity | null> {
    timer?.start(`dropsDb->findDropByIdAndAuthor`);
    const opts = connection ? { wrappedConnection: connection } : {};
    const result = await this.db.oneOrNull<DropEntity>(
      `
        select d.* from ${DROPS_TABLE} d
         ${
           eligible_groups === undefined
             ? ``
             : `join waves w on d.wave_id = w.id and (${
                 eligible_groups.length
                   ? `w.visibility_group_id in (:group_ids_user_is_eligible_for) or w.admin_group_id in (:group_ids_user_is_eligible_for) or`
                   : ``
               } w.visibility_group_id is null)`
         }
         where d.id = :id and d.author_id = :author_id
        `,
      {
        id,
        eligible_groups,
        author_id
      },
      opts
    );
    timer?.stop(`dropsDb->findDropByIdAndAuthor`);
    return result;
  }

  async findDropByIdWithoutEligibilityCheck(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<DropEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `
        select d.* from ${DROPS_TABLE} d
         where d.id = :id
        `,
        {
          id
        },
        opts
      )
      .then((it) => it[0] || null);
  }

  async findLatestDrops(
    {
      amount,
      serial_no_less_than,
      group_ids_user_is_eligible_for,
      group_id,
      wave_id,
      author_id,
      include_replies
    }: {
      group_id: string | null;
      group_ids_user_is_eligible_for: string[];
      serial_no_less_than: number | null;
      amount: number;
      wave_id: string | null;
      author_id: string | null;
      include_replies: boolean;
    },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    const sqlAndParams = await this.userGroupsService.getSqlAndParamsByGroupId(
      group_id,
      ctx
    );
    if (!sqlAndParams) {
      return [];
    }
    const serialNoLessThan = serial_no_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `${sqlAndParams.sql} select d.* from ${DROPS_TABLE} d
         join ${
           UserGroupsService.GENERATED_VIEW
         } cm on cm.profile_id = d.author_id
         join ${WAVES_TABLE} w on d.wave_id = w.id and (${
      group_ids_user_is_eligible_for.length
        ? `w.visibility_group_id in (:groupsUserIsEligibleFor) or w.admin_group_id in (:groupsUserIsEligibleFor) or`
        : ``
    } w.visibility_group_id is null) ${wave_id ? `and w.id = :wave_id` : ``}
         where d.serial_no < :serialNoLessThan ${
           !include_replies ? `and reply_to_drop_id is null` : ``
         } ${
      author_id ? ` and d.author_id = :author_id ` : ``
    } order by d.serial_no desc limit ${amount}`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      serialNoLessThan,
      groupsUserIsEligibleFor: group_ids_user_is_eligible_for,
      author_id,
      wave_id
    };
    return this.db.execute(sql, params);
  }

  async findLatestDropsSimple(
    {
      amount,
      serial_no_limit,
      search_strategy,
      wave_id
    }: {
      serial_no_limit: number | null;
      search_strategy: string;
      amount: number;
      wave_id: string;
    },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start('dropsDb->findLatestDropsSimple');
    const sqlForOlder = `(select d.* from ${DROPS_TABLE} d where d.wave_id = :wave_id and d.serial_no < :serial_no_limit order by d.serial_no desc limit ${amount})`;
    const sqlForNewer = `(select d.* from ${DROPS_TABLE} d where d.wave_id = :wave_id and d.serial_no > :serial_no_limit order by d.serial_no asc limit ${amount})`;
    const sqlForThis = `(select d.* from ${DROPS_TABLE} d where d.wave_id = :wave_id and d.serial_no = :serial_no_limit)`;
    const sql = `with dr_results as (${[
      search_strategy === DropSearchStrategy.Newer ||
      search_strategy === DropSearchStrategy.Both
        ? sqlForNewer
        : undefined,
      search_strategy === DropSearchStrategy.Both ? sqlForThis : undefined,
      search_strategy === DropSearchStrategy.Older ||
      search_strategy === DropSearchStrategy.Both
        ? sqlForOlder
        : undefined
    ]
      .filter((it) => !!it)
      .join(' union all ')}) select * from dr_results order by serial_no desc`;
    const params = {
      wave_id,
      serial_no_limit: serial_no_limit ?? Number.MAX_SAFE_INTEGER
    };
    const results = await this.db.execute<DropEntity>(sql, params, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop('dropsDb->findLatestDropsSimple');
    return results;
  }

  async findLatestDropRepliesSimple(
    {
      amount,
      drop_id,
      serial_no_limit,
      search_strategy
    }: {
      amount: number;
      drop_id: string;
      serial_no_limit: number | null;
      search_strategy: string;
    },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start('dropsDb->findLatestDropRepliesSimple');
    const sqlForOlder = `(select d.* from ${DROPS_TABLE} d join ${DROP_RELATIONS_TABLE} r on d.id = r.child_id where r.parent_id = :drop_id and serial_no < :serial_no_limit order by d.serial_no desc limit ${amount})`;
    const sqlForNewer = `(select d.* from ${DROPS_TABLE} d join ${DROP_RELATIONS_TABLE} r on d.id = r.child_id where r.parent_id = :drop_id and serial_no > :serial_no_limit order by d.serial_no asc limit ${amount})`;
    const sqlForThis = `select d.* from ${DROPS_TABLE} d join ${DROP_RELATIONS_TABLE} r on d.id = r.child_id where r.parent_id = :drop_id and serial_no = :serial_no_limit`;
    const sql = `with dr_results as (${[
      search_strategy === DropSearchStrategy.Newer ||
      search_strategy === DropSearchStrategy.Both
        ? sqlForNewer
        : undefined,
      search_strategy === DropSearchStrategy.Both ? sqlForThis : undefined,
      search_strategy === DropSearchStrategy.Older ||
      search_strategy === DropSearchStrategy.Both
        ? sqlForOlder
        : undefined
    ]
      .filter((it) => !!it)
      .join(' union all ')}) select * from dr_results order by serial_no desc`;
    const params = {
      drop_id,
      serial_no_limit: serial_no_limit ?? Number.MAX_SAFE_INTEGER
    };
    const results = await this.db.execute<DropEntity>(sql, params, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop('dropsDb->findLatestDropRepliesSimple');
    return results;
  }

  async findMentionsByDropIds(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropMentionEntity[]> {
    if (dropIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROPS_MENTIONS_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async findReferencedNftsByDropIds(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropReferencedNftEntity[]> {
    if (dropIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROP_REFERENCED_NFTS_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async findMetadataByDropIds(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropMetadataEntity[]> {
    if (dropIds.length === 0) {
      return [];
    }
    return this.db.execute(
      `select * from ${DROP_METADATA_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async findCreditLeftForDropsForProfile(
    {
      profileId
    }: {
      profileId: string;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `
          select i.tdh - ifnull(x.credit_spent, 0) as credit_left
          from ${IDENTITIES_TABLE} i
                   left join (select t.rater_id,
                                     ifnull(sum(t.credit_spent), 0) as credit_spent
                              from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} t
                              where t.rater_id = :raterId
                                and t.timestamp >= :reservationStartTime
                              group by t.rater_id) x on x.rater_id = i.profile_id
          where i.profile_id = :raterId
        `,
        {
          raterId: profileId,
          reservationStartTime: Time.todayUtcMidnight().minusDays(30).toDate()
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) => it[0]?.credit_left ?? 0);
  }

  async findOverspentRateCredits(
    {
      reservationStartTime
    }: {
      reservationStartTime: Time;
    },
    connection: ConnectionWrapper<any>
  ): Promise<
    (DropVoteCreditSpending & {
      whole_credit: number;
      total_credit_spent: number;
    })[]
  > {
    return this.db.execute(
      `
          with spent_credits as (select rater_id, sum(credit_spent) spent_credit
                              from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE}
                              where timestamp >= :reservationStartTime
                              group by 1),
               overspenders as (select rater_id, ifnull(i.tdh, 0) as profile_credit, s.spent_credit as spent_credit
                                from spent_credits s
                                         left join ${IDENTITIES_TABLE} i on i.profile_id = s.rater_id
                                where ifnull(i.tdh, 0) - s.spent_credit < 0)
          select t.*, o.profile_credit as whole_credit, o.spent_credit as total_credit_spent
          from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} t
                   join overspenders o on o.rater_id = t.rater_id
          where t.timestamp >= :reservationStartTime;
      `,
      {
        reservationStartTime: reservationStartTime.toDate()
      },
      { wrappedConnection: connection }
    );
  }

  async updateCreditSpentOnDropRates(
    param: { credit_spent: number; reservationId: number },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} set credit_spent = :credit_spent where id = :reservationId`,
      param,
      { wrappedConnection: connection }
    );
  }

  async insertCreditSpentOnDropRates(
    param: {
      rater_id: string;
      credit_spent: number;
      drop_id: string;
      wave_id: string;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (rater_id, drop_id, credit_spent, timestamp, wave_id) values (:rater_id, :drop_id, :credit_spent, NOW(), :wave_id)`,
      param,
      { wrappedConnection: connection }
    );
  }

  async deleteCreditSpentOnDropRates(
    id: number,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `delete from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} where id = :id`,
      { id },
      { wrappedConnection: connection }
    );
  }

  async findDropsTotalRatingsStats(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, { rating: number; distinct_raters: number }>> {
    return !dropIds.length
      ? {}
      : await this.db
          .execute(
            `
      select matter_target_id                 as drop_id,
             sum(rating)                      as rating,
             count(distinct rater_profile_id) as distinct_raters
      from ${RATINGS_TABLE}
      where matter = '${RateMatter.DROP_RATING}'
        and matter_target_id in (:dropIds)
        and rating <> 0
      group by 1
    `,
            { dropIds },
            {
              wrappedConnection: connection
            }
          )
          .then((dbResult: any[]) =>
            dbResult.reduce((acc, it) => {
              acc[it.drop_id] = {
                rating: it.rating,
                distinct_raters: it.distinct_raters
              };
              return acc;
            }, {} as Record<string, { rating: number; distinct_raters: number }>)
          );
  }

  async findDropsTopRaters(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, { rating: number; rater_profile_id: string }[]>> {
    return !dropIds.length
      ? {}
      : await this.db
          .execute(
            `
    select rater_profile_id, matter_target_id as drop_id, sum(rating) as rating
    from ${RATINGS_TABLE}
    where matter = '${RateMatter.DROP_RATING}'
      and rating <> 0
      and matter_target_id in (:dropIds)
    group by 1, 2
    order by abs(sum(rating)) desc limit 5
    `,
            { dropIds },
            {
              wrappedConnection: connection
            }
          )
          .then((dbResult: any[]) =>
            dropIds.reduce((acc, it) => {
              const f = dbResult.filter((r) => r.drop_id === it);
              if (f) {
                acc[it] = f.map((s) => ({
                  rating: s.rating,
                  rater_profile_id: s.rater_profile_id
                }));
              }
              return acc;
            }, {} as Record<string, { rating: number; rater_profile_id: string }[]>)
          );
  }

  async findDropsTotalRatingsByProfile(
    dropIds: string[],
    raterId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, number>> {
    return !dropIds.length
      ? {}
      : await this.db
          .execute(
            `
    select matter_target_id as drop_id, sum(rating) as rating
    from ${RATINGS_TABLE}
    where matter = '${RateMatter.DROP_RATING}' and matter_target_id in (:dropIds) and rating <> 0 and rater_profile_id = :raterId
    group by 1
    `,
            { dropIds, raterId },
            {
              wrappedConnection: connection
            }
          )
          .then((dbResult: any[]) =>
            dbResult.reduce((acc, it) => {
              acc[it.drop_id] = it.rating;
              return acc;
            }, {} as Record<string, number>)
          );
  }

  async countRepliesByDropIds(
    {
      dropIds,
      context_profile_id
    }: { dropIds: string[]; context_profile_id?: string | null },
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<
      string,
      Record<number, { count: number; context_profile_count: number }>
    >
  > {
    if (!dropIds.length) {
      return {};
    }
    const sql = `select reply_to_drop_id as drop_id, reply_to_part_id as drop_part_id, count(*) as cnt
    ${
      context_profile_id
        ? `, sum(case when author_id = :context_profile_id then 1 else 0 end) as context_profile_count`
        : ``
    }
    from drops
    where drops.reply_to_drop_id in (:dropIds)
    group by 1, 2`;
    return this.db
      .execute(
        sql,
        {
          dropIds,
          context_profile_id
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then(
        (
          dbResult: {
            drop_id: string;
            drop_part_id: number;
            cnt: number;
            context_profile_count: number;
          }[]
        ) => {
          return dropIds.reduce((byDropId, dropId) => {
            byDropId[dropId] = dbResult
              .filter((entity) => entity.drop_id === dropId)
              .reduce((byDropPartId, entity) => {
                byDropPartId[entity.drop_part_id] = {
                  count: entity.cnt,
                  context_profile_count: entity.context_profile_count ?? 0
                };
                return byDropPartId;
              }, {} as Record<number, { count: number; context_profile_count: number }>);
            return byDropId;
          }, {} as Record<string, Record<number, { count: number; context_profile_count: number }>>);
        }
      );
  }

  async getDropsQuoteCounts(
    dropsIds: string[],
    contextProfileId: string | undefined | null,
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<
      string,
      Record<number, { total: number; by_context_profile: number | null }>
    >
  > {
    if (!dropsIds.length) {
      return {};
    }
    return this.db
      .execute(
        `
        select p.quoted_drop_id                                                 as drop_id,
               p.drop_part_id as drop_part_id,
               count(*)                                                       as total
               ${
                 contextProfileId
                   ? `, sum(case when qd.author_id = :contextProfileId then 1 else 0 end) as by_context_profile `
                   : ``
               }
        from ${DROPS_PARTS_TABLE} p
        join ${DROPS_TABLE} d on d.id = p.quoted_drop_id
        join ${DROPS_TABLE} qd on qd.id = p.drop_id
        where p.quoted_drop_id in (:dropsIds)
        group by 1, 2
        `,
        { dropsIds, contextProfileId },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then(
        (
          dbResult: {
            drop_part_id: number;
            drop_id: string;
            total: number;
            by_context_profile: number | null;
          }[]
        ) =>
          dropsIds.reduce((byDropId, dropId) => {
            byDropId[dropId] = dbResult
              .filter((entity) => entity.drop_id === dropId)
              .reduce((byPartNo, entity) => {
                byPartNo[entity.drop_part_id] = {
                  total: entity.total,
                  by_context_profile: entity.by_context_profile ?? null
                };
                return byPartNo;
              }, {} as Record<number, { total: number; by_context_profile: number | null }>);
            return byDropId;
          }, {} as Record<string, Record<number, { total: number; by_context_profile: number | null }>>)
      );
  }

  async insertDropMedia(
    media: Omit<DropMediaEntity, 'id'>[],
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start(`dropsDb->insertDropMedia`);
    await Promise.all(
      media.map((medium) =>
        this.db.execute(
          `insert into ${DROP_MEDIA_TABLE} (drop_id, drop_part_id, url, mime_type, wave_id)
         values (:drop_id, :drop_part_id, :url, :mime_type, :wave_id)`,
          medium,
          { wrappedConnection: connection }
        )
      )
    );
    timer.stop(`dropsDb->insertDropMedia`);
  }

  async getDropMedia(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, DropMediaEntity[]>> {
    if (!dropIds.length) {
      return {};
    }
    const dbResult: DropMediaEntity[] = await this.db.execute(
      `select * from ${DROP_MEDIA_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
    return dropIds.reduce((acc, it) => {
      acc[it] = dbResult.filter((r) => r.drop_id === it);
      return acc;
    }, {} as Record<string, DropMediaEntity[]>);
  }

  async getDropsParts(
    dropIds: string[],
    connection: ConnectionWrapper<any> | undefined
  ): Promise<Record<string, DropPartEntity[]>> {
    if (!dropIds.length) {
      return {};
    }
    return this.db
      .execute(
        `select * from ${DROPS_PARTS_TABLE} where drop_id in (:dropIds) order by drop_part_id asc`,
        {
          dropIds
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it: DropPartEntity[]) => {
        return it.reduce((acc, part) => {
          if (!acc[part.drop_id]) {
            acc[part.drop_id] = [];
          }
          acc[part.drop_id].push(part);
          return acc;
        }, {} as Record<string, DropPartEntity[]>);
      });
  }

  async insertDropParts(
    parts: DropPartEntity[],
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start(`dropsDb->insertDropParts`);
    await Promise.all(
      parts.map((part) =>
        this.db.execute(
          `insert into ${DROPS_PARTS_TABLE} (drop_id, drop_part_id, content, quoted_drop_id, quoted_drop_part_id, wave_id) values (:drop_id, :drop_part_id, :content, :quoted_drop_id, :quoted_drop_part_id, :wave_id)`,
          part,
          { wrappedConnection: connection }
        )
      )
    );
    timer.stop(`dropsDb->insertDropParts`);
  }

  async findRepliesByDropId(param: {
    sort_direction: PageSortDirection;
    drop_id: string;
    drop_part_id: number;
    sort: string;
    page: number;
    page_size: number;
  }): Promise<DropEntity[]> {
    const limit = param.page_size;
    const offset = (param.page - 1) * limit;
    const sort = param.sort;
    const direction = param.sort_direction;
    return this.db.execute<DropEntity>(
      `select * from ${DROPS_TABLE} where reply_to_drop_id = :drop_id and reply_to_part_id = :drop_part_id order by ${sort} ${direction} limit ${limit} offset ${offset}`,
      param
    );
  }

  async findWaveByIdOrThrow(
    id: string,
    connection: ConnectionWrapper<any>
  ): Promise<WaveEntity> {
    return this.findWaveByIdOrNull(id, connection).then((it) => {
      if (!it) {
        throw new NotFoundException(`Wave with id ${id} not found`);
      }
      return it;
    });
  }

  async findWaveByIdOrNull(
    id: string,
    connection: ConnectionWrapper<any>
  ): Promise<WaveEntity | null> {
    return this.db.oneOrNull<WaveEntity>(
      `select * from ${WAVES_TABLE} where id = :id`,
      { id },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async countAuthorDropsInWave(param: {
    wave_id: string;
    author_id: string;
  }): Promise<number> {
    return this.db
      .oneOrNull<{ cnt: number }>(
        `select count(*) as cnt from ${DROPS_TABLE} where wave_id = :wave_id and author_id = :author_id`,
        param
      )
      .then((it) => it?.cnt ?? 0);
  }

  public async deleteDropParts(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropParts');
    await this.db.execute(
      `delete from ${DROPS_PARTS_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropParts');
  }

  public async deleteDropMentions(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropMentions');
    await this.db.execute(
      `delete from ${DROPS_MENTIONS_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropMentions');
  }

  public async deleteDropMedia(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropMedia');
    await this.db.execute(
      `delete from ${DROP_MEDIA_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropMedia');
  }

  public async deleteDropReferencedNfts(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropReferencedNfts');
    await this.db.execute(
      `delete from ${DROP_REFERENCED_NFTS_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropReferencedNfts');
  }

  public async deleteDropMetadata(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropMetadata');
    await this.db.execute(
      `delete from ${DROP_METADATA_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropMetadata');
  }

  public async deleteDropNotifications(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropNotifications');
    await this.db.execute(
      `delete from ${IDENTITY_NOTIFICATIONS_TABLE} where related_drop_id = :dropId or related_drop_2_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropNotifications');
  }

  public async deleteDropFeedItems(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropFeedItems');
    await this.db.execute(
      `delete from ${ACTIVITY_EVENTS_TABLE} where target_id = :dropId or data like :likeDropId`,
      { dropId, likeDropId: `%"${dropId}"%` },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropFeedItems');
  }

  public async deleteDropEntity(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropEntity');
    await this.db.execute(
      `delete from ${DROPS_TABLE} where id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropEntity');
  }

  public async updateWaveDropCounters(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->updateWaveDropCounters');
    await this.db.execute(
      `update ${WAVE_METRICS_TABLE} set drops_count = drops_count - 1 where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->updateWaveDropCounters');
  }

  public async deleteDropsCreditSpendings(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropsCreditSpendings');
    await this.db.execute(
      `delete from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropsCreditSpendings');
  }

  public async deleteDropSubscriptions(dropId: string, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->deleteDropSubscriptions');
    await this.db.execute(
      `delete from ${IDENTITY_SUBSCRIPTIONS_TABLE} where target_id = :dropId and target_type = :targetType`,
      { dropId, targetType: ActivityEventTargetType.DROP },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->deleteDropSubscriptions');
  }

  async insertDeletedDrop(param: DeletedDropEntity, ctx: RequestContext) {
    ctx.timer?.start('dropsDb->insertDeletedDrop');
    await this.db.execute(
      `insert into ${DELETED_DROPS_TABLE} (id, wave_id, author_id, created_at, deleted_at) values (:id, :wave_id, :author_id, :created_at, :deleted_at)`,
      param,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->insertDeletedDrop');
  }

  async findDeletedDrops(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, DeletedDropEntity>> {
    if (!dropIds.length) {
      return {};
    }
    return this.db
      .execute<DeletedDropEntity>(
        `select * from ${DELETED_DROPS_TABLE} where id in (:dropIds)`,
        { dropIds },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((result) =>
        result.reduce((acc, it) => {
          acc[it.id] = it;
          return acc;
        }, {} as Record<string, DeletedDropEntity>)
      );
  }

  async getTraceForDrop(
    dropId: string,
    ctx: RequestContext
  ): Promise<{ drop_id: string; is_deleted: boolean }[]> {
    ctx.timer?.start('dropsDb->getTraceForDrop');
    const dbResult = await this.db.execute<{
      drop_id: string;
      created_at: number;
      is_deleted: 1 | 0;
    }>(
      `
      select 
        distinct
        dr.parent_id as drop_id,
        ifnull(d.created_at, dd.created_at) as created_at,
        dd.id is not null as is_deleted
      from ${DROP_RELATIONS_TABLE} dr
      left join ${DELETED_DROPS_TABLE} dd on dr.parent_id = dd.id
      left join ${DROPS_TABLE} d on dr.parent_id = d.id
      where dr.child_id = :dropId
      order by 2
      `,
      { dropId }
    );
    const trace: { drop_id: string; is_deleted: boolean }[] = dbResult.map(
      (entity) => ({
        drop_id: entity.drop_id,
        is_deleted: entity.is_deleted === 1
      })
    );
    trace.push({ drop_id: dropId, is_deleted: false });
    ctx.timer?.stop('dropsDb->getTraceForDrop');
    return trace;
  }
}

export type NewDropEntity = Omit<DropEntity, 'serial_no'> & {
  serial_no: number | null;
};

export const dropsDb = new DropsDb(dbSupplier, userGroupsService);
