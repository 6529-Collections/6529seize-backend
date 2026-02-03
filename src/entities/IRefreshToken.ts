import { Entity, PrimaryColumn, Column } from 'typeorm';
import { REFRESH_TOKENS_TABLE } from '@/constants';

@Entity(REFRESH_TOKENS_TABLE)
export class RefreshToken {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  address!: string;

  @Column({ type: 'text' })
  refresh_token!: string;
}
