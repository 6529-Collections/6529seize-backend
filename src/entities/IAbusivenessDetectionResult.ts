import { Column, Entity, PrimaryColumn } from 'typeorm';
import { ABUSIVENESS_DETECTION_RESULTS_TABLE } from '@/constants';

@Entity(ABUSIVENESS_DETECTION_RESULTS_TABLE)
export class AbusivenessDetectionResult {
  @PrimaryColumn({
    type: 'varchar',
    length: 100,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly text!: string;
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly status!: 'ALLOWED' | 'DISALLOWED';
  @Column({ type: 'text', nullable: true })
  readonly explanation!: string | null;
  @Column({ type: 'datetime', nullable: false })
  readonly external_check_performed_at!: Date;
}

// Rep categories are identity keys (aggregated per exact string) and flow
// into URLs, AI-check prompts, notifications and data exports, so the
// character set is a deliberate allowlist. The ASCII dash is permitted
// anywhere EXCEPT as the first character: a leading dash is a spreadsheet
// formula-injection trigger in CSV exports and reads as a negative sign next
// to signed rep amounts. Unicode dashes (en/em) stay disallowed. Total
// length stays 1-100 (first char + up to 99 more).
export const REP_CATEGORY_PATTERN = new RegExp(
  "^[\\p{L}\\p{N}?!,.'() ][\\p{L}\\p{N}?!,.'() -]{0,99}$",
  'u'
);

export const REP_CATEGORY_INVALID_MESSAGE = `Invalid category. Use 1-100 characters: letters, numbers, spaces, dashes and , . ? ! ' ( ). A dash can't be the first character.`;
