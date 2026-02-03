import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import { PUSH_NOTIFICATION_DEVICES_TABLE } from '@/constants';
import { Time } from '../time';

@Entity(PUSH_NOTIFICATION_DEVICES_TABLE)
export class PushNotificationDevice {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  device_id!: string;

  @Column({ type: 'text', nullable: false })
  token!: string;

  @Column({ type: 'text', nullable: true })
  profile_id?: string;

  @Column({ type: 'text', nullable: true })
  platform?: string;

  @CreateDateColumn()
  created_at?: Time;

  @UpdateDateColumn()
  updated_at?: Time;
}
