import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { METRIC_ROLLUP_HOUR_TABLE } from '../constants';

export enum MetricRollupHourMetric {
  DROP = 'DROP',
  DROPPER_DROP = 'DROPPER_DROP',
  MAIN_STAGE_SUBMISSION = 'MAIN_STAGE_SUBMISSION',
  MAIN_STAGE_VOTE = 'MAIN_STAGE_VOTE',
  NETWORK_TDH = 'NETWORK_TDH',
  TDH_ON_MAIN_STAGE_SUBMISSIONS = 'TDH_ON_MAIN_STAGE_SUBMISSIONS',
  CONSOLIDATIONS_FORMED = 'CONSOLIDATIONS_FORMED',
  XTDH_GRANTED = 'XTDH_GRANTED',
  ACTIVE_IDENTITY = 'ACTIVE_IDENTITY'
}

@Entity(METRIC_ROLLUP_HOUR_TABLE)
@Index('ix_metric_scope_time', ['metric', 'scope', 'hour_start'])
export class MetricRollupHourEntity {
  @PrimaryColumn({ type: 'datetime', nullable: false })
  hour_start!: Date;

  @PrimaryColumn({ type: 'varchar', length: 64, nullable: false })
  metric!: MetricRollupHourMetric;

  @PrimaryColumn({
    type: 'varchar',
    length: 100,
    nullable: false,
    default: 'global'
  })
  scope!: string;

  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false, default: '' })
  key1!: string;

  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false, default: '' })
  key2!: string;

  @Column({ type: 'bigint', nullable: false, default: 0 })
  event_count!: number;

  @Column({
    type: 'decimal',
    precision: 38,
    scale: 0,
    nullable: false,
    default: 0
  })
  value_sum!: number;
}
