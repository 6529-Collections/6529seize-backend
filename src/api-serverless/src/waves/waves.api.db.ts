import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../../../sql-executor';
import { WaveEntity } from '../../../entities/IWave';
import { randomUUID } from 'crypto';
import { Time } from '../../../time';
import { WAVES_TABLE } from '../../../constants';
import {
  communityMemberCriteriaService,
  CommunityMemberCriteriaService
} from '../community-members/community-member-criteria.service';

export class WavesApiDb extends LazyDbAccessCompatibleService {
  constructor(
    supplyDb: () => SqlExecutor,
    private readonly criteriaService: CommunityMemberCriteriaService
  ) {
    super(supplyDb);
  }

  public async findWaveById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<WaveEntity | null> {
    return this.db
      .execute<WaveEntity>(
        `SELECT * FROM waves WHERE id = :id`,
        { id },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) => it[0] ?? null);
  }

  public async insertWave(
    wave: NewWaveEntity,
    connection: ConnectionWrapper<any>
  ): Promise<string> {
    const id = randomUUID();
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
            description,
            created_at,
            created_by,
            voting_scope_type,
            voting_scope_curation_id,
            voting_credit_type,
            voting_credit_scope_type,
            voting_credit_category,
            voting_credit_creditor,
            voting_signature_required,
            voting_period_start,
            voting_period_end,
            visibility_scope_type,
            visibility_scope_curation_id,
            participation_scope_type,
            participation_scope_curation_id,
            participation_max_applications_per_participant,
            participation_required_metadata,
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
            :description,
            :created_at,
            :created_by,
            :voting_scope_type,
            :voting_scope_curation_id,
            :voting_credit_type,
            :voting_credit_scope_type,
            :voting_credit_category,
            :voting_credit_creditor,
            :voting_signature_required,
            :voting_period_start,
            :voting_period_end,
            :visibility_scope_type,
            :visibility_scope_curation_id,
            :participation_scope_type,
            :participation_scope_curation_id,
            :participation_max_applications_per_participant,
            :participation_required_metadata,
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
      params,
      { wrappedConnection: connection }
    );
    return id;
  }

  async searchWaves(searchParams: SearchWavesParams): Promise<WaveEntity[]> {
    const sqlAndParams = await this.criteriaService.getSqlAndParamsByCriteriaId(
      searchParams.curation_criteria_id ?? null
    );
    if (!sqlAndParams) {
      return [];
    }
    const serialNoLessThan =
      searchParams.serial_no_less_than ?? Number.MAX_SAFE_INTEGER;
    const sql = `${sqlAndParams.sql} select w.* from ${WAVES_TABLE} w
         join ${CommunityMemberCriteriaService.GENERATED_VIEW} cm on cm.profile_id = w.created_by
         where w.serial_no < :serialNoLessThan order by w.serial_no desc limit ${searchParams.limit}`;
    const params: Record<string, any> = {
      ...sqlAndParams.params,
      serialNoLessThan
    };
    return this.db.execute(sql, params);
  }
}

export type NewWaveEntity = Omit<WaveEntity, 'id' | 'serial_no' | 'created_at'>;

export interface SearchWavesParams {
  readonly limit: number;
  readonly serial_no_less_than?: number;
  readonly curation_criteria_id?: string;
}

export const wavesApiDb = new WavesApiDb(
  dbSupplier,
  communityMemberCriteriaService
);
