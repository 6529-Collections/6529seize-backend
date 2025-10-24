import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TDH_GRANT_TOKENS_TABLE } from '../constants';

@Entity(TDH_GRANT_TOKENS_TABLE)
@Index(['target_partition', 'token_id'])
export class TdhGrantTokenEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly tokenset_id!: string;

  @PrimaryColumn({ type: 'bigint', unsigned: true, nullable: false })
  readonly token_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly target_partition!: string;
}
