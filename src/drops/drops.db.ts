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
  DROP_RANK_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROP_RELATIONS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  RATINGS_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_TABLE
} from '../constants';
import {
  userGroupsService,
  UserGroupsService
} from '../api-serverless/src/community-members/user-groups.service';
import { Time, Timer } from '../time';
import { PageSortDirection } from '../api-serverless/src/page-request';
import { WaveCreditType, WaveEntity } from '../entities/IWave';
import { NotFoundException } from '../exceptions';
import { RequestContext } from '../request.context';
import { ActivityEventTargetType } from '../entities/IActivityEvent';
import { DeletedDropEntity } from '../entities/IDeletedDrop';
import { DropRelationEntity } from '../entities/IDropRelation';
import { ApiDropSearchStrategy } from '../api-serverless/src/generated/models/ApiDropSearchStrategy';
import { DropVoterStateEntity } from '../entities/IDropVoterState';
import { ProfileActivityLog } from '../entities/IProfileActivityLog';
import { assertUnreachable } from '../helpers';
import { WaveDecisionWinnerDropEntity } from '../entities/IWaveDecision';

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
            }),
                                    participatory_drops_count = (participatory_drops_count + ${
                                      newDropEntity.drop_type ===
                                      DropType.PARTICIPATORY
                                        ? 1
                                        : 0
                                    }),
                                    latest_drop_timestamp     = :now
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
            }),
                                    participatory_drops_count = (participatory_drops_count + ${
                                      newDropEntity.drop_type ===
                                      DropType.PARTICIPATORY
                                        ? 1
                                        : 0
                                    }),
                                    latest_drop_timestamp     = :now
        `,
        { waveId, dropperId: newDropEntity.author_id, now },
        { wrappedConnection: connection }
      ),
      this.db.execute(
        `insert into ${DROPS_TABLE} (id,
                                     author_id,
                                     drop_type,
                                     wave_id,
                                     created_at,
                                     updated_at,
                                     title,
                                     parts_count,
                                     signature,
                                     reply_to_drop_id,
                                     reply_to_part_id${
                                       newDropSerialNo !== null
                                         ? `, serial_no`
                                         : ``
                                     })
         values (:id,
                 :author_id,
                 :drop_type,
                 :wave_id,
                 :created_at,
                 :updated_at,
                 :title,
                 :parts_count,
                 :signature,
                 :reply_to_drop_id,
                 :reply_to_part_id
              ${newDropSerialNo !== null ? `, :serial_no` : ``})`,

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
          insert into ${DROP_RELATIONS_TABLE} (parent_id,
                                               child_id,
                                               child_serial_no,
                                               wave_id)
          values ${newRelations
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
        `insert into ${DROPS_MENTIONS_TABLE} (drop_id,
                                              mentioned_profile_id,
                                              handle_in_content,
                                              wave_id)
         values (:drop_id,
                 :mentioned_profile_id,
                 :handle_in_content,
                 :wave_id)`,
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
          `insert into ${DROP_REFERENCED_NFTS_TABLE} (drop_id,
                                                      contract,
                                                      token,
                                                      name,
                                                      wave_id)
           values (:drop_id,
                   :contract,
                   :token,
                   :name,
                   :wave_id)`,
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
          `insert into ${DROP_METADATA_TABLE} (drop_id,
                                               data_key,
                                               data_value,
                                               wave_id)
           values (:drop_id,
                   :data_key,
                   :data_value,
                   :wave_id)`,
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
      include_replies,
      drop_type
    }: {
      group_id: string | null;
      group_ids_user_is_eligible_for: string[];
      serial_no_less_than: number | null;
      amount: number;
      wave_id: string | null;
      author_id: string | null;
      include_replies: boolean;
      drop_type: DropType | null;
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
         where ${
           drop_type ? ` d.drop_type = :drop_type and ` : ``
         } d.serial_no < :serialNoLessThan ${
      !include_replies ? `and reply_to_drop_id is null` : ``
    } ${
      author_id ? ` and d.author_id = :author_id ` : ``
    } order by d.serial_no desc limit ${amount}`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      serialNoLessThan,
      groupsUserIsEligibleFor: group_ids_user_is_eligible_for,
      author_id,
      wave_id,
      drop_type
    };
    return this.db.execute(sql, params);
  }

  async findLatestDropsSimple(
    {
      amount,
      serial_no_limit,
      search_strategy,
      wave_id,
      drop_type
    }: {
      serial_no_limit: number | null;
      search_strategy: string;
      amount: number;
      wave_id: string;
      drop_type: DropType | null;
    },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start('dropsDb->findLatestDropsSimple');
    const sqlForOlder = `(select d.* from ${DROPS_TABLE} d where ${
      drop_type ? ` drop_type = :drop_type and ` : ``
    } d.wave_id = :wave_id and d.serial_no < :serial_no_limit order by d.serial_no desc limit ${amount})`;
    const sqlForNewer = `(select d.* from ${DROPS_TABLE} d where ${
      drop_type ? ` drop_type = :drop_type and ` : ``
    } d.wave_id = :wave_id and d.serial_no > :serial_no_limit order by d.serial_no asc limit ${amount})`;
    const sqlForThis = `(select d.* from ${DROPS_TABLE} d where ${
      drop_type ? ` drop_type = :drop_type and ` : ``
    } d.wave_id = :wave_id and d.serial_no = :serial_no_limit)`;
    const sql = `with dr_results as (${[
      search_strategy === ApiDropSearchStrategy.Newer ||
      search_strategy === ApiDropSearchStrategy.Both
        ? sqlForNewer
        : undefined,
      search_strategy === ApiDropSearchStrategy.Both ? sqlForThis : undefined,
      search_strategy === ApiDropSearchStrategy.Older ||
      search_strategy === ApiDropSearchStrategy.Both
        ? sqlForOlder
        : undefined
    ]
      .filter((it) => !!it)
      .join(' union all ')}) select * from dr_results order by serial_no desc`;
    const params = {
      wave_id,
      drop_type,
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
      search_strategy,
      drop_type
    }: {
      amount: number;
      drop_id: string;
      serial_no_limit: number | null;
      search_strategy: string;
      drop_type: DropType | null;
    },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start('dropsDb->findLatestDropRepliesSimple');
    const sqlForOlder = `(select d.* from ${DROPS_TABLE} d join ${DROP_RELATIONS_TABLE} r on d.id = r.child_id where ${
      drop_type ? ` drop_type = :drop_type and ` : ``
    } r.parent_id = :drop_id and serial_no < :serial_no_limit order by d.serial_no desc limit ${amount})`;
    const sqlForNewer = `(select d.* from ${DROPS_TABLE} d join ${DROP_RELATIONS_TABLE} r on d.id = r.child_id where ${
      drop_type ? ` drop_type = :drop_type and ` : ``
    } r.parent_id = :drop_id and serial_no > :serial_no_limit order by d.serial_no asc limit ${amount})`;
    const sqlForThis = `select d.* from ${DROPS_TABLE} d join ${DROP_RELATIONS_TABLE} r on d.id = r.child_id where ${
      drop_type ? ` drop_type = :drop_type and ` : ``
    } r.parent_id = :drop_id and serial_no = :serial_no_limit`;
    const sql = `with dr_results as (${[
      search_strategy === ApiDropSearchStrategy.Newer ||
      search_strategy === ApiDropSearchStrategy.Both
        ? sqlForNewer
        : undefined,
      search_strategy === ApiDropSearchStrategy.Both ? sqlForThis : undefined,
      search_strategy === ApiDropSearchStrategy.Older ||
      search_strategy === ApiDropSearchStrategy.Both
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

  async countRepliesByDropIds(
    {
      dropIds,
      drop_type,
      context_profile_id
    }: {
      dropIds: string[];
      context_profile_id?: string | null;
      drop_type: DropType | null;
    },
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
    from ${DROPS_TABLE}
    where ${
      drop_type ? ` drop_type = :drop_type and ` : ``
    } drops.reply_to_drop_id in (:dropIds)
    group by 1, 2`;
    return this.db
      .execute(
        sql,
        {
          dropIds,
          drop_type,
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
          `insert into ${DROPS_PARTS_TABLE} (drop_id, drop_part_id, content, quoted_drop_id, quoted_drop_part_id,
                                             wave_id)
           values (:drop_id, :drop_part_id, :content, :quoted_drop_id, :quoted_drop_part_id, :wave_id)`,
          part,
          { wrappedConnection: connection }
        )
      )
    );
    timer.stop(`dropsDb->insertDropParts`);
  }

  async findRepliesByDropId(param: {
    sort_direction: PageSortDirection;
    drop_type: DropType | null;
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
      `select * from ${DROPS_TABLE} where ${
        param.drop_type ? ` drop_type = :drop_type and ` : ``
      } reply_to_drop_id = :drop_id and reply_to_part_id = :drop_part_id order by ${sort} ${direction} limit ${limit} offset ${offset}`,
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
      `update ${WAVE_METRICS_TABLE}
       set drops_count = drops_count - 1
       where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('dropsDb->updateWaveDropCounters');
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
      `insert into ${DELETED_DROPS_TABLE} (id, wave_id, author_id, created_at, deleted_at)
       values (:id, :wave_id, :author_id, :created_at, :deleted_at)`,
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
      is_deleted: boolean;
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
        is_deleted: entity.is_deleted
      })
    );
    trace.push({ drop_id: dropId, is_deleted: false });
    ctx.timer?.stop('dropsDb->getTraceForDrop');
    return trace;
  }

  async findWeightedLeaderboardDrops(
    params: LeaderboardParams,
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start(`${this.constructor.name}->findWeightedLeaderboardDrops`);
    const sql = `
        with ddata as (
            select
                we.drop_id as drop_id,
                cast(ifnull(we.vote, 0) as signed) as vote,
                cast(ifnull(we.timestamp, d.created_at) as signed) as timestamp from ${DROPS_TABLE} d
                                                                                         left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} we on d.id = we.drop_id
            where we.wave_id = :wave_id
              and d.drop_type = 'PARTICIPATORY'
        ),
             dranks as (
                 select drop_id, rnk, vote from (select drop_id,
                                                        vote,
                                                        timestamp,
                                                        RANK() OVER (ORDER BY vote DESC, timestamp ASC) AS rnk
                                                 from ddata) drop_ranks
             )
        select d.* from dranks r join drops d on d.id = r.drop_id ${
          params.author_identity ? ` where d.author_id = :author_identity ` : ``
        } order by ${
      params.sort === LeaderboardSort.RANK ? `r.rnk` : 'd.created_at'
    } ${params.sort_direction} limit :page_size offset :offset
    `;
    const sqlParams = {
      wave_id: params.wave_id,
      author_identity: params.author_identity,
      page_size: params.page_size,
      offset: params.page_size * (params.page - 1)
    };
    const results = await this.db.execute<DropEntity>(sql, sqlParams, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(`${this.constructor.name}->findWeightedLeaderboardDrops`);
    return results;
  }

  async findRealtimeLeaderboardDrops(
    params: { offset: number; limit: number; wave_id: string },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start(`${this.constructor.name}->findLeaderboardDrops`);
    const sql = `
    with ddata as (select d.id                                    as drop_id,
                      cast(ifnull(r.vote, 0) as signed)         as vote,
                      cast(ifnull(r.last_increased, d.created_at) as signed) as timestamp
               from ${DROPS_TABLE} d
                        left join drop_ranks r ON r.drop_id = d.id
               where d.wave_id = :wave_id
                 and d.drop_type = '${DropType.PARTICIPATORY}'),
      dranks as (
            select drop_id, rnk, vote from (select drop_id,
                                                 vote,
                                                 timestamp,
                                                 RANK() OVER (ORDER BY vote DESC, timestamp ASC) AS rnk
                                          from ddata) drop_ranks
          )
      select d.*, r.rnk, r.vote from dranks r join drops d on d.id = r.drop_id order by r.rnk limit :limit offset :offset
    `;
    const sqlParams = {
      wave_id: params.wave_id,
      limit: params.limit,
      offset: params.offset
    };
    const results = await this.db.execute<DropEntity>(sql, sqlParams, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(`${this.constructor.name}->findLeaderboardDrops`);
    return results;
  }

  async countParticipatoryDrops(
    params: LeaderboardParams,
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->countLeaderboardDrops`);
    const count = await this.db
      .oneOrNull<{ cnt: number }>(
        `select count(*) as cnt from ${DROPS_TABLE} where wave_id = :wave_id and drop_type = :drop_type ${
          params.author_identity ? ` and author_id = :author_identity ` : ``
        } `,
        {
          wave_id: params.wave_id,
          author_identity: params.author_identity,
          drop_type: DropType.PARTICIPATORY
        },
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it?.cnt ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->countLeaderboardDrops`);
    return count;
  }

  async findTdhBasedSubmissionDropOvervotersWithOvervoteAmounts(
    ctx: RequestContext
  ): Promise<ProfileOverVoteAmountInWave[]> {
    ctx.timer?.start(
      `${this.constructor.name}->findWaveScopeTdhBasedSubmissionDropOvervotersWithOvervoteAmounts`
    );
    const results = await this.db.execute<ProfileOverVoteAmountInWave>(
      `
          with given_tdh_votes as (select voter_id, wave_id, sum(abs(votes)) as total_given_votes
                                   from ${DROP_VOTER_STATE_TABLE}
                                   group by 1, 2)
          select v.voter_id as voter_id, wave_id, i.tdh as tdh, v.total_given_votes as total_given_votes
                               from given_tdh_votes v
                                        join ${IDENTITIES_TABLE} i on v.voter_id = i.profile_id
                                        join ${WAVES_TABLE} w on v.wave_id = w.id
                               where w.voting_credit_type = '${WaveCreditType.TDH}'
                                 and v.total_given_votes > i.tdh
      `,
      {},
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->findWaveScopeTdhBasedSubmissionDropOvervotersWithOvervoteAmounts`
    );
    return results;
  }

  async hasProfileVotedInAnyOpenRepBasedWave(
    profileId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    ctx.timer?.start(
      `${this.constructor.name}->hasProfileVotedInAnyOpenRepBasedWave`
    );
    const now = Time.currentMillis();
    const result = await this.db
      .oneOrNull<{ cnt: number }>(
        `
          with open_rep_waves as (select *
                        from ${WAVES_TABLE}
                        where voting_credit_type = 'REP'
                          and (voting_period_start is null or voting_period_start < :now)
                          and (voting_period_end is null or voting_period_end > :now))
          select count(*) as cnt from open_rep_waves w
          join ${DROP_VOTER_STATE_TABLE} dvs on dvs.wave_id = w.id
          where dvs.voter_id = :profileId
        `,
        { profileId, now },
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it!.cnt > 0);
    ctx.timer?.stop(
      `${this.constructor.name}->hasProfileVotedInAnyOpenRepBasedWave`
    );
    return result;
  }

  async findRepBasedSubmissionDropOvervotedWavesWithOvervoteAmounts(
    param: {
      voter_id: string;
      creditor_id: string | null;
      credit_category: string | null;
      credit_limit: number;
    },
    ctx: RequestContext
  ): Promise<TotalGivenVotesInWave[]> {
    ctx.timer?.start(
      `${this.constructor.name}->findRepBasedSubmissionDropOvervotedWavesWithOvervoteAmounts`
    );
    const now = Time.currentMillis();
    const results = await this.db.execute<TotalGivenVotesInWave>(
      `
          with given_rep_votes as (select wave_id, sum(abs(votes)) as total_given_votes
                                   from ${DROP_VOTER_STATE_TABLE}
                                   where voter_id = :voter_id
                                   group by 1)
          select t.wave_id as wave_id, t.total_given_votes as total_given_votes
                               from given_rep_votes t
                                        join ${WAVES_TABLE} w on t.wave_id = w.id
                               where (w.voting_period_start is null or w.voting_period_start < :now) and (w.voting_period_end is null or w.voting_period_end > :now) and
                                w.voting_credit_type = '${WaveCreditType.REP}'
                                 and t.total_given_votes > :credit_limit
                                    ${
                                      param.creditor_id
                                        ? ` and w.voting_credit_creditor = :creditor_id `
                                        : ``
                                    }
                                    ${
                                      param.credit_category
                                        ? ` and w.voting_credit_category = :credit_category `
                                        : ``
                                    }
      `,
      { ...param, now },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->findRepBasedSubmissionDropOvervotedWavesWithOvervoteAmounts`
    );
    return results;
  }

  async findDropVotesForWaves(
    params: { profile_id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<
    (DropVoterStateEntity & {
      author_id: string;
      visibility_group_id: string | null;
    })[]
  > {
    ctx.timer?.start(`${this.constructor.name}->findDropVotesForWaves`);
    const results = await this.db.execute<
      DropVoterStateEntity & {
        author_id: string;
        visibility_group_id: string | null;
      }
    >(
      `
        select v.*, d.author_id as author_id, w.visibility_group_id as visibility_group_id from ${DROP_VOTER_STATE_TABLE} v
         join drops d on d.id = v.drop_id
         join waves w on w.id = d.wave_id
         where v.wave_id = :wave_id and v.voter_id = :profile_id and votes <> 0
      `,
      params,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.start(`${this.constructor.name}->findDropVotesForWaves`);
    return results;
  }

  async updateDropVoterState(
    param: { drop_id: string; profile_id: string; votes: number },
    ctx: RequestContext
  ) {
    await this.db.execute(
      `update ${DROP_VOTER_STATE_TABLE} set votes = :votes where drop_id = :drop_id and voter_id = :profile_id`,
      param,
      { wrappedConnection: ctx.connection }
    );
  }

  async updateDropRank(
    param: { drop_id: string; profile_id: string; change: number },
    ctx: RequestContext
  ) {
    await this.db.execute(
      `update ${DROP_RANK_TABLE} set vote = vote + :change where drop_id = :drop_id`,
      param,
      { wrappedConnection: ctx.connection }
    );
  }

  async findCategoryRepAmountFromProfileForProfile(
    param: {
      rep_recipient_id: string;
      rep_giver_id: string;
      credit_category: string;
    },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->findRepAmountsForProfile`);
    const result = await this.db
      .oneOrNull<{
        total_rep: number;
      }>(
        `
      select 
       sum(rating) as total_rep
       from ${RATINGS_TABLE} where matter = 'REP' and matter_target_id = :rep_recipient_id and matter_category = :credit_category and rater_profile_id = :rep_giver_id and rating <> 0
    `,
        param,
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it?.total_rep ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->findRepAmountsForProfile`);
    return result;
  }

  async findDropLogEntities(
    param: DropLogsQueryParams,
    ctx: RequestContext
  ): Promise<ProfileActivityLog[]> {
    ctx.timer?.start(`${this.constructor.name}->findDropLogs`);
    const results = await this.db.execute<ProfileActivityLog>(
      `
      select * from ${PROFILES_ACTIVITY_LOGS_TABLE} where additional_data_2 = :wave_id ${
        param.drop_id ? ` and target_id = :drop_id ` : ``
      } and type in (:log_types) order by created_at ${
        param.sort_direction
      } limit :limit offset :offset
    `,
      param,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->findDropLogs`);
    return results;
  }

  async findVotersInfo(
    params: DropVotersStatsParams,
    ctx: RequestContext
  ): Promise<DropVotersInfoFromDb[]> {
    ctx.timer?.start(`${this.constructor.name}->findVotersInfo`);
    let order_by = '';
    switch (params.sort) {
      case DropVotersStatsSort.ABSOLUTE: {
        order_by = 'absolute_votes_summed';
        break;
      }
      case DropVotersStatsSort.POSITIVE: {
        order_by = 'positive_votes_summed';
        break;
      }
      case DropVotersStatsSort.NEGATIVE:
        order_by = 'negative_votes_summed';
        break;
      default: {
        assertUnreachable(params.sort);
      }
    }
    const sql = `
    with voter_stats as (
      select 
          voter_id,
          sum(votes) as votes_summed,
          sum(case when votes > 0 then votes else 0 end) as positive_votes_summed,
          sum(case when votes < 0 then votes else 0 end) as negative_votes_summed,
          sum(abs(votes)) as absolute_votes_summed,
          max(votes) as max_vote,
          min(votes) as min_vote,
          avg(votes) as average_vote,
          count(*) as different_drops_voted
      from ${DROP_VOTER_STATE_TABLE} where 
        wave_id = :wave_id ${params.drop_id ? ` and drop_id = :drop_id ` : ``}
        and votes <> 0
        group by voter_id
    ) select * from voter_stats 
      order by ${order_by} ${
      params.sort_direction
    } limit :page_size offset :offset
    `;
    const sqlParams = {
      ...params,
      offset: params.page_size * (params.page - 1)
    };
    const result = await this.db.execute<DropVotersInfoFromDb>(sql, sqlParams, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(`${this.constructor.name}->findVotersInfo`);
    return result;
  }

  async countVoters(
    params: DropVotersStatsParams,
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->findVotersInfo`);
    const sql = `
      select 
          count(distinct voter_id) as cnt
      from ${DROP_VOTER_STATE_TABLE} where 
        wave_id = :wave_id ${params.drop_id ? ` and drop_id = :drop_id ` : ``}
        and votes <> 0
    `;
    const sqlParams = {
      ...params
    };
    const result = await this.db
      .oneOrNull<{ cnt: number }>(sql, sqlParams, {
        wrappedConnection: ctx.connection
      })
      .then((it) => it?.cnt ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->findVotersInfo`);
    return result;
  }

  async getWinDecisionsForDrops(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, WaveDecisionWinnerDropEntity>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getWinDecisionsForDrops`);
    const entities = await this.db.execute<
      Omit<WaveDecisionWinnerDropEntity, 'prizes'> & { prizes: string }
    >(
      `select * from ${WAVES_DECISION_WINNER_DROPS_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->getWinDecisionsForDrops`);
    return entities.reduce((acc, it) => {
      acc[it.drop_id] = { ...it, prizes: JSON.parse(it.prizes) };
      return acc;
    }, {} as Record<string, WaveDecisionWinnerDropEntity>);
  }

  async findWaveIdByDropId(
    dropId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    return await this.db
      .oneOrNull<{ wave_id: string }>(
        `select wave_id from ${DROPS_TABLE} where id = :dropId`,
        { dropId },
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it?.wave_id ?? null);
  }

  async findWinnerDrops(params: LeaderboardParams, ctx: RequestContext) {
    return this.db.execute<DropEntity>(
      `select d.* from ${WAVES_DECISION_WINNER_DROPS_TABLE} wd 
    join ${DROPS_TABLE} d on d.id = wd.drop_id
    where wd.wave_id = :wave_id
    order by wd.ranking asc limit :limit offset :offset
    `,
      {
        wave_id: params.wave_id,
        limit: params.page_size,
        offset: (params.page - 1) * params.page_size
      },
      { wrappedConnection: ctx.connection }
    );
  }

  async countWinningDrops(
    params: LeaderboardParams,
    ctx: RequestContext
  ): Promise<number> {
    return this.db
      .oneOrNull<{ cnt: number }>(
        `select count(*) as cnt from ${WAVES_DECISION_WINNER_DROPS_TABLE} wd where wd.wave_id = :wave_id`,
        params,
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it?.cnt ?? 0);
  }

  async getWaveEndingTimesByDropIds(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    const dbResult = await this.db.execute<{
      drop_id: string;
      wave_ending_time: number | null;
    }>(
      `
      select d.id as drop_id, w.voting_period_end as wave_ending_time from ${DROPS_TABLE} d
      join ${WAVES_TABLE} w on d.wave_id = w.id where d.id in (:dropIds)
      `,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    return dbResult.reduce((acc, it) => {
      if (it.wave_ending_time) {
        acc[it.drop_id] = it.wave_ending_time;
      }
      return acc;
    }, {} as Record<string, number>);
  }
}

export interface DropVotersInfoFromDb {
  readonly voter_id: string;
  readonly votes_summed: number;
  readonly positive_votes_summed: number;
  readonly negative_votes_summed: number;
  readonly absolute_votes_summed: number;
  readonly max_vote: number;
  readonly min_vote: number;
  readonly average_vote: number;
  readonly different_drops_voted: number;
}

export interface ProfileOverVoteAmountInWave extends TotalGivenVotesInWave {
  profile_id: string;
  tdh: number;
}

export interface TotalGivenVotesInWave {
  readonly wave_id: string;
  readonly total_given_votes: number;
}

export type NewDropEntity = Omit<DropEntity, 'serial_no'> & {
  serial_no: number | null;
};

export enum LeaderboardSort {
  RANK = 'RANK',
  CREATION_TIME = 'CREATION_TIME'
}

export interface LeaderboardParams {
  readonly wave_id: string;
  page_size: number;
  readonly page: number;
  readonly sort_direction: PageSortDirection;
  readonly sort: LeaderboardSort;
  readonly author_identity: string | null;
}

export interface DropLogsQueryParams {
  readonly wave_id: string;
  readonly offset: number;
  readonly limit: number;
  readonly drop_id: string | null;
  readonly log_types: string[];
  readonly sort_direction: PageSortDirection;
}

export enum DropVotersStatsSort {
  ABSOLUTE = 'ABSOLUTE',
  POSITIVE = 'POSITIVE',
  NEGATIVE = 'NEGATIVE'
}

export interface DropVotersStatsParams {
  readonly wave_id: string;
  readonly drop_id: string | null;
  readonly page_size: number;
  readonly page: number;
  readonly sort_direction: PageSortDirection;
  readonly sort: DropVotersStatsSort;
}

export const dropsDb = new DropsDb(dbSupplier, userGroupsService);
