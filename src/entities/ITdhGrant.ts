import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TDH_GRANTS_TABLE } from '../constants';

@Entity(TDH_GRANTS_TABLE)
@Index(['target_chain', 'target_contract'])
@Index(['status', 'valid_from', 'target_partition'])
export class TdhGrantEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly id: string;
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
  readonly token_mode!: TdhGrantTokenMode;
  @Column({ type: 'text', nullable: true })
  readonly target_tokens!: string | null;
  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
  @Column({ type: 'bigint', nullable: true })
  readonly valid_from!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly valid_to!: number | null;
  @Column({ type: 'double', nullable: false })
  readonly tdh_rate!: number;
  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly status!: TdhGrantStatus;
  @Column({ type: 'text', nullable: true })
  readonly error_details: string | null;
  @Column({ type: 'boolean', nullable: false })
  readonly is_irrevocable!: boolean;
}

export enum TdhGrantTokenMode {
  ALL = 'ALL',
  INCLUDE = 'INCLUDE'
}

export enum TdhGrantStatus {
  PENDING = 'PENDING',
  FAILED = 'FAILED',
  GRANTED = 'GRANTED',
  DISABLED = 'DISABLED'
}
