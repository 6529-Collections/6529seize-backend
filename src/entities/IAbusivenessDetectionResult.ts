import { Column, Entity, PrimaryColumn } from 'typeorm';
import { ABUSIVENESS_DETECTION_RESULTS_TABLE } from '../constants';

@Entity(ABUSIVENESS_DETECTION_RESULTS_TABLE)
export class AbusivenessDetectionResult {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly text!: string;
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly status!: 'ALLOWED' | 'DISALLOWED';
  @Column({ type: 'text', nullable: true })
  readonly explanation!: string | null;
  @Column({ type: 'datetime', nullable: false })
  readonly external_check_performed_at!: Date;
}
