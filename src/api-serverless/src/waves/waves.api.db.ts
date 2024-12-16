import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../../../sql-executor';
import { WaveCreditType, WaveEntity } from '../../../entities/IWave';
import {
  ACTIVITY_EVENTS_TABLE,
  CLAP_CREDIT_SPENDINGS_TABLE,
  DROP_CLAPPER_STATE_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROP_RELATIONS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  RATINGS_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_TABLE
} from '../../../constants';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { getLevelComponentsBorderByLevel } from '../../../profiles/profile-level';
import { RateMatter } from '../../../entities/IRating';
import { WaveMetricEntity } from '../../../entities/IWaveMetric';
import { RequestContext } from '../../../request.context';
import { ActivityEventTargetType } from '../../../entities/IActivityEvent';
import { WaveDropperMetricEntity } from '../../../entities/IWaveDropperMetric';
import { DropType } from '../../../entities/IDrop';

export class WavesApiDb extends LazyDbAccessCompatibleService {
  constructor(
    supplyDb: () => SqlExecutor,
    private readonly userGroupsService: UserGroupsService
  ) {
    super(supplyDb);
  }

  public async findWaveById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<WaveEntity | null> {
    return this.db
      .oneOrNull<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `SELECT * FROM ${WAVES_TABLE} WHERE id = :id`,
        { id },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) =>
        it
          ? {
              ...it,
              participation_required_media: JSON.parse(
                it.participation_required_media
              ),
              participation_required_metadata: JSON.parse(
                it.participation_required_metadata
              )
            }
          : null
      );
  }

  public async findWavesByIds(
    ids: string[],
    groupIdsUserIsEligibleFor: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<WaveEntity[]> {
    if (!ids.length) {
      return [];
    }
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `SELECT * FROM ${WAVES_TABLE} WHERE id in (:ids) and (visibility_group_id is null ${
          groupIdsUserIsEligibleFor.length
            ? `or visibility_group_id in (:groupIdsUserIsEligibleFor)`
            : ``
        })`,
        { ids, groupIdsUserIsEligibleFor },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          )
        }))
      );
  }

  public async findWavesByIdsWithoutEligibilityCheck(
    ids: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, WaveEntity>> {
    if (!ids.length) {
      return {};
    }
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `SELECT * FROM ${WAVES_TABLE} WHERE id in (:ids)`,
        { ids },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((res) =>
        res
          .map((it) => ({
            ...it,
            participation_required_media: JSON.parse(
              it.participation_required_media
            ),
            participation_required_metadata: JSON.parse(
              it.participation_required_metadata
            )
          }))
          .reduce((acc, wave) => {
            acc[wave.id] = wave;
            return acc;
          }, {} as Record<string, WaveEntity>)
      );
  }

  public async insertWave(wave: InsertWaveEntity, ctx: RequestContext) {
    const timer = ctx.timer!;
    timer.start('waveApiDb->insertWave');
    const params = {
      ...wave,
      participation_required_media: JSON.stringify(
        wave.participation_required_media
      ),
      participation_required_metadata: JSON.stringify(
        wave.participation_required_metadata
      )
    };
    await this.db.execute(
      `
    insert into ${WAVES_TABLE} 
        (
            id,
            name,
            picture,
            description_drop_id,
            created_at,
            updated_at,
            created_by,
            voting_group_id,
            admin_group_id,
            voting_credit_type,
            voting_credit_category,
            voting_credit_creditor,
            voting_signature_required,
            voting_period_start,
            voting_period_end,
            visibility_group_id,
            chat_group_id,
            chat_enabled,
            participation_group_id,
            participation_max_applications_per_participant,
            participation_required_metadata,
            participation_required_media,
            participation_period_start,
            participation_period_end,
            type,
            winning_min_threshold,
            winning_max_threshold,
            max_winners,
            time_lock_ms,
            outcomes${wave.serial_no !== null ? ', serial_no' : ''}
        )
    values
        (
            :id,
            :name,
            :picture,
            :description_drop_id,
            :created_at,
            :updated_at,
            :created_by,
            :voting_group_id,
            :admin_group_id,
            :voting_credit_type,
            :voting_credit_category,
            :voting_credit_creditor,
            :voting_signature_required,
            :voting_period_start,
            :voting_period_end,
            :visibility_group_id,
            :chat_group_id,
            :chat_enabled,
            :participation_group_id,
            :participation_max_applications_per_participant,
            :participation_required_metadata,
            :participation_required_media,
            :participation_period_start,
            :participation_period_end,
            :type,
            :winning_min_threshold,
            :winning_max_threshold,
            :max_winners,
            :time_lock_ms,
            :outcomes${wave.serial_no !== null ? ', :serial_no' : ''}
        )
    `,
      params,
      { wrappedConnection: ctx.connection }
    );
    timer.stop('waveApiDb->insertWave');
  }

  async searchWaves(
    searchParams: SearchWavesParams,
    groupsUserIsEligibleFor: string[],
    ctx: RequestContext
  ): Promise<WaveEntity[]> {
    if (
      searchParams.group_id &&
      !groupsUserIsEligibleFor.includes(searchParams.group_id)
    ) {
      return [];
    }
    const sqlAndParams = await this.userGroupsService.getSqlAndParamsByGroupId(
      searchParams.group_id ?? null,
      ctx
    );
    if (!sqlAndParams) {
      return [];
    }
    const serialNoLessThan =
      searchParams.serial_no_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `${sqlAndParams.sql} select w.* from ${WAVES_TABLE} w
         join ${
           UserGroupsService.GENERATED_VIEW
         } cm on cm.profile_id = w.created_by
         where ${searchParams.author ? ` w.created_by = :author and ` : ``} ${
      searchParams.name ? ` w.name like :name and ` : ``
    } (${
      groupsUserIsEligibleFor.length
        ? `w.visibility_group_id in (:groupsUserIsEligibleFor) or w.admin_group_id in (:groupsUserIsEligibleFor) or`
        : ``
    } w.visibility_group_id is null) and w.serial_no < :serialNoLessThan order by w.serial_no desc limit ${
      searchParams.limit
    }`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      groupsUserIsEligibleFor,
      serialNoLessThan,
      name: searchParams.name ? `%${searchParams.name}%` : undefined,
      author: searchParams.author
    };
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(sql, params)
      .then((it) =>
        it.map((wave) => ({
          ...wave,
          participation_required_media: JSON.parse(
            wave.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            wave.participation_required_metadata
          )
        }))
      );
  }

  async getWaveOverviewsByDropIds(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, WaveOverview>> {
    if (dropIds.length === 0) {
      return {};
    }
    return this.db
      .execute<WaveOverview & { drop_id: string }>(
        `select 
    d.id as drop_id, w.id, w.name, w.picture, w.picture, w.description_drop_id, w.voting_group_id, w.participation_group_id, w.chat_group_id, w.chat_enabled, w.voting_credit_type
    from ${DROPS_TABLE} d join ${WAVES_TABLE} w on w.id = d.wave_id where d.id in (:dropIds)`,
        {
          dropIds
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) =>
        it.reduce<Record<string, WaveOverview>>((acc, wave) => {
          acc[wave.drop_id] = {
            id: wave.id,
            name: wave.name,
            picture: wave.picture,
            description_drop_id: wave.description_drop_id,
            voting_group_id: wave.voting_group_id,
            participation_group_id: wave.participation_group_id,
            chat_group_id: wave.chat_group_id,
            chat_enabled: wave.chat_enabled,
            voting_credit_type: wave.voting_credit_type
          };
          return acc;
        }, {} as Record<string, WaveOverview>)
      );
  }

  async getWavesContributorsOverviews(
    waveIds: string[],
    { connection, timer }: RequestContext
  ): Promise<
    Record<string, { contributor_identity: string; contributor_pfp: string }[]>
  > {
    if (waveIds.length === 0) {
      return {};
    }
    timer?.start('wavesApiDb->getWavesContributorsOverviews');
    const result = await this.db
      .execute<{
        wave_id: string;
        contributor_identity: string;
        contributor_pfp: string;
      }>(
        `with contributors as (select distinct d.wave_id,
                                      i.pfp as contributor_pfp,
                                      i.primary_address,
                                      i.level_raw
                      from ${DROPS_TABLE} d
                               join ${IDENTITIES_TABLE} i on d.author_id = i.profile_id
                      where i.pfp is not null
                        and d.wave_id in (:waveIds)
                      order by 4 desc),
    ranked_contributors as (select wave_id,
                                    contributor_pfp,
                                    primary_address,
                                    row_number() over (partition by wave_id, primary_address order by level_raw desc) as rn
                            from contributors)
select wave_id, contributor_pfp, primary_address as contributor_identity from ranked_contributors where rn <= 5`,
        {
          waveIds
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) =>
        it.reduce<
          Record<
            string,
            { contributor_identity: string; contributor_pfp: string }[]
          >
        >((acc, wave) => {
          if (!acc[wave.wave_id]) {
            acc[wave.wave_id] = [];
          }
          acc[wave.wave_id].push({
            contributor_identity: wave.contributor_identity,
            contributor_pfp: wave.contributor_pfp
          });
          return acc;
        }, {} as Record<string, { contributor_identity: string; contributor_pfp: string }[]>)
      );
    timer?.stop('wavesApiDb->getWavesContributorsOverviews');
    return result;
  }

  async findLatestWaves({
    only_waves_followed_by_authenticated_user,
    authenticated_user_id,
    eligibleGroups,
    limit,
    offset
  }: {
    authenticated_user_id: string | null;
    only_waves_followed_by_authenticated_user: boolean;
    eligibleGroups: string[];
    limit: number;
    offset: number;
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `
      select w.* from ${WAVES_TABLE} w
       ${
         only_waves_followed_by_authenticated_user
           ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = w.id`
           : ``
       } where ${
          only_waves_followed_by_authenticated_user
            ? `f.subscriber_id = :authenticated_user_id and`
            : ``
        } (w.visibility_group_id is null ${
          eligibleGroups.length
            ? `or w.visibility_group_id in (:eligibleGroups)`
            : ``
        }) order by w.serial_no desc, w.id limit :limit offset :offset
    `,
        { limit, eligibleGroups, offset, authenticated_user_id }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          )
        }))
      );
  }

  async findHighLevelAuthorWaves({
    only_waves_followed_by_authenticated_user,
    authenticated_user_id,
    eligibleGroups,
    limit,
    offset
  }: {
    only_waves_followed_by_authenticated_user: boolean;
    authenticated_user_id: string | null;
    eligibleGroups: string[];
    limit: number;
    offset: number;
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `
      select w.* from ${WAVES_TABLE} w 
      ${
        only_waves_followed_by_authenticated_user
          ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = w.id`
          : ``
      }
      join ${IDENTITIES_TABLE} i on w.created_by = i.profile_id
      where
        ${
          only_waves_followed_by_authenticated_user
            ? `f.subscriber_id = :authenticated_user_id and`
            : ``
        } 
       i.level_raw > :level and (w.visibility_group_id is null ${
         eligibleGroups.length
           ? `or w.visibility_group_id in (:eligibleGroups)`
           : ``
       }) order by w.serial_no desc, w.id limit :limit offset :offset
    `,
        {
          limit,
          eligibleGroups,
          offset,
          authenticated_user_id,
          level: getLevelComponentsBorderByLevel(50)
        }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          )
        }))
      );
  }

  async findWavesByAuthorsYouHaveRepped({
    eligibleGroups,
    authenticatedUserId,
    only_waves_followed_by_authenticated_user,
    limit,
    offset
  }: {
    eligibleGroups: string[];
    authenticatedUserId: string;
    only_waves_followed_by_authenticated_user: boolean;
    limit: number;
    offset: number;
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `
  with reps as (select matter_target_id as profile_id from ${RATINGS_TABLE} where rater_profile_id = :authenticatedUserId and matter = '${
          RateMatter.REP
        }' and rating <> 0),
  wids as (
      select distinct w.id from ${WAVES_TABLE} w
                                    join reps r on w.created_by = r.profile_id
      where (w.visibility_group_id is null ${
        eligibleGroups.length
          ? `or w.visibility_group_id in (:eligibleGroups)`
          : ``
      }) order by w.serial_no desc, w.id limit :limit offset :offset
  )
      select wa.* from ${WAVES_TABLE} wa
      ${
        only_waves_followed_by_authenticated_user
          ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = wa.id`
          : ``
      }
  where
      ${
        only_waves_followed_by_authenticated_user
          ? `f.subscriber_id = :authenticatedUserId and`
          : ``
      } wa.id in (select id from wids) order by wa.serial_no desc, wa.id
`,
        {
          limit,
          eligibleGroups,
          offset,
          authenticatedUserId
        }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          )
        }))
      );
  }

  async findMostSubscribedWaves({
    only_waves_followed_by_authenticated_user,
    authenticated_user_id,
    eligibleGroups,
    limit,
    offset
  }: {
    only_waves_followed_by_authenticated_user: boolean;
    authenticated_user_id: string | null;
    eligibleGroups: string[];
    limit: number;
    offset: number;
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `
          with subscription_counts as (select target_id as wave_id, count(*) as count
                                       from ${IDENTITY_SUBSCRIPTIONS_TABLE}
                                       where target_type = 'WAVE'
                                       group by target_id)
          select w.*
          from ${WAVES_TABLE} w
              ${
                only_waves_followed_by_authenticated_user
                  ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = w.id`
                  : ``
              }
                   join subscription_counts sc on sc.wave_id = w.id
          where
              ${
                only_waves_followed_by_authenticated_user
                  ? `f.subscriber_id = :authenticated_user_id and`
                  : ``
              }  (w.visibility_group_id is null ${
          eligibleGroups.length
            ? `or w.visibility_group_id in (:eligibleGroups)`
            : ``
        })
          order by sc.count desc, w.id desc
          limit :limit offset :offset
      `,
        {
          limit,
          offset,
          eligibleGroups,
          authenticated_user_id
        }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          )
        }))
      );
  }

  async findWavesMetricsByWaveIds(
    waveIds: string[],
    { connection, timer }: RequestContext
  ): Promise<Record<string, WaveMetricEntity>> {
    if (!waveIds.length) {
      return {};
    }
    timer?.start('wavesApiDb->findWavesMetricsByWaveIds');
    const result = await this.db
      .execute<WaveMetricEntity>(
        `select * from ${WAVE_METRICS_TABLE} where wave_id in (:waveIds)`,
        { waveIds },
        { wrappedConnection: connection }
      )
      .then((results) =>
        waveIds.reduce((acc, waveId) => {
          acc[waveId] = results.find((it) => it.wave_id === waveId) ?? {
            wave_id: waveId,
            subscribers_count: 0,
            drops_count: 0,
            participatory_drops_count: 0,
            latest_drop_timestamp: 0
          };
          return acc;
        }, {} as Record<string, WaveMetricEntity>)
      );
    timer?.stop('wavesApiDb->findWavesMetricsByWaveIds');
    return result;
  }

  async findWaveDropperMetricsByWaveIds(
    params: { dropperId: string; waveIds: string[] },
    { connection, timer }: RequestContext
  ): Promise<Record<string, WaveDropperMetricEntity>> {
    if (!params.waveIds.length) {
      return {};
    }
    timer?.start('wavesApiDb->findWaveDropperMetricsByWaveIds');
    const result = await this.db
      .execute<WaveDropperMetricEntity>(
        `select * from ${WAVE_DROPPER_METRICS_TABLE} where wave_id in (:waveIds) and dropper_id = :dropperId`,
        params,
        { wrappedConnection: connection }
      )
      .then((results) =>
        params.waveIds.reduce((acc, waveId) => {
          acc[waveId] = results.find((it) => it.wave_id === waveId) ?? {
            wave_id: waveId,
            dropper_id: params.dropperId,
            drops_count: 0,
            participatory_drops_count: 0,
            latest_drop_timestamp: 0
          };
          return acc;
        }, {} as Record<string, WaveDropperMetricEntity>)
      );
    timer?.stop('wavesApiDb->findWaveDropperMetricsByWaveIds');
    return result;
  }

  async findById(
    wave_id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<WaveEntity | null> {
    return this.db
      .oneOrNull<WaveEntity>(
        `
        select * from ${WAVES_TABLE} where id = :wave_id`,
        { wave_id },
        { wrappedConnection: connection }
      )
      .then((it) =>
        it
          ? {
              ...it,
              participation_required_media: JSON.parse(
                it.participation_required_media as any
              ),
              participation_required_metadata: JSON.parse(
                it.participation_required_metadata as any
              )
            }
          : null
      );
  }

  async deleteWave(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteWave');
    await this.db.execute(
      `delete from ${WAVES_TABLE} where id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteWave');
  }

  async deleteWaveMetrics(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteWaveMetrics');
    await this.db.execute(
      `delete from ${WAVE_METRICS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteWaveMetrics');
  }

  async deleteDropPartsByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropPartsByWaveId');
    await this.db.execute(
      `delete from ${DROPS_PARTS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropPartsByWaveId');
  }

  async deleteDropMentionsByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropMentionsByWaveId');
    await this.db.execute(
      `delete from ${DROPS_MENTIONS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropMentionsByWaveId');
  }

  public async deleteDropMediaByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropMediaByWaveId');
    await this.db.execute(
      `delete from ${DROP_MEDIA_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropMediaByWaveId');
  }

  public async deleteDropReferencedNftsByWaveId(
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->deleteDropReferencedNftsByWaveId');
    await this.db.execute(
      `delete from ${DROP_REFERENCED_NFTS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropReferencedNftsByWaveId');
  }

  public async deleteDropMetadataByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropMetadataByWaveId');
    await this.db.execute(
      `delete from ${DROP_METADATA_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropMetadataByWaveId');
  }

  public async deleteDropNotificationsByWaveId(
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->deleteDropNotificationsByWaveId');
    await this.db.execute(
      `delete from ${IDENTITY_NOTIFICATIONS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropNotificationsByWaveId');
  }

  public async deleteDropFeedItemsByWaveId(
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->deleteDropFeedItemsByWaveId');
    await this.db.execute(
      `delete from ${ACTIVITY_EVENTS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropFeedItemsByWaveId');
  }

  public async deleteDropSubscriptionsByWaveId(
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->deleteDropSubscriptionsByWaveId');
    await this.db.execute(
      `delete from ${IDENTITY_SUBSCRIPTIONS_TABLE} where wave_id = :waveId`,
      { waveId, targetType: ActivityEventTargetType.DROP },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropSubscriptionsByWaveId');
  }

  public async deleteDropEntitiesByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropEntitiesByWaveId');
    await this.db.execute(
      `delete from ${DROPS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropEntitiesByWaveId');
  }

  async deleteDropClapsByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropClapsByWaveId');
    await this.db.execute(
      `delete from ${DROP_CLAPPER_STATE_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropClapsByWaveId');
  }

  async deleteClapCreditSpendingsByWaveId(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteClapCreditSpendingsByWaveId');
    await this.db.execute(
      `delete from ${CLAP_CREDIT_SPENDINGS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteClapCreditSpendingsByWaveId');
  }

  async updateVisibilityInFeedEntities(
    param: {
      waveId: string;
      newVisibilityGroupId: string | null;
    },
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->updateVisibilityInFeedEntities');
    await this.db.execute(
      `update ${ACTIVITY_EVENTS_TABLE} set visibility_group_id = :newVisibilityGroupId where wave_id = :waveId`,
      param,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->updateVisibilityInFeedEntities');
  }

  async updateVisibilityInNotifications(
    param: { waveId: string; newVisibilityGroupId: string | null },
    ctx: RequestContext
  ) {
    ctx.timer?.start('wavesApiDb->updateVisibilityInNotifications');
    await this.db.execute(
      `update ${IDENTITY_NOTIFICATIONS_TABLE} set visibility_group_id = :newVisibilityGroupId where wave_id = :waveId`,
      param,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->updateVisibilityInNotifications');
  }

  async deleteDropRelations(waveId: string, ctx: RequestContext) {
    ctx.timer?.start('wavesApiDb->deleteDropRelations');
    await this.db.execute(
      `delete from ${DROP_RELATIONS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('wavesApiDb->deleteDropRelations');
  }

  async updateDescriptionDropId(
    param: {
      newDescriptionDropId: string;
      waveId: string;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${WAVES_TABLE} set description_drop_id = :newDescriptionDropId where id = :waveId`,
      param,
      { wrappedConnection: connection }
    );
  }

  async findMostDroppedWaves({
    eligibleGroups,
    authenticated_user_id,
    only_waves_followed_by_authenticated_user,
    limit,
    offset
  }: {
    eligibleGroups: string[];
    authenticated_user_id: string | null;
    limit: number;
    only_waves_followed_by_authenticated_user: boolean;
    offset: number;
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `select w.* from ${WAVES_TABLE} w
         ${
           only_waves_followed_by_authenticated_user
             ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = w.id`
             : ``
         }
         join ${WAVE_METRICS_TABLE} wm on wm.wave_id = w.id 
          where
        ${
          only_waves_followed_by_authenticated_user
            ? `f.subscriber_id = :authenticated_user_id and`
            : ``
        }  
           (w.visibility_group_id is null ${
             eligibleGroups.length
               ? `or w.visibility_group_id in (:eligibleGroups)`
               : ``
           }) order by wm.drops_count desc limit :limit offset :offset`,
        { limit, eligibleGroups, offset, authenticated_user_id }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          )
        }))
      );
  }

  async findRecentlyDroppedToWaves(param: {
    authenticated_user_id: string | null;
    only_waves_followed_by_authenticated_user: boolean;
    offset: number;
    limit: number;
    eligibleGroups: string[];
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `select w.* from ${WAVES_TABLE} w 
        ${
          param.only_waves_followed_by_authenticated_user
            ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = w.id`
            : ``
        }
        join ${WAVE_METRICS_TABLE} wm on wm.wave_id = w.id 
         where
        ${
          param.only_waves_followed_by_authenticated_user
            ? `f.subscriber_id = :authenticated_user_id and`
            : ``
        }
         (w.visibility_group_id is null ${
           param.eligibleGroups.length
             ? `or w.visibility_group_id in (:eligibleGroups)`
             : ``
         }) order by wm.latest_drop_timestamp desc limit :limit offset :offset`,
        param
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          )
        }))
      );
  }

  async findRecentlyDroppedToWavesByYou(param: {
    only_waves_followed_by_authenticated_user: boolean;
    authenticated_user_id: string | null;
    dropperId: string;
    offset: number;
    limit: number;
    eligibleGroups: string[];
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `select w.* from ${WAVES_TABLE} w
         ${
           param.only_waves_followed_by_authenticated_user
             ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = w.id`
             : ``
         }
         join ${WAVE_DROPPER_METRICS_TABLE} wm on wm.wave_id = w.id 
          where
        ${
          param.only_waves_followed_by_authenticated_user
            ? `f.subscriber_id = :authenticated_user_id and`
            : ``
        }
          wm.dropper_id = :dropperId and (w.visibility_group_id is null ${
            param.eligibleGroups.length
              ? `or w.visibility_group_id in (:eligibleGroups)`
              : ``
          }) order by wm.latest_drop_timestamp desc limit :limit offset :offset`,
        param
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          )
        }))
      );
  }

  async findMostDroppedWavesByYou(param: {
    dropperId: string;
    authenticated_user_id: string | null;
    only_waves_followed_by_authenticated_user: boolean;
    offset: number;
    limit: number;
    eligibleGroups: string[];
  }): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<
          WaveEntity,
          'participation_required_media' | 'participation_required_metadata'
        > & {
          participation_required_media: string;
          participation_required_metadata: string;
        }
      >(
        `select w.* from ${WAVES_TABLE} w
         ${
           param.only_waves_followed_by_authenticated_user
             ? `join ${IDENTITY_SUBSCRIPTIONS_TABLE} f on f.target_type = 'WAVE' and f.target_action = 'DROP_CREATED' and f.target_id = w.id`
             : ``
         }
         join ${WAVE_DROPPER_METRICS_TABLE} wm on wm.wave_id = w.id 
          where
        ${
          param.only_waves_followed_by_authenticated_user
            ? `f.subscriber_id = :authenticated_user_id and`
            : ``
        }
          wm.dropper_id = :dropperId and (w.visibility_group_id is null ${
            param.eligibleGroups.length
              ? `or w.visibility_group_id in (:eligibleGroups)`
              : ``
          }) order by wm.drops_count desc limit :limit offset :offset`,
        param
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          ),
          participation_required_metadata: JSON.parse(
            it.participation_required_metadata
          )
        }))
      );
  }

  async findIdentityParticipationDropsCountByWaveId(
    param: {
      identityId: string;
      waveIds: string[];
    },
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!param.waveIds.length) {
      return {};
    }
    ctx.timer?.start(
      `${this.constructor.name}->findIdentityParticipationDropsCountByWaveId`
    );
    const dbresult = await this.db.execute<{ wave_id: string; cnt: number }>(
      `select d.wave_id as wave_id, count(d.id) as cnt from ${DROPS_TABLE} d where d.wave_id in (:waveIds) and d.author_id = :identityId and d.drop_type = '${DropType.PARTICIPATORY}' group by 1`,
      param,
      { wrappedConnection: ctx.connection }
    );
    const result = dbresult.reduce(
      (acc, red) => ({ ...acc, [red.wave_id]: red.cnt }),
      {} as Record<string, number>
    );
    ctx.timer?.stop(
      `${this.constructor.name}->findIdentityParticipationDropsCountByWaveId`
    );
    return result;
  }
}

export interface InsertWaveEntity extends Omit<WaveEntity, 'serial_no'> {
  readonly serial_no: number | null;
}

export interface SearchWavesParams {
  readonly author?: string;
  readonly name?: string;
  readonly limit: number;
  readonly serial_no_less_than?: number;
  readonly group_id?: string;
}

export interface WaveOverview {
  readonly id: string;
  readonly name: string;
  readonly picture: string;
  readonly description_drop_id: string;
  readonly voting_group_id: string | null;
  readonly participation_group_id: string | null;
  readonly chat_group_id: string | null;
  readonly chat_enabled: boolean;
  readonly voting_credit_type: WaveCreditType;
}

export const wavesApiDb = new WavesApiDb(dbSupplier, userGroupsService);
