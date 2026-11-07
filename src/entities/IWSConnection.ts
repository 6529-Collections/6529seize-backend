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
  // Capability is immutable for this physical connection; older rows default to legacy.
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly durable_updates?: boolean;
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly purpose?: WsConnectionPurpose | null;
  /**
   * The wave this tab has open, declared by the app socket with
   * `SET_OPEN_WAVE` (waves 1.3). Unlike `wave_id` (SUBSCRIBE_TO_WAVE), it
   * never narrows what the socket receives; it only adds the socket to that
   * wave's viewers when `WS_AUDIENCE_FOLLOWERS` is on.
   */
  @Index('idx_ws_connections_open_wave_id')
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly open_wave_id?: string | null;
  /**
   * The frontend build (git SHA) the client declared with `client_version=`
   * on `$connect`, for build-adoption metrics. Null when not declared.
   */
  @Column({ type: 'varchar', length: 40, nullable: true, default: null })
  readonly client_version?: string | null;
}
