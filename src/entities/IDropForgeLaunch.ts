import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  DROP_FORGE_LAUNCHES_TABLE,
  DROP_FORGE_SIGNERS_TABLE,
  DROP_FORGE_PREPARATIONS_TABLE,
  DROP_FORGE_JOBS_TABLE
} from '@/constants';

@Entity(DROP_FORGE_LAUNCHES_TABLE)
@Index('drop_forge_launch_state_idx', ['state', 'updated_at'])
@Index('drop_forge_launch_reporting_idx', ['report_pending', 'updated_at'])
export class DropForgeLaunchEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 }) id!: string;
  @Column({ type: 'int' }) revision!: number;
  @Column({ type: 'varchar', length: 16 }) state!: string;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'json' }) data!: object;
  @Column({ type: 'bigint' }) updated_at!: number;
  @Column({ type: 'boolean', default: true }) report_pending!: boolean;
}

@Entity(DROP_FORGE_SIGNERS_TABLE)
export class DropForgeSignerEntity {
  @PrimaryColumn({ type: 'varchar', length: 60 }) id!: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) launch_id!:
    | string
    | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) action_id!:
    | string
    | null;
}

@Entity(DROP_FORGE_PREPARATIONS_TABLE)
export class DropForgePreparationEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 }) id!: string;
  @Column({ type: 'json' }) results!: object;
}

@Entity(DROP_FORGE_JOBS_TABLE)
@Index('drop_forge_job_status_idx', ['status', 'updated_at'])
export class DropForgeJobEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 42 }) contract!: string;
  @Column({ type: 'int' }) claim_id!: number;
  @Column({ type: 'varchar', length: 16 }) kind!: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) plan_id!:
    | string
    | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) phase_id!:
    | string
    | null;
  @Column({ type: 'varchar', length: 16 }) status!: string;
  @Column({ type: 'json', nullable: true }) result!: object | null;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) drop_id!:
    | string
    | null;
  @Column({ type: 'bigint' }) updated_at!: number;
}
