import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX } from '@/constants';

export class XTdhTokenGrantStatsEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly grant_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly partition!: string;

  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly token_id!: number;

  @Column({ type: 'double', nullable: false })
  readonly xtdh_total!: number;

  @Column({ type: 'double', nullable: false })
  readonly xtdh_rate_daily!: number;
}

@Entity(`${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}a`)
@Index('idx_xtgs_a_partition_token_id', ['partition', 'token_id'])
@Index('idx_xtgs_a_grant_id', ['grant_id'])
@Index('idx_xtgs_a_partition', ['partition'])
export class XTdhTokenGrantStatsA extends XTdhTokenGrantStatsEntity {}

@Entity(`${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}b`)
@Index('idx_xtgs_b_partition_token_id', ['partition', 'token_id'])
@Index('idx_xtgs_b_grant_id', ['grant_id'])
@Index('idx_xtgs_b_partition', ['partition'])
export class XTdhTokenGrantStatsB extends XTdhTokenGrantStatsEntity {}
