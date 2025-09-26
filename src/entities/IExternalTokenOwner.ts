import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { EXTERNAL_TOKEN_OWNERS_TABLE } from '../constants';

@Entity(EXTERNAL_TOKEN_OWNERS_TABLE)
@Index(['chain', 'contract'])
@Index(['chain', 'contract', 'token'])
export class ExternalTokenOwnerEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly id: string;
  @Column({ type: 'int', nullable: false })
  readonly chain: number;
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly contract: string;
  @Column({ type: 'bigint', nullable: false })
  readonly token: number;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly owner: string;
  @Column({ type: 'bigint', nullable: false })
  readonly owned_since_block: number;
  @Column({ type: 'bigint', nullable: false })
  readonly owned_since_time: number;
  @Column({ type: 'bigint', nullable: false })
  readonly amount: number;
  @Column({ type: 'boolean', nullable: false })
  readonly is_tombstone: boolean;
}
