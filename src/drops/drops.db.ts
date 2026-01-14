import {
  userGroupsService,
  UserGroupsService
} from '../api-serverless/src/community-members/user-groups.service';
import { ApiDropSearchStrategy } from '../api-serverless/src/generated/models/ApiDropSearchStrategy';
import { PageSortDirection } from '../api-serverless/src/page-request';
import { assertUnreachable } from '../assertions';
import { collections } from '../collections';
import {
  ACTIVITY_EVENTS_TABLE,
  DELETED_DROPS_TABLE,
  DROP_BOOSTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
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
  WAVES_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
} from '../constants';
import { ActivityEventTargetType } from '../entities/IActivityEvent';
import { DeletedDropEntity } from '../entities/IDeletedDrop';
import {
  DropBoostEntity,
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropReferencedNftEntity,
  DropType
} from '../entities/IDrop';
import { DropRelationEntity } from '../entities/IDropRelation';
import { DropVoterStateEntity } from '../entities/IDropVoterState';
import { ProfileActivityLog } from '../entities/IProfileActivityLog';
import { WaveCreditType, WaveEntity } from '../entities/IWave';
import { WaveDecisionWinnerDropEntity } from '../entities/IWaveDecision';
import { WinnerDropVoterVoteEntity } from '../entities/IWinnerDropVoterVote';
import { RequestContext } from '../request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { Time, Timer } from '../time';

const mysql = require('mysql');

export class DropsDb extends LazyDbAccessCompatibleService {
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
        .oneOrNull<{
          serial_no: number;
        }>(
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
    return this.db.oneOrNull<DropEntity>(
      `
        select d.* from ${DROPS_TABLE} d where d.id = :id
        `,
      {
        id
      },
      opts
    );
  }

  async findDropByIdWithEligibilityCheck(
    id: string,
    group_ids_user_is_eligible_for: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<DropEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.oneOrNull<DropEntity>(
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
    );
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
      .then((it) => it[0] ?? null);
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
    const sqlAndParams = await userGroupsService.getSqlAndParamsByGroupId(
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
    return this.db.execute<DropEntity>(sql, params);
  }

  async findLatestDropsWithPartsAndMedia(
    {
      limit,
      max_serial_no,
      group_ids_user_is_eligible_for,
      wave_id
    }: {
      limit: number;
      max_serial_no: number | null;
      group_ids_user_is_eligible_for: string[];
      wave_id: string | null;
    },
    ctx: RequestContext
  ): Promise<DropWithMediaAndPart[]> {
    const maxSerialNo = max_serial_no ?? Number.MAX_SAFE_INTEGER;
    const sql = `select d.*, 
    dp.drop_part_id as part_drop_part_id,
    dp.content as part_content,
    dp.quoted_drop_id as part_quoted_drop_id,
    dm.medias_json as medias_json
    from ${DROPS_TABLE} d
         left join ${DROPS_PARTS_TABLE} dp on dp.drop_id = d.id and dp.drop_part_id = 1
         LEFT JOIN (
            SELECT  drop_id,
                    JSON_ARRAYAGG(
                            JSON_OBJECT(
                                    'url',       url,
                                    'mime_type', mime_type
                            )
                    ) AS medias_json
            FROM    ${DROP_MEDIA_TABLE}
            WHERE   drop_part_id = 1
            GROUP BY drop_id
        ) dm ON dm.drop_id = d.id
         join ${WAVES_TABLE} w on d.wave_id = w.id and (${
           group_ids_user_is_eligible_for.length
             ? `w.visibility_group_id in (:groupsUserIsEligibleFor) or w.admin_group_id in (:groupsUserIsEligibleFor) or`
             : ``
         } w.visibility_group_id is null) ${wave_id ? `and w.id = :wave_id` : ``}
         where d.serial_no <= :maxSerialNo 
          order by d.serial_no desc limit :limit`;
    const params: Record<string, any> = {
      limit,
      maxSerialNo: maxSerialNo,
      groupsUserIsEligibleFor: group_ids_user_is_eligible_for,
      wave_id
    };
    return await this.db.execute<DropWithMediaAndPart>(sql, params, {
      wrappedConnection: ctx.connection
    });
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
    return dropIds.reduce(
      (acc, it) => {
        acc[it] = dbResult.filter((r) => r.drop_id === it);
        return acc;
      },
      {} as Record<string, DropMediaEntity[]>
    );
  }

  async getQuoteIds(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<string[]> {
    if (!dropIds.length) {
      return [];
    }
    const dbResult = await this.db.execute<{ quoted_drop_id: string }>(
      `select dp.quoted_drop_id as quoted_drop_id from ${DROPS_PARTS_TABLE} dp join ${DROPS_TABLE} d on d.id = dp.drop_id where d.id in (:dropIds) and dp.quoted_drop_id is not null`,
      { dropIds },
      { wrappedConnection: connection }
    );
    return dbResult.map((r) => r.quoted_drop_id);
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
        return it.reduce(
          (acc, part) => {
            if (!acc[part.drop_id]) {
              acc[part.drop_id] = [];
            }
            acc[part.drop_id].push(part);
            return acc;
          },
          {} as Record<string, DropPartEntity[]>
        );
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

  async findWaveByIdOrNull(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<WaveEntity | null> {
    return this.db.oneOrNull<WaveEntity>(
      `select * from ${WAVES_TABLE} where id = :id`,
      { id },
      connection ? { wrappedConnection: connection } : undefined
    );
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

  public async resyncParticipatoryDropCountsForWaves(
    waveIds: string[],
    ctx: RequestContext
  ) {
    if (!waveIds.length) {
      return;
    }
    ctx.timer?.start('dropsDb->resyncParticipatoryDropCountsForWaves');
    await Promise.all([
      this.db.execute(
        `
            update ${WAVE_DROPPER_METRICS_TABLE}
                left join (select wave_id, author_id, count(*) participatory_drops_count
                           from ${DROPS_TABLE}
                           where drop_type = 'PARTICIPATORY' and wave_id in (:waveIds)
                           group by wave_id, author_id) actual on ${WAVE_DROPPER_METRICS_TABLE}.wave_id = actual.wave_id and
                                                                  ${WAVE_DROPPER_METRICS_TABLE}.dropper_id = actual.author_id
            set ${WAVE_DROPPER_METRICS_TABLE}.participatory_drops_count = ifnull(actual.participatory_drops_count, 0)
            where ${WAVE_DROPPER_METRICS_TABLE}.wave_id in (:waveIds) 
              and ${WAVE_DROPPER_METRICS_TABLE}.participatory_drops_count <> ifnull(actual.participatory_drops_count, 0)
        `,
        { waveIds },
        { wrappedConnection: ctx.connection }
      ),
      this.db.execute(
        `
        update ${WAVE_METRICS_TABLE}
                left join (select wave_id, count(*) participatory_drops_count
                           from ${DROPS_TABLE}
                           where drop_type = 'PARTICIPATORY' and wave_id in (:waveIds)
                           group by wave_id) actual on ${WAVE_METRICS_TABLE}.wave_id = actual.wave_id
            set ${WAVE_METRICS_TABLE}.participatory_drops_count = ifnull(actual.participatory_drops_count, 0)
            where ${WAVE_METRICS_TABLE}.wave_id in (:waveIds) 
              and ${WAVE_METRICS_TABLE}.participatory_drops_count <> ifnull(actual.participatory_drops_count, 0)
        `,
        { waveIds },
        { wrappedConnection: ctx.connection }
      )
    ]);
    ctx.timer?.stop('dropsDb->resyncParticipatoryDropCountsForWaves');
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
        result.reduce(
          (acc, it) => {
            acc[it.id] = it;
            return acc;
          },
          {} as Record<string, DeletedDropEntity>
        )
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
        select d.* from dranks r join drops d on d.id = r.drop_id order by r.rnk ${params.sort_direction} limit :page_size offset :offset
    `;
    const sqlParams = {
      wave_id: params.wave_id,
      page_size: params.page_size,
      offset: params.page_size * (params.page - 1)
    };
    const results = await this.db.execute<DropEntity>(sql, sqlParams, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(`${this.constructor.name}->findWeightedLeaderboardDrops`);
    return results;
  }

  async findWeightedLeaderboardDropsOrderedByPrediction(
    params: LeaderboardParams,
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start(
      `${this.constructor.name}->findWeightedLeaderboardDropsOrderedByPrediction`
    );
    const sql = `
        select d.* from ${WAVE_LEADERBOARD_ENTRIES_TABLE} r join ${DROPS_TABLE} d on d.id = r.drop_id where d.wave_id = :wave_id order by r.vote_on_decision_time ${params.sort_direction} limit :page_size offset :offset
    `;
    const sqlParams = {
      wave_id: params.wave_id,
      page_size: params.page_size,
      offset: params.page_size * (params.page - 1)
    };
    const results = await this.db.execute<DropEntity>(sql, sqlParams, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(
      `${this.constructor.name}->findWeightedLeaderboardDropsOrderedByPrediction`
    );
    return results;
  }

  async findWeightedLeaderboardDropsOrderedByTrend(
    params: LeaderboardParams,
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start(
      `${this.constructor.name}->findWeightedLeaderboardDropsOrderedByTrend`
    );
    const sql = `
        select d.* from ${WAVE_LEADERBOARD_ENTRIES_TABLE} r join ${DROPS_TABLE} d on d.id = r.drop_id where d.wave_id = :wave_id order by (r.vote_on_decision_time - r.vote) ${params.sort_direction} limit :page_size offset :offset
    `;
    const sqlParams = {
      wave_id: params.wave_id,
      page_size: params.page_size,
      offset: params.page_size * (params.page - 1)
    };
    const results = await this.db.execute<DropEntity>(sql, sqlParams, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(
      `${this.constructor.name}->findWeightedLeaderboardDropsOrderedByTrend`
    );
    return results;
  }

  async findWaveParticipationDropsOrderedByCreatedAt(
    params: {
      offset: number;
      wave_id: string;
      limit: number;
      sort_order: PageSortDirection;
    },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start(
      `${this.constructor.name}->findWaveParticipationDropsOrderedByCreatedAt`
    );
    const results = await this.db.execute<DropEntity>(
      `
      select d.* from ${DROPS_TABLE} d 
      where d.wave_id = :wave_id and d.drop_type = '${DropType.PARTICIPATORY}'
      order by d.created_at ${params.sort_order} limit :limit offset :offset
      `,
      params,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->findWaveParticipationDropsOrderedByCreatedAt`
    );
    return results;
  }

  async findRealtimeLeaderboardDrops(
    params: {
      offset: number;
      limit: number;
      wave_id: string;
      sort_order: PageSortDirection;
    },
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
      select d.* from dranks r join drops d on d.id = r.drop_id order by r.rnk ${params.sort_order} limit :limit offset :offset
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

  async findRealtimeLeaderboardDropsOrderedByUsersVotesOrCreationTime(
    params: {
      offset: number;
      limit: number;
      wave_id: string;
      voter_id: string;
      sort_order: PageSortDirection;
    },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    ctx.timer?.start(
      `${this.constructor.name}->findRealtimeLeaderboardDropsOrderedByUsersVotes`
    );
    const sql = `
    with 
      v_vot_tim as (select drop_id, max(timestamp) as timestamp from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} where wave_id = :wave_id and voter_id = :voter_id group by 1),
      v_vot_as as (select dv.* from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} dv join v_vot_tim on v_vot_tim.timestamp = dv.timestamp and v_vot_tim.drop_id = dv.drop_id where dv.voter_id = :voter_id),
      ddata as (select d.id                                    as drop_id,
                      cast(ifnull(r.vote, 0) as signed)         as vote,
                      cast(ifnull(r.timestamp, d.created_at) as signed) as timestamp
               from ${DROPS_TABLE} d
                        left join v_vot_as r ON r.drop_id = d.id
               where d.wave_id = :wave_id
                 and d.drop_type = '${DropType.PARTICIPATORY}'),
      dranks as (
            select drop_id, rnk, vote from (select drop_id,
                                                 vote,
                                                 timestamp,
                                                 RANK() OVER (ORDER BY vote DESC, timestamp ASC) AS rnk
                                          from ddata) drop_ranks
          )
      select d.* from dranks r join drops d on d.id = r.drop_id where r.vote <> 0 order by r.rnk ${params.sort_order} limit :limit offset :offset
    `;
    const sqlParams = {
      wave_id: params.wave_id,
      voter_id: params.voter_id,
      limit: params.limit,
      offset: params.offset
    };
    const results = await this.db.execute<DropEntity>(sql, sqlParams, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(
      `${this.constructor.name}->findRealtimeLeaderboardDropsOrderedByUsersVotes`
    );
    return results;
  }

  async countParticipatoryDrops(
    params: LeaderboardParams,
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->countLeaderboardDrops`);
    const count = await this.db
      .oneOrNull<{ cnt: number }>(
        `select count(*) as cnt from ${DROPS_TABLE} where wave_id = :wave_id and drop_type = :drop_type`,
        {
          wave_id: params.wave_id,
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
    const optionPairs: {
      credit_type:
        | WaveCreditType.TDH
        | WaveCreditType.XTDH
        | WaveCreditType.TDH_PLUS_XTDH;
      identity_field: 'i.tdh' | 'i.xtdh' | '(i.tdh + i.xtdh)';
    }[] = [
      {
        credit_type: WaveCreditType.TDH,
        identity_field: 'i.tdh'
      },
      {
        credit_type: WaveCreditType.XTDH,
        identity_field: 'i.xtdh'
      },
      {
        credit_type: WaveCreditType.TDH_PLUS_XTDH,
        identity_field: '(i.tdh + i.xtdh)'
      }
    ];
    const results = (
      await Promise.all(
        optionPairs.map(({ credit_type, identity_field }) =>
          this.db.execute<ProfileOverVoteAmountInWave>(
            `
        with given_tdh_votes as (select ${DROP_VOTER_STATE_TABLE}.voter_id, ${DROP_VOTER_STATE_TABLE}.wave_id, sum(abs(${DROP_VOTER_STATE_TABLE}.votes)) as total_given_votes
                                 from ${DROP_VOTER_STATE_TABLE}
                                 join ${DROPS_TABLE} on ${DROPS_TABLE}.id = ${DROP_VOTER_STATE_TABLE}.drop_id
                                 where ${DROPS_TABLE}.drop_type = '${DropType.PARTICIPATORY}'
                                 group by 1, 2)
        select v.voter_id as profile_id, wave_id, ${identity_field} as credit_limit, v.total_given_votes as total_given_votes
                             from given_tdh_votes v
                                      join ${IDENTITIES_TABLE} i on v.voter_id = i.profile_id
                                      join ${WAVES_TABLE} w on v.wave_id = w.id
                             where w.voting_credit_type = '${credit_type}'
                               and v.total_given_votes > ${identity_field}
    `,
            {},
            { wrappedConnection: ctx.connection }
          )
        )
      )
    ).flat();
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
         where v.wave_id = :wave_id and v.voter_id = :profile_id and votes <> 0 and d.drop_type = '${DropType.PARTICIPATORY}'
      `,
      params,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.start(`${this.constructor.name}->findDropVotesForWaves`);
    return results;
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
    return entities.reduce(
      (acc, it) => {
        acc[it.drop_id] = { ...it, prizes: JSON.parse(it.prizes) };
        return acc;
      },
      {} as Record<string, WaveDecisionWinnerDropEntity>
    );
  }

  async findWaveIdByDropId(
    dropId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    return await this.db
      .oneOrNull<{
        wave_id: string;
      }>(
        `select wave_id from ${DROPS_TABLE} where id = :dropId`,
        { dropId },
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it?.wave_id ?? null);
  }

  async findDropIdsOfWavesWhereNegativeVotesAreNotAllowed(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<string[]> {
    if (!dropIds.length) {
      return [];
    }
    const results = await this.db.execute<{ id: string }>(
      `
      select d.id from ${DROPS_TABLE} d join ${WAVES_TABLE} w on w.id = d.wave_id where w.forbid_negative_votes and d.id in (:dropIds)
    `,
      { dropIds },
      { wrappedConnection: connection }
    );
    return results.map((it) => it.id);
  }

  async getWinnerDropVoters(
    {
      drop_id,
      page_size,
      page,
      direction
    }: {
      drop_id: string;
      page: number;
      page_size: number;
      direction: PageSortDirection;
    },
    ctx: RequestContext
  ): Promise<WinnerDropVoterVoteEntity[]> {
    const params = {
      limit: page_size,
      offset: page_size * (page - 1),
      dropId: drop_id
    };
    return await this.db.execute<WinnerDropVoterVoteEntity>(
      `select * from ${WINNER_DROP_VOTER_VOTES_TABLE} where drop_id = :dropId order by abs(votes) ${direction} limit :limit offset :offset`,
      params,
      { wrappedConnection: ctx.connection }
    );
  }

  async countWinnerDropVoters(
    dropId: string,
    ctx: RequestContext
  ): Promise<number> {
    return await this.db
      .oneOrNull<{
        cnt: number;
      }>(
        `select count(*) as cnt from ${WINNER_DROP_VOTER_VOTES_TABLE} where drop_id = :dropId`,
        { dropId },
        { wrappedConnection: ctx.connection }
      )
      .then((res) => res?.cnt ?? 0);
  }

  async searchDropsContainingPhraseInWave(
    param: {
      wave_id: string;
      term: string;
      limit: number;
      offset: number;
    },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->searchDropsContainingPhraseInWave`
      );
      const normalizedTerm = param.term.trim().replace(/\s+/g, ' ');
      if (!normalizedTerm.length) {
        return [];
      }
      const booleanPhrase = `"${normalizedTerm}"`;
      const likeTerm = normalizedTerm.replace(/[\\%_]/g, '\\$&');
      return this.db.execute<DropEntity>(
        `
        SELECT
            d.*
        FROM drops_parts p
        JOIN drops d on p.drop_id = d.id
        WHERE d.wave_id = :wave_id AND
              MATCH(p.content) AGAINST (:term IN BOOLEAN MODE) > 0 AND
              LOWER(p.content) LIKE LOWER(CONCAT('%', :likeTerm, '%')) ESCAPE '\\\\'
        ORDER BY d.created_at DESC
        LIMIT :limit OFFSET :offset
      `,
        { ...param, term: booleanPhrase, likeTerm },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->searchDropsContainingPhraseInWave`
      );
    }
  }

  public async countBoostsOfGivenDrops(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    try {
      ctx.timer?.start(`${this.constructor.name}->countBoostsOfGivenDrops`);
      if (!dropIds.length) {
        return {};
      }
      const res = await this.db.execute<{ drop_id: string; cnt: number }>(
        `
          select drop_id, count(*) as cnt from ${DROP_BOOSTS_TABLE} where drop_id in (:dropIds) group by 1
        `,
        { dropIds },
        { wrappedConnection: ctx.connection }
      );
      return res.reduce(
        (acc, it) => {
          acc[it.drop_id] = +it.cnt;
          return acc;
        },
        {} as Record<string, number>
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countBoostsOfGivenDrops`);
    }
  }

  public async whichOfGivenDropsAreBoostedByIdentity(
    dropIds: string[],
    identityId: string,
    ctx: RequestContext
  ): Promise<Set<string>> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->whichOfGivenDropsAreBoostedByIdentity`
      );
      if (!dropIds.length) {
        return new Set<string>();
      }
      const res = await this.db.execute<{ drop_id: string }>(
        `
          select drop_id from ${DROP_BOOSTS_TABLE} where booster_id = :identityId and drop_id in (:dropIds)
        `,
        { dropIds, identityId },
        { wrappedConnection: ctx.connection }
      );
      return collections.toSet(res.map((it) => it.drop_id));
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->whichOfGivenDropsAreBoostedByIdentity`
      );
    }
  }

  public async findBoostedDrops(
    {
      wave_id,
      eligibile_groups,
      limit,
      offset,
      booster_id,
      author_id,
      min_boosts,
      order_by,
      count_only_boosts_after,
      order
    }: {
      wave_id: string | null;
      eligibile_groups: string[];
      limit: number;
      offset: number;
      booster_id: string | null;
      author_id: string | null;
      min_boosts: number | null;
      order_by:
        | 'last_boosted_at'
        | 'first_boosted_at'
        | 'drop_created_at'
        | 'boosts';
      count_only_boosts_after: number;
      order: 'ASC' | 'DESC';
    },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->findBoostedDrops`);
      const aggregateSql = `
        select 
          d.id as drop_id,
          d.created_at as drop_created_at,
          count(*) as boosts, 
          min(p.boosted_at) as first_boosted_at, 
          max(p.boosted_at) as last_boosted_at,
          sum(if(p.booster_id = :booster_id or :booster_id is null, 1, 0)) as includes_booster
        from ${DROPS_TABLE} d 
        JOIN ${DROP_BOOSTS_TABLE} p on p.drop_id = d.id
        join ${WAVES_TABLE} w on w.id = d.wave_id
        where p.boosted_at > :count_only_boosts_after
        and (w.visibility_group_id is null ${eligibile_groups.length ? `or w.visibility_group_id in (:eligibile_groups)` : ''})
        ${author_id ? ` and d.author_id = :author_id ` : ''}
        ${wave_id ? ` and d.wave_id = :wave_id ` : ''}
        group by 1, 2
      `;
      const sql = `
        with boosts_aggregate as (${aggregateSql}) select d.* from boosts_aggregate a
        join ${DROPS_TABLE} d on a.drop_id = d.id
        where a.includes_booster > 0
        ${min_boosts !== null ? ` and a.boosts >= :min_boosts ` : ''}
        order by ${order_by} ${order} limit :limit offset :offset
      `;
      return await this.db.execute<DropEntity>(
        sql,
        {
          wave_id,
          eligibile_groups,
          limit,
          offset,
          booster_id,
          author_id,
          min_boosts,
          order_by,
          count_only_boosts_after,
          order
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findBoostedDrops`);
    }
  }

  public async countBoostedDrops(
    {
      wave_id,
      booster_id,
      author_id,
      eligibile_groups,
      min_boosts,
      count_only_boosts_after
    }: {
      wave_id: string | null;
      eligibile_groups: string[];
      booster_id: string | null;
      author_id: string | null;
      min_boosts: number | null;
      count_only_boosts_after: number;
    },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->countBoostedDrops`);
      const aggregateSql = `
        select 
          d.id as drop_id,
          d.created_at as drop_created_at,
          count(*) as boosts, 
          min(p.boosted_at) as first_boosted_at, 
          max(p.boosted_at) as last_boosted_at,
          sum(if(p.booster_id = :booster_id or :booster_id is null, 1, 0)) as includes_booster
        from ${DROPS_TABLE} d 
        join ${DROP_BOOSTS_TABLE} p on p.drop_id = d.id
        join ${WAVES_TABLE} w on w.id = d.wave_id
        where p.boosted_at > :count_only_boosts_after
        and (w.visibility_group_id is null ${eligibile_groups.length ? `or w.visibility_group_id in (:eligibile_groups)` : ''})
        ${author_id ? ` and d.author_id = :author_id ` : ''}
        ${wave_id ? ` and d.wave_id = :wave_id ` : ''}
        group by 1, 2 
      `;
      const sql = `
        with boosts_aggregate as (${aggregateSql}) select count(a.drop_id) as cnt from boosts_aggregate a
        where a.includes_booster > 0
        ${min_boosts !== null ? ` and a.boosts >= :min_boosts ` : ''}
      `;
      const res = await this.db.oneOrNull<{ cnt: number }>(
        sql,
        {
          wave_id,
          booster_id,
          author_id,
          min_boosts,
          eligibile_groups,
          count_only_boosts_after
        },
        { wrappedConnection: ctx.connection }
      );
      return res?.cnt ?? 0;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countBoostedDrops`);
    }
  }

  async boostDrop(
    {
      drop_id,
      booster_id,
      wave_id
    }: { drop_id: string; booster_id: string; wave_id: string },
    ctx: RequestContext
  ) {
    await this.db.execute(
      `insert into ${DROP_BOOSTS_TABLE} (drop_id, booster_id, wave_id, boosted_at) values (:drop_id, :booster_id, :wave_id, :boosted_at) on duplicate key update booster_id = values(booster_id)`,
      {
        drop_id,
        booster_id,
        boosted_at: Time.currentMillis(),
        wave_id
      },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteDropBoost(
    { drop_id, booster_id }: { drop_id: string; booster_id: string },
    ctx: RequestContext
  ) {
    await this.db.execute(
      `delete from ${DROP_BOOSTS_TABLE} where drop_id = :drop_id and booster_id = :booster_id`,
      { drop_id, booster_id },
      { wrappedConnection: ctx.connection }
    );
  }

  async getDropBoosts(
    {
      drop_id,
      order_by,
      order,
      limit,
      offset
    }: {
      drop_id: string;
      order_by: 'boosted_at';
      order: 'ASC' | 'DESC';
      limit: number;
      offset: number;
    },
    ctx: RequestContext
  ): Promise<DropBoostEntity[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getDropBoosts`);
      return await this.db.execute<DropBoostEntity>(
        `select * from ${DROP_BOOSTS_TABLE} where drop_id = :drop_id order by ${order_by} ${order} limit :limit offset :offset`,
        {
          drop_id,
          order_by,
          order,
          limit,
          offset
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getDropBoosts`);
    }
  }

  async countDropBoosts(
    {
      drop_id
    }: {
      drop_id: string;
    },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->countDropBoosts`);
      const res = await this.db.oneOrNull<{ cnt: number }>(
        `select count(*) as cnt from ${DROP_BOOSTS_TABLE} where drop_id = :drop_id`,
        {
          drop_id
        },
        { wrappedConnection: ctx.connection }
      );
      return res?.cnt ?? 0;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countDropBoosts`);
    }
  }

  async updateHideLinkPreview(
    {
      drop_id,
      hide_link_preview
    }: {
      drop_id: string;
      hide_link_preview: boolean;
    },
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->updateHideLinkPreview`);
    await this.db.execute(
      `update ${DROPS_TABLE} set hide_link_preview = :hide_link_preview where id = :drop_id`,
      { drop_id, hide_link_preview },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->updateHideLinkPreview`);
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
  credit_limit: number;
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
  REALTIME_VOTE = 'REALTIME_VOTE',
  MY_REALTIME_VOTE = 'MY_REALTIME_VOTE',
  CREATED_AT = 'CREATED_AT',
  RATING_PREDICTION = 'RATING_PREDICTION',
  TREND = 'TREND'
}

export interface LeaderboardParams {
  readonly wave_id: string;
  readonly page_size: number;
  readonly page: number;
  readonly sort_direction: PageSortDirection;
  readonly sort: LeaderboardSort;
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

export type DropWithMediaAndPart = DropEntity & {
  part_drop_part_id: number | null;
  part_content: string | null;
  part_quoted_drop_id: string | null;
  medias_json: string | null;
};

export const dropsDb = new DropsDb(dbSupplier);
