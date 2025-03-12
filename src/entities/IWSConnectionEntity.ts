import { Column, Entity, PrimaryColumn } from 'typeorm';
import { WS_CONNECTIONS_TABLE } from '../constants';

@Entity(WS_CONNECTIONS_TABLE)
export class WSConnectionEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly connection_id!: string;
  @Column({ type: 'bigint', nullable: false })
  readonly jwt_expiry!: number;
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly identity_id!: string | null;
}
