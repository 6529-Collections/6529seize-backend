import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { XTDH_GRANTS_TABLE } from '@/constants';

@Entity(XTDH_GRANTS_TABLE)
@Index(['target_chain', 'target_contract'])
@Index(['status', 'valid_from', 'target_partition'])
export class XTdhGrantEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly id: string;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly tokenset_id!: string | null;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly replaced_grant_id!: string | null;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly grantor_id!: string;
  @Column({ type: 'int', nullable: false })
  readonly target_chain!: number;
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly target_contract!: string;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly target_partition!: string;
  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly token_mode!: XTdhGrantTokenMode;
  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
  @Column({ type: 'bigint', nullable: true })
  readonly valid_from!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly valid_to!: number | null;
  @Column({ type: 'double', nullable: false })
  readonly rate!: number;
  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly status!: XTdhGrantStatus;
  @Column({ type: 'text', nullable: true })
  readonly error_details: string | null;
  @Column({ type: 'boolean', nullable: false })
  readonly is_irrevocable!: boolean;
}

export enum XTdhGrantTokenMode {
  ALL = 'ALL',
  INCLUDE = 'INCLUDE'
}

export enum XTdhGrantStatus {
  PENDING = 'PENDING',
  FAILED = 'FAILED',
  GRANTED = 'GRANTED',
  DISABLED = 'DISABLED'
}
