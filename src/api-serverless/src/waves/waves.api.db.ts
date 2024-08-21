import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../../../sql-executor';
import { WaveEntity } from '../../../entities/IWave';
import { Time } from '../../../time';
import {
  DROPS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  RATINGS_TABLE,
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
        Omit<WaveEntity, 'participation_required_media'> & {
          participation_required_media: string;
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
        Omit<WaveEntity, 'participation_required_media'> & {
          participation_required_media: string;
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
          )
        }))
      );
  }

  public async insertWave(
    id: string,
    wave: NewWaveEntity,
    connection: ConnectionWrapper<any>
  ) {
    const params = {
      ...wave,
      id,
      created_at: Time.currentMillis()
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
            created_by,
            voting_group_id,
            admin_group_id,
            voting_credit_type,
            voting_credit_scope_type,
            voting_credit_category,
            voting_credit_creditor,
            voting_signature_required,
            voting_period_start,
            voting_period_end,
            visibility_group_id,
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
            wave_period_start,
            wave_period_end,
            outcomes
        )
    values
        (
            :id,
            :name,
            :picture,
            :description_drop_id,
            :created_at,
            :created_by,
            :voting_group_id,
            :admin_group_id,
            :voting_credit_type,
            :voting_credit_scope_type,
            :voting_credit_category,
            :voting_credit_creditor,
            :voting_signature_required,
            :voting_period_start,
            :voting_period_end,
            :visibility_group_id,
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
            :wave_period_start,
            :wave_period_end,
            :outcomes
        )
    `,
      {
        ...params,
        participation_required_media: JSON.stringify(
          params.participation_required_media
        )
      },
      { wrappedConnection: connection }
    );
  }

  async searchWaves(
    searchParams: SearchWavesParams,
    groupsUserIsEligibleFor: string[]
  ): Promise<WaveEntity[]> {
    if (
      searchParams.group_id &&
      !groupsUserIsEligibleFor.includes(searchParams.group_id)
    ) {
      return [];
    }
    const sqlAndParams = await this.userGroupsService.getSqlAndParamsByGroupId(
      searchParams.group_id ?? null
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
        Omit<WaveEntity, 'participation_required_media'> & {
          participation_required_media: string;
        }
      >(sql, params)
      .then((it) =>
        it.map((wave) => ({
          ...wave,
          participation_required_media: JSON.parse(
            wave.participation_required_media
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
    d.id as drop_id, w.id, w.name, w.picture, w.picture, w.description_drop_id, w.voting_group_id, w.participation_group_id
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
            participation_group_id: wave.participation_group_id
          };
          return acc;
        }, {} as Record<string, WaveOverview>)
      );
  }

  async getWavesContributorsOverviews(
    waveIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<
    Record<string, { contributor_identity: string; contributor_pfp: string }[]>
  > {
    if (waveIds.length === 0) {
      return {};
    }
    return this.db
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
                                    row_number() over (partition by primary_address order by level_raw desc) as rn
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
  }

  async findWaveVisibilityGroupByDropId(
    drop_id: string,
    connection: ConnectionWrapper<any>
  ): Promise<string> {
    return this.db
      .oneOrNull<{
        visibility_group_id: string;
      }>(
        `select w.visibility_group_id from ${DROPS_TABLE} d join ${WAVES_TABLE} w on w.id = d.wave_id where d.id = :drop_id`,
        { drop_id },
        { wrappedConnection: connection }
      )
      .then((it) => it!.visibility_group_id);
  }

  async findLatestWaves(
    eligibleGroups: string[],
    limit: number,
    offset: number
  ): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<WaveEntity, 'participation_required_media'> & {
          participation_required_media: string;
        }
      >(
        `
      select * from ${WAVES_TABLE} where (visibility_group_id is null ${
          eligibleGroups.length
            ? `or visibility_group_id in (:eligibleGroups)`
            : ``
        }) order by serial_no desc, id limit :limit offset :offset
    `,
        { limit, eligibleGroups, offset }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          )
        }))
      );
  }

  async findHighLevelAuthorWaves(
    eligibleGroups: string[],
    limit: number,
    offset: number
  ): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<WaveEntity, 'participation_required_media'> & {
          participation_required_media: string;
        }
      >(
        `
      select w.* from ${WAVES_TABLE} w 
      join ${IDENTITIES_TABLE} i on w.created_by = i.profile_id
      where i.level_raw > :level and (w.visibility_group_id is null ${
        eligibleGroups.length
          ? `or w.visibility_group_id in (:eligibleGroups)`
          : ``
      }) order by w.serial_no desc, w.id limit :limit offset :offset
    `,
        {
          limit,
          eligibleGroups,
          offset,
          level: getLevelComponentsBorderByLevel(50)
        }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          )
        }))
      );
  }

  async findWavesByAuthorsYouHaveRepped(
    eligibleGroups: string[],
    authenticatedUserId: string,
    limit: number,
    offset: number
  ): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<WaveEntity, 'participation_required_media'> & {
          participation_required_media: string;
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
      select wa.* from ${WAVES_TABLE} wa where wa.id in (select id from wids) order by wa.serial_no desc, wa.id
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
          )
        }))
      );
  }

  async findMostSubscribedWaves(
    eligibleGroups: string[],
    limit: number,
    offset: number
  ): Promise<WaveEntity[]> {
    return this.db
      .execute<
        Omit<WaveEntity, 'participation_required_media'> & {
          participation_required_media: string;
        }
      >(
        `
          with subscription_counts as (select target_id as wave_id, count(*) as count
                                       from ${IDENTITY_SUBSCRIPTIONS_TABLE}
                                       where target_type = 'WAVE'
                                       group by target_id)
          select w.*
          from ${WAVES_TABLE} w
                   join subscription_counts sc on sc.wave_id = w.id
          where (w.visibility_group_id is null ${
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
          eligibleGroups
        }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          participation_required_media: JSON.parse(
            it.participation_required_media
          )
        }))
      );
  }

  async findWavesMetricsByWaveIds(
    waveIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, WaveMetricEntity>> {
    if (!waveIds.length) {
      return {};
    }
    return this.db
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
            drops_count: 0
          };
          return acc;
        }, {} as Record<string, WaveMetricEntity>)
      );
  }
}

export type NewWaveEntity = Omit<WaveEntity, 'id' | 'serial_no' | 'created_at'>;

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
}

export const wavesApiDb = new WavesApiDb(dbSupplier, userGroupsService);
