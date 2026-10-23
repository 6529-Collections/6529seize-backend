import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { WebSocketOutboxEvent } from '@/websocket-outbox/events';
import { WEBSOCKET_OUTBOX_TABLE } from '@/constants';

@Entity(WEBSOCKET_OUTBOX_TABLE)
@Index('websocket_outbox_created', ['created_at'])
@Index('websocket_outbox_due', ['available_at', 'id'])
@Index('websocket_outbox_partition', ['partition_key', 'id'])
export class WebSocketOutboxEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  @Column({ type: 'varchar', length: 64 })
  readonly partition_key!: string;

  @Column({ type: 'json' })
  readonly event!: WebSocketOutboxEvent;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly available_at!: number;

  @Column({ type: 'int', default: 0 })
  readonly attempts!: number;
}
