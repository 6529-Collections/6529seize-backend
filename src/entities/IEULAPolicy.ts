import { Entity, Column, PrimaryColumn } from 'typeorm';
import { EULA_CONSENT_TABLE } from '@/constants';

@Entity(EULA_CONSENT_TABLE)
export class EULAConsent {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  device_id!: string;

  @Column({ type: 'bigint' })
  accepted_at!: number;

  @Column({ type: 'text' })
  platform!: string;
}
