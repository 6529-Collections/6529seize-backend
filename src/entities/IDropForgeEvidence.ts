import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_FORGE_EVIDENCE_TABLE } from '@/constants';
@Entity(DROP_FORGE_EVIDENCE_TABLE)
@Index('drop_forge_evidence_claim_idx', ['contract', 'claim_id'])
export class DropForgeEvidenceEntity {
  @PrimaryColumn({ type: 'varchar', length: 80 }) id!: string;
  @Column({ type: 'varchar', length: 42 }) contract!: string;
  @Column({ type: 'int' }) claim_id!: number;
  @Column({ type: 'int' }) chain_id!: number;
  @Column({ type: 'varchar', length: 66 }) hash!: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) action!:
    | string
    | null;
}
