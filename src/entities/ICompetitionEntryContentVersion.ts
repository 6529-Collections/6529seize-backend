import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE } from '@/constants';

/** Entry-owned content history; signature material is never a public read field. */
@Entity(COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE)
@Index('idx_competition_entry_content_drop', ['drop_id'])
@Index('idx_competition_entry_content_competition', ['competition_id'])
export class CompetitionEntryContentVersionEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly entry_id!: string;
  @PrimaryColumn({ type: 'int' })
  readonly version!: number;
  @Column({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'json' })
  readonly content!: Record<string, unknown>;
  @Column({ type: 'text', nullable: true })
  readonly signature_message!: string | null;
  @Column({ type: 'text', nullable: true })
  readonly signature!: string | null;
  @Column({ type: 'json', nullable: true })
  readonly signed_payload!: unknown | null;
  @Column({ type: 'json', nullable: true })
  readonly signed_content!: unknown | null;
  @Column({ type: 'varchar', length: 100 })
  readonly actor_id!: string;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
}
