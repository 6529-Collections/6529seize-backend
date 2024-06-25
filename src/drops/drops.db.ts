import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../sql-executor';
import {
  DropCommentEntity,
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropReferencedNftEntity
} from '../entities/IDrop';
import {
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_COMMENTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  IDENTITIES_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  RATINGS_TABLE,
  WAVES_TABLE
} from '../constants';
import {
  userGroupsService,
  UserGroupsService
} from '../api-serverless/src/community-members/user-groups.service';
import { Time } from '../time';
import { DropVoteCreditSpending } from '../entities/IDropVoteCreditSpending';
import { RateMatter } from '../entities/IRating';
import { DropActivityLogsQuery } from '../api-serverless/src/drops/drops.routes';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';
import { randomUUID } from 'crypto';
import { PageSortDirection } from '../api-serverless/src/page-request';
import { uniqueShortId } from '../helpers';

export class DropsDb extends LazyDbAccessCompatibleService {
  constructor(
    supplyDb: () => SqlExecutor,
    private readonly userGroupsService: UserGroupsService
  ) {
    super(supplyDb);
  }

  async getDropsByIds(ids: string[]): Promise<DropEntity[]> {
    if (!ids.length) {
      return [];
    }
    return this.db.execute(`select * from ${DROPS_TABLE} where id in (:ids)`, {
      ids
    });
  }

  async insertDrop(
    newDropEntity: NewDropEntity,
    connection: ConnectionWrapper<any>
  ): Promise<string> {
    const id = randomUUID();
    await this.db.execute(
      `insert into ${DROPS_TABLE} (
                            id,
                            author_id, 
                            wave_id,
                            created_at, 
                            title,
                            parts_count
    ) values (
              :id,
              :author_id,
              :wave_id,
              ROUND(UNIX_TIMESTAMP(CURTIME(4)) * 1000), 
              :title,
              :parts_count
             )`,

      { ...newDropEntity, id },
      { wrappedConnection: connection }
    );
    return id;
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
                            handle_in_content
    ) values (
              :drop_id, 
              :mentioned_profile_id,
              :handle_in_content
   )`,
        mention,
        { wrappedConnection: connection }
      );
    }
  }

  async insertReferencedNfts(
    references: Omit<DropReferencedNftEntity, 'id'>[],
    connection: ConnectionWrapper<any>
  ) {
    for (const reference of references) {
      await this.db.execute(
        `insert into ${DROP_REFERENCED_NFTS_TABLE} (
                            drop_id, 
                            contract,
                            token,
                            name
    ) values (
              :drop_id, 
              :contract,
              :token,
              :name
             )`,
        reference,
        { wrappedConnection: connection }
      );
    }
  }

  async insertDropMetadata(
    metadatas: Omit<DropMetadataEntity, 'id'>[],
    connection: ConnectionWrapper<any>
  ) {
    for (const metadata of metadatas) {
      await this.db.execute(
        `insert into ${DROP_METADATA_TABLE} (
                            drop_id, 
                            data_key,
                            data_value
    ) values (
              :drop_id, 
              :data_key,
              :data_value
             )`,
        metadata,
        { wrappedConnection: connection }
      );
    }
  }

  async findDropById(
    id: string,
    group_ids_user_is_eligible_for: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `
        select d.* from ${DROPS_TABLE} d
         join waves w on d.wave_id = w.id and w.visibility_group_id in (:group_ids_user_is_eligible_for)
         where d.id = :id
        `,
        {
          id,
          group_ids_user_is_eligible_for: [
            null,
            ...group_ids_user_is_eligible_for
          ]
        },
        opts
      )
      .then((it) => it[0] || null);
  }

  async findLatestDrops({
    amount,
    serial_no_less_than,
    group_ids_user_is_eligible_for,
    group_id,
    wave_id
  }: {
    group_id: string | null;
    group_ids_user_is_eligible_for: string[];
    serial_no_less_than: number | null;
    amount: number;
    wave_id: string | null;
  }): Promise<DropEntity[]> {
    const sqlAndParams = await this.userGroupsService.getSqlAndParamsByGroupId(
      group_id
    );
    if (!sqlAndParams) {
      return [];
    }
    const serialNoLessThan = serial_no_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `${sqlAndParams.sql} select d.* from ${DROPS_TABLE} d
         join ${
           UserGroupsService.GENERATED_VIEW
         } cm on cm.profile_id = d.author_id
         join ${WAVES_TABLE} w on d.wave_id = w.id and w.id in (:group_ids_user_is_eligible_for) ${
      wave_id ? `and w.id = :wave_id` : ``
    }
         where d.serial_no < :serialNoLessThan order by d.serial_no desc limit ${amount}`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      serialNoLessThan,
      group_ids_user_is_eligible_for: [...group_ids_user_is_eligible_for, null]
    };
    return this.db.execute(sql, params);
  }

  async findProfileDrops(
    param: {
      amount: number;
      serial_no_less_than: number | null;
      profile_id: string;
    },
    groupIdsUserIfEligibleFor: string[]
  ): Promise<DropEntity[]> {
    const serialNoLessThan =
      param.serial_no_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `select d.* from ${DROPS_TABLE} d
         join waves w on w.id = d.wave_id and w.visibility_group_id in (:eligible_groups)
         where  d.serial_no < :serialNoLessThan and d.author_id = :profileId
         order by d.id desc limit ${param.amount}`;
    return this.db.execute(sql, {
      profileId: param.profile_id,
      eligible_groups: [...groupIdsUserIfEligibleFor, null],
      serialNoLessThan
    });
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
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (rater_id, drop_id, credit_spent, timestamp)values (:rater_id, :drop_id, :credit_spent, NOW())`,
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
  ): Promise<
    Record<
      string,
      { rating: number; distinct_raters: number; distinct_categories: number }
    >
  > {
    return !dropIds.length
      ? {}
      : await this.db
          .execute(
            `
      select matter_target_id                 as drop_id,
             sum(rating)                      as rating,
             count(distinct rater_profile_id) as distinct_raters,
             count(distinct matter_category)  as distinct_categories
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
                distinct_raters: it.distinct_raters,
                distinct_categories: it.distinct_categories
              };
              return acc;
            }, {} as Record<string, { rating: number; distinct_raters: number; distinct_categories: number }>)
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

  async findDropsTopRatingCategories(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, { rating: number; category: string }[]>> {
    return !dropIds.length
      ? {}
      : await this.db
          .execute(
            `
    select matter_category as category, matter_target_id as drop_id, sum(rating) as rating
    from ${RATINGS_TABLE}
    where matter = '${RateMatter.DROP_RATING}'
      and rating <> 0
      and matter_target_id in (:dropIds)
    group by 1, 2
    order by abs(sum(rating)) desc
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
                  category: s.category
                }));
              }
              return acc;
            }, {} as Record<string, { rating: number; category: string }[]>)
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

  async findDropsCategoryRatingsByProfile(
    dropIds: string[],
    raterId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<
      string,
      { category: string; profile_rating: number; total_rating: number }[]
    >
  > {
    if (dropIds.length === 0) {
      return {};
    }
    const dbResult: {
      drop_id: string;
      category: string;
      profile_rating: number;
      total_rating: number;
    }[] = await this.db.execute(
      `
          with profile_drop_rates as (select matter_target_id    as drop_id,
                                             matter_category     as category,
                                             sum(rating)         as total_rating,
                                             sum(case
                                                     when rater_profile_id = :raterId then rating
                                                     else 0 end) as profile_rating
                                      from ${RATINGS_TABLE}
                                      where matter = '${RateMatter.DROP_RATING}'
                                        and matter_target_id in (:dropIds)
                                        and rating <> 0
                                      group by 1, 2)
          select *
          from profile_drop_rates
          where profile_rating <> 0
    `,
      { dropIds, raterId },
      {
        wrappedConnection: connection
      }
    );
    return dbResult.reduce((acc, it) => {
      if (!acc[it.drop_id]) {
        acc[it.drop_id] = [];
      }
      acc[it.drop_id].push({
        category: it.category,
        profile_rating: it.profile_rating,
        total_rating: it.total_rating
      });
      return acc;
    }, {} as Record<string, { category: string; profile_rating: number; total_rating: number }[]>);
  }

  async countDiscussionCommentsByDropIds(
    {
      dropIds,
      context_profile_id
    }: { dropIds: string[]; context_profile_id?: string },
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
    const sql = `select p.drop_id, p.drop_part_id, count(*) as cnt
     ${
       context_profile_id
         ? `, sum(case when d.author_id = :context_profile_id then 1 else 0 end) as context_profile_count`
         : ``
     }
     from ${DROPS_COMMENTS_TABLE} p join ${DROPS_TABLE} d on d.id = p.drop_id where p.drop_id in (:dropIds) group by 1, 2`;
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
        ) =>
          dropIds.reduce((byDropId, dropId) => {
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
          }, {} as Record<string, Record<number, { count: number; context_profile_count: number }>>)
      );
  }

  async findLogsByDropId(
    query: DropActivityLogsQuery
  ): Promise<ProfileActivityLog[]> {
    const logTypes = query.log_type
      ? [query.log_type]
      : [
          ProfileActivityLogType.DROP_COMMENT,
          ProfileActivityLogType.DROP_RATING_EDIT,
          ProfileActivityLogType.DROP_CREATED
        ];
    const page = query.page;
    const pageSize = query.page_size;
    const offset = (page - 1) * pageSize;
    return this.db
      .execute(
        `select * from ${PROFILES_ACTIVITY_LOGS_TABLE} where target_id = :dropId and type in (:logTypes) order by ${query.sort} ${query.sort_direction} limit ${pageSize} offset ${offset}`,
        {
          dropId: query.drop_id,
          logTypes
        }
      )
      .then((it) => {
        return it.map((log: any) => ({
          ...log,
          contents: JSON.parse(log.contents),
          created_at: new Date(log.created_at)
        }));
      });
  }

  async insertDiscussionComment(
    commentRequest: Omit<DropCommentEntity, 'id' | 'created_at'>,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    await this.db.execute(
      `insert into ${DROPS_COMMENTS_TABLE} (author_id, drop_id, drop_part_id, comment, created_at) values (:author_id, :drop_id, :drop_part_id, :comment, ROUND(UNIX_TIMESTAMP(CURTIME(4)) * 1000))`,
      commentRequest,
      { wrappedConnection: connection }
    );
    const commentId = await this.getLastInsertId(connection);
    await this.db.execute(
      `insert into ${PROFILES_ACTIVITY_LOGS_TABLE} (id, profile_id, target_id, type, contents, created_at) values (:id, :profile_id, :target_id, :type, :contents, current_timestamp)`,
      {
        id: uniqueShortId(),
        profile_id: commentRequest.author_id,
        target_id: commentRequest.drop_id,
        type: ProfileActivityLogType.DROP_COMMENT,
        contents: JSON.stringify({
          comment_id: commentId,
          drop_part_id: commentRequest.drop_part_id
        })
      },
      { wrappedConnection: connection }
    );
    return commentId;
  }

  async findDiscussionCommentById(
    id: number,
    connection?: ConnectionWrapper<any>
  ): Promise<DropCommentEntity | null> {
    return this.db
      .execute(
        `select * from ${DROPS_COMMENTS_TABLE} where id = :id`,
        { id, type: ProfileActivityLogType.DROP_COMMENT },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) => it[0] ?? null);
  }

  async getDropLogsStats(
    { dropIds, profileId }: { dropIds: string[]; profileId?: string },
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<
      string,
      {
        discussion_comments_count: number;
        rating_logs_count: number;
        context_profile_discussion_comments_count: number | null;
      }
    >
  > {
    if (!dropIds.length) {
      return {};
    }
    const sql = `
  select 
     target_id, 
     sum(case when type = '${
       ProfileActivityLogType.DROP_COMMENT
     }' then 1 else 0 end) as discussion_comments_count,
     ${
       profileId
         ? `sum(case when type = '${ProfileActivityLogType.DROP_COMMENT}' and profile_id = :profileId then 1 else 0 end) as context_profile_discussion_comments_count,`
         : ``
     }
     sum(case when type = '${
       ProfileActivityLogType.DROP_RATING_EDIT
     }' then 1 else 0 end) as rating_logs_count
  from ${PROFILES_ACTIVITY_LOGS_TABLE}
  where target_id in (:dropIds) group by 1
     `;
    const dbResults: {
      target_id: string;
      discussion_comments_count: number;
      rating_logs_count: number;
      context_profile_discussion_comments_count?: number;
    }[] = await this.db.execute(
      sql,
      { dropIds, profileId },
      connection ? { wrappedConnection: connection } : undefined
    );
    return dbResults.reduce((acc, it) => {
      acc[it.target_id] = {
        discussion_comments_count: it.discussion_comments_count,
        rating_logs_count: it.rating_logs_count,
        context_profile_discussion_comments_count:
          it.context_profile_discussion_comments_count ?? null
      };
      return acc;
    }, {} as Record<string, { discussion_comments_count: number; rating_logs_count: number; context_profile_discussion_comments_count: number | null }>);
  }

  async getDropsQuoteCounts(
    dropsIds: string[],
    contextProfileId: string | undefined,
    min_part_id: number,
    max_part_id: number,
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
               ? `, sum(case when d.author_id = :contextProfileId then 1 else 0 end) as by_context_profile `
               : ``
           }
    from ${DROPS_PARTS_TABLE} p
    join ${DROPS_TABLE} d on d.id = p.quoted_drop_id
    where p.quoted_drop_id in (:dropsIds)
      and p.drop_part_id >= :min_part_id
      and p.drop_part_id <= :max_part_id
    group by 1, 2
    `,
        { dropsIds, contextProfileId, min_part_id, max_part_id },
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
    connection: ConnectionWrapper<any>
  ) {
    for (const medium of media) {
      await this.db.execute(
        `insert into ${DROP_MEDIA_TABLE} (drop_id, drop_part_id, url, mime_type)
         values (:drop_id, :drop_part_id, :url, :mime_type)`,
        medium,
        { wrappedConnection: connection }
      );
    }
  }

  async getDropMedia(
    dropIds: string[],
    min_part_id: number,
    max_part_id: number,
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, DropMediaEntity[]>> {
    if (!dropIds.length) {
      return {};
    }
    const dbResult: DropMediaEntity[] = await this.db.execute(
      `select * from ${DROP_MEDIA_TABLE} where drop_id in (:dropIds) and drop_part_id >= :min_part_id and drop_part_id <= :max_part_id`,
      { dropIds, min_part_id, max_part_id },
      connection ? { wrappedConnection: connection } : undefined
    );
    return dropIds.reduce((acc, it) => {
      acc[it] = dbResult.filter((r) => r.drop_id === it);
      return acc;
    }, {} as Record<string, DropMediaEntity[]>);
  }

  async getDropsParts(
    dropIds: string[],
    min_part_id: number,
    max_part_id: number,
    connection: ConnectionWrapper<any> | undefined
  ): Promise<Record<string, DropPartEntity[]>> {
    if (!dropIds.length) {
      return {};
    }
    return this.db
      .execute(
        `select * from ${DROPS_PARTS_TABLE} where drop_id in (:dropIds) and drop_part_id >= :min_part_id and drop_part_id <= :max_part_id order by drop_part_id asc`,
        {
          dropIds,
          min_part_id,
          max_part_id
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it: DropPartEntity[]) =>
        it.reduce((acc, part) => {
          if (!acc[part.drop_id]) {
            acc[part.drop_id] = [];
          }
          acc[part.drop_id].push(part);
          return acc;
        }, {} as Record<string, DropPartEntity[]>)
      );
  }

  async insertDropParts(
    parts: DropPartEntity[],
    connection: ConnectionWrapper<any>
  ) {
    for (const part of parts) {
      await this.db.execute(
        `insert into ${DROPS_PARTS_TABLE} (drop_id, drop_part_id, content, quoted_drop_id, quoted_drop_part_id) values (:drop_id, :drop_part_id, :content, :quoted_drop_id, :quoted_drop_part_id)`,
        part,
        { wrappedConnection: connection }
      );
    }
  }

  async findDiscussionCommentsByDropId(param: {
    sort_direction: PageSortDirection;
    drop_id: string;
    drop_part_id: number;
    sort: string;
    page: number;
    page_size: number;
  }): Promise<DropCommentEntity[]> {
    const limit = param.page_size;
    const offset = (param.page - 1) * limit;
    const sort = param.sort;
    const direction = param.sort_direction;
    return this.db.execute(
      `select * from ${DROPS_COMMENTS_TABLE} where drop_id = :drop_id and drop_part_id = :drop_part_id order by ${sort} ${direction} limit ${limit} offset ${offset}`,
      param
    );
  }

  async countLogsByDropIds(
    drop_ids: string[],
    log_type?: ProfileActivityLogType
  ): Promise<Record<string, number>> {
    const log_types = log_type
      ? [log_type]
      : [
          ProfileActivityLogType.DROP_COMMENT,
          ProfileActivityLogType.DROP_RATING_EDIT,
          ProfileActivityLogType.DROP_CREATED
        ];
    return this.db
      .execute(
        `select target_id as drop_id, count(*) as cnt from ${PROFILES_ACTIVITY_LOGS_TABLE} where target_id in (:drop_ids) and type in (:log_types) group by 1`,
        { drop_ids, log_types }
      )
      .then((dbResult: { drop_id: string; cnt: number }[]) =>
        drop_ids.reduce((acc, count) => {
          acc[count] = dbResult.find((it) => it.drop_id === count)?.cnt ?? 0;
          return acc;
        }, {} as Record<string, number>)
      );
  }
}

export type NewDropEntity = Omit<DropEntity, 'serial_no' | 'id' | 'created_at'>;

export const dropsDb = new DropsDb(dbSupplier, userGroupsService);
