import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WS_CONNECTIONS_TABLE } from '@/constants';

/**
 * What a client opened a socket for, declared once with `purpose=` on
 * `$connect`. Null is a legacy socket that keeps today's audience rules.
 * Stored as plain text; unknown values are never written.
 */
export enum WsConnectionPurpose {
  /** Typing indicator only: never part of drop or wave broadcasts. */
  TYPING = 'TYPING'
}

@Entity(WS_CONNECTIONS_TABLE)
@Index('idx_ws_connections_identity_expiry', [
  'identity_id',
  'jwt_expiry',
  'connection_id'
])
export class WSConnectionEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly connection_id!: string;
  @Column({ type: 'bigint', nullable: false })
  readonly jwt_expiry!: number;
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly identity_id!: string | null;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly purpose?: WsConnectionPurpose | null;
}
