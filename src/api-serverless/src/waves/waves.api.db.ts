import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../../../sql-executor';
import { WaveEntity } from '../../../entities/IWave';
import { Time } from '../../../time';
import { DROPS_TABLE, WAVES_TABLE } from '../../../constants';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';

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
      !groupsUserIsEligibleFor.length ||
      (searchParams.group_id &&
        !groupsUserIsEligibleFor.includes(searchParams.group_id))
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
         join ${UserGroupsService.GENERATED_VIEW} cm on cm.profile_id = w.created_by
         where (w.visibility_group_id in (:groupsUserIsEligibleFor) or w.admin_group_id in (:groupsUserIsEligibleFor) or w.visibility_group_id is null) and w.serial_no < :serialNoLessThan order by w.serial_no desc limit ${searchParams.limit}`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      groupsUserIsEligibleFor,
      serialNoLessThan
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
        d.id as drop_id, w.id, w.name, w.picture, w.picture, w.description_drop_id 
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
            description_drop_id: wave.description_drop_id
          };
          return acc;
        }, {} as Record<string, WaveOverview>)
      );
  }
}

export type NewWaveEntity = Omit<WaveEntity, 'id' | 'serial_no' | 'created_at'>;

export interface SearchWavesParams {
  readonly limit: number;
  readonly serial_no_less_than?: number;
  readonly group_id?: string;
}

export interface WaveOverview {
  readonly id: string;
  readonly name: string;
  readonly picture: string;
  readonly description_drop_id: string;
}

export const wavesApiDb = new WavesApiDb(dbSupplier, userGroupsService);
