import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { COMPETITION_CAPABILITY_AUDITS_TABLE } from '@/constants';
import { CompetitionCapability } from './ICompetition';

@Entity(COMPETITION_CAPABILITY_AUDITS_TABLE)
@Index('idx_competition_capability_audits_competition', [
  'competition_id',
  'created_at'
])
export class CompetitionCapabilityAuditEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36 }) readonly competition_id!: string;
  @Column({ type: 'varchar', length: 32 })
  readonly capability!: CompetitionCapability;
  @Column({ type: 'varchar', length: 16 }) readonly action!:
    | 'assign'
    | 'remove';
  @Column({ type: 'varchar', length: 100 }) readonly actor_id!: string;
  @Column({ type: 'text' }) readonly reason!: string;
  @Column({ type: 'bigint' }) readonly created_at!: number;
}
