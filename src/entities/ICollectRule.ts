import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('collect_rules')
@Index('collect_rule_profile_updated', ['profile_id', 'updated_at', 'id'])
@Index('collect_rule_request_key', ['profile_id', 'idempotency_key'], {
  unique: true
})
export class CollectRuleEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 100 }) profile_id!: string;
  @Column({ type: 'varchar', length: 36 }) idempotency_key!: string;
  @Column({ type: 'char', length: 64 }) request_hash!: string;
  @Column({ type: 'json' }) payload_json!: string;
  @Column({ type: 'varchar', length: 20 }) state!: string;
  @Column({ type: 'int', unsigned: true }) revision!: number;
  @Column({ type: 'bigint' }) created_at!: number;
  @Column({ type: 'bigint' }) updated_at!: number;
}

/** Permanent operation binding prevents the same purchase crediting two rules. */
@Entity('collect_rule_operations')
@Index('collect_rule_operation_rule', ['rule_id', 'created_at'])
export class CollectRuleOperationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) operation_id!: string;
  @Column({ type: 'varchar', length: 36 }) rule_id!: string;
  @Column({ type: 'char', length: 64 }) review_hash!: string;
  @Column({ type: 'char', length: 64, nullable: true }) settlement_hash!:
    | string
    | null;
  @Column({ type: 'bigint' }) created_at!: number;
}
