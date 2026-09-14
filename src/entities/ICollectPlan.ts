import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('collect_plans')
@Index('collect_plan_profile_updated', ['profile_id', 'updated_at', 'id'])
export class CollectPlanEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'varchar', length: 100 }) profile_id!: string;
  @Column({ type: 'json' }) payload_json!: string;
  @Column({ type: 'varchar', length: 20 }) state!: string;
  @Column({ type: 'varchar', length: 36, nullable: true }) lease_token!:
    | string
    | null;
  @Column({ type: 'bigint', default: 0 }) lease_until!: number;
  @Column({ type: 'bigint' }) created_at!: number;
  @Column({ type: 'bigint' }) updated_at!: number;
}
