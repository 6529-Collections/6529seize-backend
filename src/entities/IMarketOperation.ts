import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('market_operations')
@Index('market_operation_idempotency', ['wallet', 'idempotency_key'], {
  unique: true
})
@Index('market_operation_profile_updated', ['profile_id', 'updated_at', 'id'])
@Index('market_operation_profile_created', ['profile_id', 'created_at', 'id'])
@Index('market_operation_reconcile', ['state', 'updated_at'])
@Index('market_operation_funding', ['wallet', 'currency'])
@Index('market_operation_transaction', ['transaction_hash'], { unique: true })
export class MarketOperationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 100 }) profile_id!: string;
  @Column({ type: 'varchar', length: 36, nullable: true }) rule_id?:
    | string
    | null;
  @Column({ type: 'varchar', length: 42 }) wallet!: string;
  @Column({ type: 'varchar', length: 36 }) idempotency_key!: string;
  @Column({ type: 'char', length: 64 }) request_hash!: string;
  @Column({ type: 'varchar', length: 32 }) state!: string;
  @Column({ type: 'json' }) request_json!: string;
  @Column({ type: 'json', nullable: true }) prepared_json!: string | null;
  @Column({ type: 'json', nullable: true }) send_attempt_json?: string | null;
  @Column({ type: 'varchar', length: 66, nullable: true }) transaction_hash!:
    | string
    | null;
  @Column({ type: 'varchar', length: 66, nullable: true }) order_hash!:
    | string
    | null;
  @Column({ type: 'varchar', length: 78, default: '0' }) liability_wei!: string;
  @Column({ type: 'varchar', length: 42 }) currency!: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) error_code!:
    | string
    | null;
  @Column({ type: 'bigint' }) created_at!: number;
  @Column({ type: 'bigint' }) updated_at!: number;
  @Column({ type: 'bigint' }) expires_at!: number;
}

@Entity('market_operation_events')
@Index('market_event_operation', ['operation_id', 'created_at', 'id'])
export class MarketOperationEventEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 36 }) operation_id!: string;
  @Column({ type: 'varchar', length: 32 }) state!: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) reason!:
    | string
    | null;
  @Column({ type: 'bigint' }) created_at!: number;
}

// Serialize reservations across every profile that may use a wallet over time.
@Entity('market_wallet_exposure_locks')
export class MarketWalletExposureLockEntity {
  @PrimaryColumn({ type: 'varchar', length: 42 }) wallet!: string;
  @PrimaryColumn({ type: 'varchar', length: 42 }) currency!: string;
}

@Entity('market_reviewed_transactions')
export class MarketReviewedTransactionEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) operation_id!: string;
  @PrimaryColumn({ type: 'char', length: 64 }) transaction_digest!: string;
  @Column({ type: 'json' }) prepared_json!: string;
  @Column({ type: 'bigint' }) created_at!: number;
}
