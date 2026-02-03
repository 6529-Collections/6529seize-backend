import { Entity, Column, PrimaryColumn } from 'typeorm';
import { COOKIES_CONSENT_TABLE } from '@/constants';

@Entity(COOKIES_CONSENT_TABLE)
export class CookiesConsent {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  ip!: string;

  @Column({ type: 'bigint' })
  accepted_at!: number;
}
