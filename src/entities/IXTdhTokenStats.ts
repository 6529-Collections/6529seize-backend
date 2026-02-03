import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { XTDH_TOKEN_STATS_TABLE_PREFIX } from '@/constants';

export class XTdhTokenStatsEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly partition!: string;

  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly token_id!: number;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly owner!: string;

  @Column({ type: 'double', nullable: false })
  readonly xtdh_total!: number;

  @Column({ type: 'double', nullable: false })
  readonly xtdh_rate_daily!: number;

  @Column({ type: 'int', nullable: false })
  readonly grant_count!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly total_contributor_count!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly active_contributor_count!: number;
}

@Entity(`${XTDH_TOKEN_STATS_TABLE_PREFIX}a`)
@Index('idx_xts_a_owner', ['owner'])
@Index('idx_xts_a_xtdh_total', ['xtdh_total'])
@Index('idx_xts_a_partition', ['partition'])
@Index('idx_xts_a_owner_partition', ['owner', 'partition'])
@Index('idx_xts_a_partition_token_id', ['partition', 'token_id'])
export class XTdhTokenStatsA extends XTdhTokenStatsEntity {}

@Entity(`${XTDH_TOKEN_STATS_TABLE_PREFIX}b`)
@Index('idx_xts_b_owner', ['owner'])
@Index('idx_xts_b_xtdh_total', ['xtdh_total'])
@Index('idx_xts_b_partition', ['partition'])
@Index('idx_xts_b_owner_partition', ['owner', 'partition'])
@Index('idx_xts_b_partition_token_id', ['partition', 'token_id'])
export class XTdhTokenStatsB extends XTdhTokenStatsEntity {}
