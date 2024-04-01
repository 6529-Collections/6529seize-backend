import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../sql-executor';
import {
  Drop,
  DropMentionEntity,
  DropMetadataEntity,
  DropReferencedNftEntity
} from '../entities/IDrop';
import {
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_TABLE,
  PROFILE_FULL,
  PROFILES_ACTIVITY_LOGS_TABLE,
  RATINGS_TABLE,
  TDH_SPENT_ON_DROP_REPS_TABLE
} from '../constants';
import {
  communityMemberCriteriaService,
  CommunityMemberCriteriaService
} from '../api-serverless/src/community-members/community-member-criteria.service';
import { Time } from '../time';
import { TdhSpentOnDropRep } from '../entities/ITdhSpentOnDropRep';
import { RateMatter } from '../entities/IRating';
import { DropActivityLogsQuery } from '../api-serverless/src/drops/drops.routes';
import { uniqueShortId } from '../helpers';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';

export class DropsDb extends LazyDbAccessCompatibleService {
  constructor(
    supplyDb: () => SqlExecutor,
    private readonly criteriaService: CommunityMemberCriteriaService
  ) {
    super(supplyDb);
  }

  async getDropsByIds(ids: number[]): Promise<Drop[]> {
    if (!ids.length) {
      return [];
    }
    return this.db.execute(`select * from ${DROPS_TABLE} where id in (:ids)`, {
      ids
    });
  }

  public async lockDrop(
    id: number,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `select id from ${DROPS_TABLE} where id = :id for update`,
        { id },
        { wrappedConnection: connection }
      )
      .then((it) => it[0].id ?? null);
  }

  async insertDrop(
    newDropEntity: NewDropEntity,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    await this.db.execute(
      `insert into ${DROPS_TABLE} (
                            author_id, 
                            created_at, 
                            title, 
                            content, 
                            quoted_drop_id,
                            media_url, 
                            media_mime_type,
                            root_drop_id,
                            storm_sequence
    ) values (
              :author_id,
              ROUND(UNIX_TIMESTAMP(CURTIME(4)) * 1000), 
              :title, 
              :content, 
              :quoted_drop_id, 
              :media_url, 
              :media_mime_type,
              :root_drop_id,
              :storm_sequence
             )`,

      newDropEntity,
      { wrappedConnection: connection }
    );
    return await this.getLastInsertId(connection);
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
    id: number,
    connection?: ConnectionWrapper<any>
  ): Promise<(Drop & { max_storm_sequence: number }) | null> {
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
    param: { root_drop_id: number; author_id: string },
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .execute(
        `select ifnull(max(storm_sequence), 0) storm_sequence from ${DROPS_TABLE} where root_drop_id = :root_drop_id and author_id = :authorId`,
        param,
        { wrappedConnection: connection }
      )
      .then((it) => it[0]!.storm_sequence as number);
  }

  async findLatestDropsGroupedInStorms({
    amount,
    id_less_than,
    curation_criteria_id,
    root_drop_id
  }: {
    curation_criteria_id: string | null;
    id_less_than: number | null;
    root_drop_id: number | null;
    amount: number;
  }): Promise<(Drop & { max_storm_sequence: number })[]> {
    const sqlAndParams = await this.criteriaService.getSqlAndParamsByCriteriaId(
      curation_criteria_id
    );
    if (!sqlAndParams) {
      return [];
    }
    const idLessThan = id_less_than ?? Number.MAX_SAFE_INTEGER;
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
         } and id < :idLessThan order by d.id desc limit ${amount}`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      idLessThan
    };
    if (root_drop_id !== null) {
      params.rootDropId = root_drop_id;
    }
    return this.db.execute(sql, params);
  }

  async findProfileRootDrops(param: {
    amount: number;
    id_less_than: number | null;
    profile_id: string;
  }): Promise<(Drop & { max_storm_sequence: number })[]> {
    const idLessThan = param.id_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `
         with mss as (select root_drop_id, max(d.storm_sequence) as max_storm_sequence  from ${DROPS_TABLE} d  group by 1)
         select d.*, ifnull(mss.max_storm_sequence, 1) from ${DROPS_TABLE} d
         left join mss on mss.root_drop_id = d.id
         where d.root_drop_id is null and d.id < :idLessThan and d.author_id = :profileId
         order by d.id desc limit ${param.amount}`;
    return this.db.execute(sql, { profileId: param.profile_id, idLessThan });
  }

  async findMentionsByDropIds(
    dropIds: number[],
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
    dropIds: number[],
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
    dropIds: number[],
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

  async findRepLeftForDropsForProfile(
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
          select p.profile_tdh - ifnull(x.tdh_spent, 0) as tdh_left
          from ${PROFILE_FULL} p
                   left join (select t.rater_id,
                                     ifnull(sum(t.tdh_spent), 0) as tdh_spent
                              from ${TDH_SPENT_ON_DROP_REPS_TABLE} t
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
      .then((it) => it[0]?.tdh_left ?? 0);
  }

  async findOverspentRates(
    {
      reservationStartTime
    }: {
      reservationStartTime: Time;
    },
    connection: ConnectionWrapper<any>
  ): Promise<
    (TdhSpentOnDropRep & { profile_tdh: number; total_reserved_tdh: number })[]
  > {
    return this.db.execute(
      `
          with spent_tdhs as (select rater_id, sum(tdh_spent) spent_tdh
                              from ${TDH_SPENT_ON_DROP_REPS_TABLE}
                              where timestamp >= :reservationStartTime
                              group by 1),
               overspenders as (select rater_id, ifnull(p.profile_tdh, 0) as profile_tdh, s.spent_tdh as spent_tdh
                                from spent_tdhs s
                                         left join ${PROFILE_FULL} p on p.external_id = s.rater_id
                                where ifnull(p.profile_tdh, 0) - s.spent_tdh < 0)
          select t.*, o.profile_tdh, o.spent_tdh total_reserved_tdh
          from ${TDH_SPENT_ON_DROP_REPS_TABLE} t
                   join overspenders o on o.rater_id = t.rater_id
          where t.timestamp >= :reservationStartTime;
      `,
      {
        reservationStartTime: reservationStartTime.toDate()
      },
      { wrappedConnection: connection }
    );
  }

  async updateTdhSpentOnDropRep(
    param: { tdh_spent: number; reservationId: number },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${TDH_SPENT_ON_DROP_REPS_TABLE} set tdh_spent = :tdh_spent where id = :reservationId`,
      param,
      { wrappedConnection: connection }
    );
  }

  async insertTdhSpentOnDropRep(
    param: {
      rater_id: string;
      tdh_spent: number;
      drop_id: number;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert into ${TDH_SPENT_ON_DROP_REPS_TABLE} (rater_id, drop_id, tdh_spent, timestamp) values (:rater_id, :drop_id, :tdh_spent, NOW())`,
      param,
      { wrappedConnection: connection }
    );
  }

  async deleteTdhSpentOnDropRep(
    id: number,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `delete from ${TDH_SPENT_ON_DROP_REPS_TABLE} where id = :id`,
      { id },
      { wrappedConnection: connection }
    );
  }

  async findDropsTotalRepStats(
    dropIds: number[],
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<
      number,
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
      where matter = '${RateMatter.DROP_REP}'
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
              acc[parseInt(it.drop_id)] = {
                rating: it.rating,
                distinct_raters: it.distinct_raters,
                distinct_categories: it.distinct_categories
              };
              return acc;
            }, {} as Record<number, { rating: number; distinct_raters: number; distinct_categories: number }>)
          );
  }

  async findDropsTopRepRaters(
    dropIds: number[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<number, { rating: number; rater_profile_id: string }[]>> {
    return !dropIds.length
      ? {}
      : await this.db
          .execute(
            `
    select rater_profile_id, matter_target_id as drop_id, sum(rating) as rating
    from ${RATINGS_TABLE}
    where matter = '${RateMatter.DROP_REP}'
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
              const f = dbResult.filter((r) => r.drop_id === it.toString());
              if (f) {
                acc[it] = f.map((s) => ({
                  rating: s.rating,
                  rater_profile_id: s.rater_profile_id
                }));
              }
              return acc;
            }, {} as Record<number, { rating: number; rater_profile_id: string }[]>)
          );
  }

  async findDropsTopRepCategories(
    dropIds: number[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<number, { rating: number; category: string }[]>> {
    return !dropIds.length
      ? {}
      : await this.db
          .execute(
            `
    select matter_category as category, matter_target_id as drop_id, sum(rating) as rating
    from ${RATINGS_TABLE}
    where matter = '${RateMatter.DROP_REP}'
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
              const f = dbResult.filter((r) => r.drop_id === it.toString());
              if (f) {
                acc[it] = f.map((s) => ({
                  rating: s.rating,
                  category: s.category
                }));
              }
              return acc;
            }, {} as Record<number, { rating: number; category: string }[]>)
          );
  }

  async findDropsTotalRepByProfile(
    dropIds: number[],
    raterId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<Record<number, number>> {
    return !dropIds.length
      ? {}
      : await this.db
          .execute(
            `
    select matter_target_id as drop_id, sum(rating) as rating
    from ${RATINGS_TABLE}
    where matter = '${RateMatter.DROP_REP}' and matter_target_id in (:dropIds) and rating <> 0 and rater_profile_id = :raterId
    group by 1
    `,
            { dropIds, raterId },
            {
              wrappedConnection: connection
            }
          )
          .then((dbResult: any[]) =>
            dbResult.reduce((acc, it) => {
              acc[parseInt(it.drop_id)] = it.rating;
              return acc;
            }, {} as Record<number, number>)
          );
  }

  async findDropsCategoryRepsByProfile(
    dropIds: number[],
    raterId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<
      number,
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
                                      where matter = '${RateMatter.DROP_REP}'
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
      if (!acc[parseInt(it.drop_id)]) {
        acc[parseInt(it.drop_id)] = [];
      }
      acc[parseInt(it.drop_id)].push({
        category: it.category,
        profile_rating: it.profile_rating,
        total_rating: it.total_rating
      });
      return acc;
    }, {} as Record<number, { category: string; profile_rating: number; total_rating: number }[]>);
  }

  async countDiscussionCommentsByDropId(
    dropId: number,
    logType?: ProfileActivityLogType
  ): Promise<number> {
    const logTypes = logType
      ? [logType]
      : [
          ProfileActivityLogType.DROP_COMMENT,
          ProfileActivityLogType.DROP_REP_EDIT,
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
          ProfileActivityLogType.DROP_REP_EDIT,
          ProfileActivityLogType.DROP_CREATED
        ];
    const page = query.page;
    const pageSize = query.page_size;
    const offset = (page - 1) * pageSize;
    return this.db
      .execute(
        `select * from ${PROFILES_ACTIVITY_LOGS_TABLE} where target_id = :dropId and type in (:logTypes) order by ${query.sort} ${query.sort_direction} limit ${pageSize} offset ${offset}`,
        {
          dropId: query.drop_id.toString(),
          logTypes
        }
      )
      .then((it) =>
        it.map((log: any) => ({ ...log, contents: JSON.parse(log.contents) }))
      );
  }

  async insertDiscussionComment(
    commentRequest: { drop_id: number; content: string; author_id: string },
    connection: ConnectionWrapper<any>
  ): Promise<string> {
    const id = uniqueShortId();
    await this.db.execute(
      `insert into ${PROFILES_ACTIVITY_LOGS_TABLE} (id, profile_id, target_id, contents, type, created_at) values (:id, :profile_id, :target_id, :contents, :type, :created_at)`,
      {
        id,
        profile_id: commentRequest.author_id,
        target_id: commentRequest.drop_id.toString(),
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
    { dropIds, inputProfileId }: { dropIds: number[]; inputProfileId?: string },
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<
      number,
      {
        discussion_comments_count: number;
        rep_logs_count: number;
        input_profile_discussion_comments_count: number | null;
      }
    >
  > {
    const dbResults: {
      target_id: string;
      discussion_comments_count: number;
      rep_logs_count: number;
      input_profile_discussion_comments_count?: number;
    }[] = await this.db.execute(
      `
    select 
       target_id, 
       sum(case when type = '${
         ProfileActivityLogType.DROP_COMMENT
       }' then 1 else 0 end) as discussion_comments_count,
       ${
         inputProfileId
           ? `sum(case when type = '${ProfileActivityLogType.DROP_COMMENT}' and profile_id = :inputProfileId then 1 else 0 end) as input_profile_discussion_comments_count,`
           : ``
       }
       sum(case when type = '${
         ProfileActivityLogType.DROP_REP_EDIT
       }' then 1 else 0 end) as rep_logs_count
    from ${PROFILES_ACTIVITY_LOGS_TABLE}
    where target_id in (:dropIds) group by 1
       `,
      { dropIds: dropIds.map((it) => it.toString()), inputProfileId },
      connection ? { wrappedConnection: connection } : undefined
    );
    return dbResults.reduce((acc, it) => {
      acc[parseInt(it.target_id)] = {
        discussion_comments_count: it.discussion_comments_count,
        rep_logs_count: it.rep_logs_count,
        input_profile_discussion_comments_count:
          it.input_profile_discussion_comments_count ?? null
      };
      return acc;
    }, {} as Record<number, { discussion_comments_count: number; rep_logs_count: number; input_profile_discussion_comments_count: number | null }>);
  }

  async getDropsQuoteCounts(
    dropsIds: number[],
    inputProfileId: string | undefined,
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<number, { total: number; by_input_profile: number | null }>
  > {
    if (!dropsIds.length) {
      return {};
    }
    return this.db
      .execute(
        `select quoted_drop_id as drop_id, count(*) as total ${
          inputProfileId
            ? `, sum(case when author_id = :inputProfileId then 1 else 0 end) as by_input_profile `
            : ``
        } from ${DROPS_TABLE} where quoted_drop_id in (:dropsIds) group by 1`,
        { dropsIds, inputProfileId },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then(
        (
          it: {
            drop_id: number;
            total: number;
            by_input_profile: number | null;
          }[]
        ) =>
          dropsIds.reduce((acc, i) => {
            acc[i] = it.find((r) => r.drop_id === i) ?? {
              total: 0,
              by_input_profile: inputProfileId ? 0 : null
            };
            return acc;
          }, {} as Record<number, { total: number; by_input_profile: number | null }>)
      );
  }
}

export type NewDropEntity = Omit<Drop, 'id' | 'created_at'>;

export const dropsDb = new DropsDb(dbSupplier, communityMemberCriteriaService);
