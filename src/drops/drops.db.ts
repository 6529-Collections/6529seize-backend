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
  DropReferencedNftEntity
} from '../entities/IDrop';
import {
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  PROFILE_FULL,
  PROFILES_ACTIVITY_LOGS_TABLE,
  RATINGS_TABLE
} from '../constants';
import {
  communityMemberCriteriaService,
  CommunityMemberCriteriaService
} from '../api-serverless/src/community-members/community-member-criteria.service';
import { Time } from '../time';
import { DropVoteCreditSpending } from '../entities/IDropVoteCreditSpending';
import { RateMatter } from '../entities/IRating';
import { DropActivityLogsQuery } from '../api-serverless/src/drops/drops.routes';
import { uniqueShortId } from '../helpers';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';
import { randomUUID } from 'crypto';

export class DropsDb extends LazyDbAccessCompatibleService {
  constructor(
    supplyDb: () => SqlExecutor,
    private readonly criteriaService: CommunityMemberCriteriaService
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

  public async lockDrop(
    id: string,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `select id from ${DROPS_TABLE} where id = :id for update`,
        { id },
        { wrappedConnection: connection }
      )
      .then((it) => it[0]?.id ?? null);
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
                            created_at, 
                            title, 
                            content, 
                            quoted_drop_id,
                            root_drop_id,
                            storm_sequence
    ) values (
              :id,
              :author_id,
              ROUND(UNIX_TIMESTAMP(CURTIME(4)) * 1000), 
              :title, 
              :content, 
              :quoted_drop_id, 
              :root_drop_id,
              :storm_sequence
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
    connection?: ConnectionWrapper<any>
  ): Promise<(DropEntity & { max_storm_sequence: number }) | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db
      .execute(
        `
        with mss as (select max(d.storm_sequence) as storm_sequence  from ${DROPS_TABLE} d where d.id = :id)
        select d.*, ifnull(mss.storm_sequence, 1) as max_storm_sequence from ${DROPS_TABLE} d left join mss on true where d.id = :id
        `,
        { id },
        opts
      )
      .then((it) => it[0] || null);
  }

  async findRootDropMaxStormSequenceOrZero(
    param: { root_drop_id: string; author_id: string },
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `select ifnull(max(storm_sequence), 0) storm_sequence from ${DROPS_TABLE} where (root_drop_id = :root_drop_id or id = :root_drop_id) and author_id = :author_id`,
        param,
        { wrappedConnection: connection }
      )
      .then((it) => {
        const stormSequence = it[0]!.storm_sequence as number;
        console.log(it);
        return stormSequence;
      });
  }

  async findLatestDropsGroupedInStorms({
    amount,
    serial_no_less_than,
    curation_criteria_id,
    root_drop_id
  }: {
    curation_criteria_id: string | null;
    serial_no_less_than: number | null;
    root_drop_id: string | null;
    amount: number;
  }): Promise<(DropEntity & { max_storm_sequence: number })[]> {
    const sqlAndParams = await this.criteriaService.getSqlAndParamsByCriteriaId(
      curation_criteria_id
    );
    if (!sqlAndParams) {
      return [];
    }
    const serialNoLessThan = serial_no_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `${
      sqlAndParams.sql
    }, mss as (select root_drop_id, max(d.storm_sequence) as max_storm_sequence  from ${DROPS_TABLE} d group by 1)
     select d.*, ifnull(mss.max_storm_sequence, 1) as max_storm_sequence from ${DROPS_TABLE} d
         join ${
           CommunityMemberCriteriaService.GENERATED_VIEW
         } cm on cm.profile_id = d.author_id
         left join mss on mss.root_drop_id = d.id
         where ${
           root_drop_id === null
             ? ' d.root_drop_id is null '
             : ' (d.root_drop_id = :rootDropId or id = :rootDropId) '
         } and serial_no < :serialNoLessThan order by d.serial_no desc limit ${amount}`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      serialNoLessThan
    };
    if (root_drop_id !== null) {
      params.rootDropId = root_drop_id;
    }
    return this.db.execute(sql, params);
  }

  async findProfileRootDrops(param: {
    amount: number;
    serial_no_less_than: number | null;
    profile_id: string;
  }): Promise<(DropEntity & { max_storm_sequence: number })[]> {
    const serialNoLessThan =
      param.serial_no_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `
         with mss as (select root_drop_id, max(d.storm_sequence) as max_storm_sequence  from ${DROPS_TABLE} d  group by 1)
         select d.*, ifnull(mss.max_storm_sequence, 1) from ${DROPS_TABLE} d
         left join mss on mss.root_drop_id = d.id
         where d.root_drop_id is null and d.serial_no < :serialNoLessThan and d.author_id = :profileId
         order by d.id desc limit ${param.amount}`;
    return this.db.execute(sql, {
      profileId: param.profile_id,
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
          select p.profile_tdh - ifnull(x.credit_spent, 0) as credit_left
          from ${PROFILE_FULL} p
                   left join (select t.rater_id,
                                     ifnull(sum(t.credit_spent), 0) as credit_spent
                              from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} t
                              where t.rater_id = :raterId
                                and t.timestamp >= :reservationStartTime
                              group by t.rater_id) x on x.rater_id = p.external_id
          where p.external_id = :raterId
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
               overspenders as (select rater_id, ifnull(p.profile_tdh, 0) as profile_credit, s.spent_credit as spent_credit
                                from spent_credits s
                                         left join ${PROFILE_FULL} p on p.external_id = s.rater_id
                                where ifnull(p.profile_tdh, 0) - s.spent_credit < 0)
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
      `update ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE}set credit_spent = :credit_spent where id = :reservationId`,
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

  async countDiscussionCommentsByDropId(
    dropId: string,
    logType?: ProfileActivityLogType
  ): Promise<number> {
    const logTypes = logType
      ? [logType]
      : [
          ProfileActivityLogType.DROP_COMMENT,
          ProfileActivityLogType.DROP_RATING_EDIT,
          ProfileActivityLogType.DROP_CREATED
        ];
    const dbResult: { cnt: number }[] = await this.db.execute(
      `select count(*) as cnt from ${PROFILES_ACTIVITY_LOGS_TABLE} where target_id = :dropId and type in (:logTypes)`,
      {
        dropId,
        logTypes
      }
    );
    return dbResult.at(0)?.cnt ?? 0;
  }

  async findDropActivityLogByDropId(
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
      .then((it) =>
        it.map((log: any) => ({ ...log, contents: JSON.parse(log.contents) }))
      );
  }

  async insertDiscussionComment(
    commentRequest: { drop_id: string; content: string; author_id: string },
    connection: ConnectionWrapper<any>
  ): Promise<string> {
    const id = uniqueShortId();
    await this.db.execute(
      `insert into ${PROFILES_ACTIVITY_LOGS_TABLE} (id, profile_id, target_id, contents, type, created_at) values (:id, :profile_id, :target_id, :contents, :type, :created_at)`,
      {
        id,
        profile_id: commentRequest.author_id,
        target_id: commentRequest.drop_id,
        contents: JSON.stringify({ content: commentRequest.content }),
        type: ProfileActivityLogType.DROP_COMMENT,
        created_at: Time.now().toDate()
      },
      { wrappedConnection: connection }
    );
    return id;
  }

  async findDiscussionCommentById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<ProfileActivityLog | null> {
    const result = await this.db
      .execute(
        `select * from ${PROFILES_ACTIVITY_LOGS_TABLE} where id = :id and type = :type`,
        { id, type: ProfileActivityLogType.DROP_COMMENT },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) => it[0] ?? null);
    if (result) {
      result.contents = JSON.parse(result.contents);
    }
    return result;
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
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<string, { total: number; by_context_profile: number | null }>
  > {
    if (!dropsIds.length) {
      return {};
    }
    return this.db
      .execute(
        `select quoted_drop_id as drop_id, count(*) as total ${
          contextProfileId
            ? `, sum(case when author_id = :contextProfileId then 1 else 0 end) as by_context_profile `
            : ``
        } from ${DROPS_TABLE} where quoted_drop_id in (:dropsIds) group by 1`,
        { dropsIds, contextProfileId },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then(
        (
          it: {
            drop_id: string;
            total: number;
            by_context_profile: number | null;
          }[]
        ) =>
          dropsIds.reduce((acc, i) => {
            acc[i] = it.find((r) => r.drop_id === i) ?? {
              total: 0,
              by_context_profile: contextProfileId ? 0 : null
            };
            return acc;
          }, {} as Record<string, { total: number; by_context_profile: number | null }>)
      );
  }

  async insertDropMedia(
    media: Omit<DropMediaEntity, 'id'>[],
    connection: ConnectionWrapper<any>
  ) {
    for (const medium of media) {
      await this.db.execute(
        `insert into ${DROP_MEDIA_TABLE} (drop_id, url, mime_type)
         values (:drop_id, :url, :mime_type)`,
        medium,
        { wrappedConnection: connection }
      );
    }
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
}

export type NewDropEntity = Omit<DropEntity, 'serial_no' | 'id' | 'created_at'>;

export const dropsDb = new DropsDb(dbSupplier, communityMemberCriteriaService);
