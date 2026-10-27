import { Column, Entity, PrimaryColumn } from 'typeorm';
import {
  DROP_FORGE_SETTINGS_TABLE,
  DROP_FORGE_FUNDING_TABLE
} from '@/constants';

@Entity(DROP_FORGE_SETTINGS_TABLE)
export class DropForgeSettingsEntity {
  @PrimaryColumn({ type: 'varchar', length: 60 }) id!: string;
  @Column({ type: 'int', default: 0 }) revision!: number;
  @Column({ type: 'boolean', default: false }) automation_enabled!: boolean;
  @Column({ type: 'boolean', default: false }) pay_artist_enabled!: boolean;
  @Column({ type: 'varchar', length: 42, nullable: true }) updated_by!:
    | string
    | null;
  @Column({ type: 'bigint', default: 0 }) updated_at!: number;
}

@Entity(DROP_FORGE_FUNDING_TABLE)
export class DropForgeFundingEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 }) id!: string;
  @Column({ type: 'varchar', length: 66 }) hash!: string;
  @Column({ type: 'varchar', length: 42 }) sender!: string;
  @Column({ type: 'varchar', length: 42 }) recipient!: string;
  @Column({ type: 'varchar', length: 80 }) amount_wei!: string;
  @Column({ type: 'bigint' }) created_at!: number;
  @Column({ type: 'json', nullable: true }) attempts!: Array<{
    hash: string;
    amount_wei: string;
    cancelled: boolean;
    replaced?: boolean;
  }> | null;
  @Column({ type: 'varchar', length: 36, nullable: true }) drop_id!:
    | string
    | null;
}
