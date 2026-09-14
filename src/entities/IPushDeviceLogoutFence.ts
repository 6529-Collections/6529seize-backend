import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE } from '@/constants';

/** A pre-registration logout fences only its own credential, never device ownership. */
@Entity(PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE)
export class PushDeviceLogoutFenceEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  device_id!: string;

  @PrimaryColumn({ type: 'char', length: 64 })
  secret_hash!: string;

  @Column({ type: 'int', unsigned: true })
  revision!: number;
}
