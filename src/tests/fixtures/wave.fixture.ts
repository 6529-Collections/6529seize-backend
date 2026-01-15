import { WaveCreditType, WaveEntity, WaveType } from '../../entities/IWave';
import { Time } from '../../time';
import { randomUUID } from 'node:crypto';
import { Seed } from '../_setup/seed';
import { WAVES_TABLE } from '../../constants';

type BaseWave = Omit<WaveEntity, 'serial_no' | 'id' | 'name'>;
const aBaseWave: BaseWave = {
  next_decision_time: null,
  created_at: Time.millis(0).toMillis(),
  updated_at: Time.millis(0).toMillis(),
  chat_enabled: true,
  description_drop_id: 'dd1',
  picture: null,
  created_by: randomUUID(),
  voting_group_id: null,
  admin_group_id: null,
  voting_credit_type: WaveCreditType.TDH,
  voting_credit_category: null,
  voting_credit_creditor: null,
  voting_signature_required: false,
  voting_period_start: null,
  voting_period_end: null,
  visibility_group_id: null,
  participation_group_id: null,
  chat_group_id: null,
  participation_max_applications_per_participant: null,
  participation_required_metadata: [],
  participation_required_media: [],
  participation_period_start: null,
  participation_period_end: null,
  type: WaveType.CHAT,
  winning_min_threshold: null,
  winning_max_threshold: null,
  max_winners: null,
  time_lock_ms: null,
  decisions_strategy: null,
  participation_signature_required: false,
  participation_terms: null,
  admin_drop_deletion_enabled: false,
  forbid_negative_votes: false,
  is_direct_message: false
};

export function aWave(
  waveProps: Partial<BaseWave>,
  waveKey?: {
    id: string;
    serial_no?: number;
    name: string;
  }
): WaveEntity {
  const key = waveKey ?? {
    id: randomUUID(),
    name: randomUUID()
  };
  return {
    ...aBaseWave,
    ...key,
    ...waveProps,
    participation_required_media: JSON.stringify(
      waveProps.participation_required_media ??
        aBaseWave.participation_required_media
    ) as any,
    participation_required_metadata: JSON.stringify(
      waveProps.participation_required_metadata ??
        aBaseWave.participation_required_metadata
    ) as any,
    serial_no: key?.serial_no as any
  };
}

export function withWaves(entities: WaveEntity[]): Seed {
  return {
    table: WAVES_TABLE,
    rows: entities
  };
}
