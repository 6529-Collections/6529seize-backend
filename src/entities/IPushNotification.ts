import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import { PUSH_NOTIFICATION_DEVICES_TABLE } from '@/constants';
import { Time } from '../time';

@Index(['profile_id'])
@Entity(PUSH_NOTIFICATION_DEVICES_TABLE)
export class PushNotificationDevice {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  device_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  profile_id!: string;

  @Column({ type: 'text', nullable: false })
  token!: string;

  @Column({ type: 'text', nullable: true })
  platform?: string;

  @CreateDateColumn()
  created_at?: Time;

  @UpdateDateColumn()
  updated_at?: Time;
}
