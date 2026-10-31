import { legacyCompetitionId } from '@/competitions/competition-id';
import {
  COMPETITIONS_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE
} from '@/constants';
import { WaveEntity } from '@/entities/IWave';
import { sqlExecutor, SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';

/** Native fixture configuration for an already transferred original primary.
 * Test setup never enrolls a wave or invokes retired migration machinery. */
export function nativeOriginalPrimaryFixture(wave: WaveEntity) {
  const participation = {
    group_id: wave.participation_group_id,
    signature_required: Boolean(wave.participation_signature_required),
    max_entries_per_participant:
      wave.participation_max_applications_per_participant,
    required_metadata:
      typeof wave.participation_required_metadata === 'string'
        ? JSON.parse(wave.participation_required_metadata)
        : wave.participation_required_metadata,
    required_media:
      typeof wave.participation_required_media === 'string'
        ? JSON.parse(wave.participation_required_media)
        : wave.participation_required_media,
    submission_type: wave.submission_type,
    identity_submission_strategy: wave.identity_submission_strategy,
    identity_submission_duplicates: wave.identity_submission_duplicates,
    starts_at: wave.participation_period_start,
    ends_at: wave.participation_period_end,
    terms: wave.participation_terms
  };
  const voting = {
    group_id: wave.voting_group_id,
    signature_required: Boolean(wave.voting_signature_required),
    credit_type: wave.voting_credit_type,
    credit_scope: wave.voting_credit_scope,
    credit_category: wave.voting_credit_category,
    credit_creditor: wave.voting_credit_creditor,
    credit_nfts: [],
    starts_at: wave.voting_period_start,
    ends_at: wave.voting_period_end,
    max_votes_per_identity_to_entry: wave.max_votes_per_identity_to_drop,
    forbid_negative_votes: Boolean(wave.forbid_negative_votes)
  };
  const winners = {
    max_winners: wave.max_winners,
    winning_min_threshold: wave.winning_min_threshold,
    winning_max_threshold: wave.winning_max_threshold,
    winning_threshold_min_duration_ms: wave.winning_threshold_min_duration_ms
  };
  return {
    id: legacyCompetitionId(wave.id),
    wave_id: wave.id,
    legacy_wave_id: wave.id,
    execution_mode: 'ACTIVE',
    type: wave.type,
    lifecycle: 'PUBLISHED',
    title: wave.name,
    description: null,
    participation_config: participation,
    voting_config: voting,
    decision_config: {
      ...winners,
      strategy: wave.decisions_strategy,
      next_decision_time: wave.next_decision_time,
      time_lock_ms: wave.time_lock_ms
    },
    winner_config: winners,
    outcome_config: [],
    config_version: 1,
    participation_starts_at: wave.participation_period_start,
    participation_ends_at: wave.participation_period_end,
    voting_starts_at: wave.voting_period_start,
    voting_ends_at: wave.voting_period_end,
    created_at: Number(wave.created_at),
    updated_at: Number(wave.updated_at ?? wave.created_at),
    published_at: Number(wave.created_at),
    ended_at: null,
    cancelled_at: null,
    archived_at: null
  };
}

export async function seedNativeOriginalPrimaryFixture(
  wave: WaveEntity,
  ctx: RequestContext = {},
  db: SqlExecutor = sqlExecutor
) {
  const record = nativeOriginalPrimaryFixture(wave);
  const columns = Object.keys(record);
  const params = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : value
    ])
  );
  await db.execute(
    `insert into ${COMPETITIONS_TABLE} (${columns.map((column) => `\`${column}\``).join(',')}) values (${columns.map((column) => `:${column}`).join(',')})`,
    params,
    { wrappedConnection: ctx.connection }
  );
  await db.execute(
    `insert into ${COMPETITION_CONFIG_VERSIONS_TABLE} (competition_id,version,config,created_by,created_at) values (:id,1,:config,:creator,:createdAt)`,
    {
      id: record.id,
      config: JSON.stringify(record),
      creator: wave.created_by,
      createdAt: Number(wave.created_at)
    },
    { wrappedConnection: ctx.connection }
  );
  return record;
}
