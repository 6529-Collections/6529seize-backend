import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import { PUSH_NOTIFICATION_SETTINGS_TABLE } from '../constants';
import { Time } from '../time';

export const PUSH_NOTIFICATION_TYPES = [
  'identity_subscribed',
  'identity_mentioned',
  'identity_rep',
  'identity_cic',
  'drop_quoted',
  'drop_replied',
  'drop_voted',
  'drop_reacted',
  'drop_boosted',
  'wave_created'
] as const;

export type PushNotificationType = (typeof PUSH_NOTIFICATION_TYPES)[number];

export interface PushNotificationSettingsData {
  identity_subscribed: boolean;
  identity_mentioned: boolean;
  identity_rep: boolean;
  identity_cic: boolean;
  drop_quoted: boolean;
  drop_replied: boolean;
  drop_voted: boolean;
  drop_reacted: boolean;
  drop_boosted: boolean;
  wave_created: boolean;
}

export const DEFAULT_PUSH_NOTIFICATION_SETTINGS: PushNotificationSettingsData =
  {
    identity_subscribed: true,
    identity_mentioned: true,
    identity_rep: true,
    identity_cic: true,
    drop_quoted: true,
    drop_replied: true,
    drop_voted: true,
    drop_reacted: true,
    drop_boosted: true,
    wave_created: true
  };

@Entity(PUSH_NOTIFICATION_SETTINGS_TABLE)
export class PushNotificationSettingsEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  profile_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  device_id!: string;

  @Column({ type: 'boolean', default: true })
  identity_subscribed!: boolean;

  @Column({ type: 'boolean', default: true })
  identity_mentioned!: boolean;

  @Column({ type: 'boolean', default: true })
  identity_rep!: boolean;

  @Column({ type: 'boolean', default: true })
  identity_cic!: boolean;

  @Column({ type: 'boolean', default: true })
  drop_quoted!: boolean;

  @Column({ type: 'boolean', default: true })
  drop_replied!: boolean;

  @Column({ type: 'boolean', default: true })
  drop_voted!: boolean;

  @Column({ type: 'boolean', default: true })
  drop_reacted!: boolean;

  @Column({ type: 'boolean', default: true })
  drop_boosted!: boolean;

  @Column({ type: 'boolean', default: true })
  wave_created!: boolean;

  @CreateDateColumn()
  created_at?: Time;

  @UpdateDateColumn()
  updated_at?: Time;
}
