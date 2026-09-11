import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PUSH_INSTALLATIONS_TABLE } from '@/constants';

/** Installation credential and revocation fence survive removal of every profile. */
@Entity(PUSH_INSTALLATIONS_TABLE)
export class PushInstallationEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  device_id!: string;

  @Column({ type: 'char', length: 64, nullable: true })
  secret_hash!: string | null;

  @Column({ type: 'int', unsigned: true, default: 0 })
  revision!: number;

  @Column({ type: 'text', nullable: true })
  token!: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  platform!: string | null;
}
