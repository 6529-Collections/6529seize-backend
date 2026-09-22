import type { WaveBaseType } from '@/entities/IWave';

const waveGroupFields = [
  'visibility_group_id',
  'admin_group_id',
  'chat_group_id',
  'participation_group_id',
  'voting_group_id'
] as const;

export function waveGroupIds(
  wave: Pick<WaveBaseType, (typeof waveGroupFields)[number]>
): string[] {
  return Array.from(
    new Set(
      waveGroupFields.flatMap((field) => (wave[field] ? [wave[field]] : []))
    )
  );
}
