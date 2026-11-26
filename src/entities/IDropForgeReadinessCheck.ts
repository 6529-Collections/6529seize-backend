import { Column, Entity, PrimaryColumn } from 'typeorm';
import { DROP_FORGE_READINESS_TABLE } from '@/constants';

@Entity(DROP_FORGE_READINESS_TABLE)
export class DropForgeReadinessCheckEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 }) id!: string;
  @Column({ type: 'bigint', default: 0 }) checked_at!: number;
  @Column({ type: 'varchar', length: 36, nullable: true })
  drop_id!: string | null;
}
