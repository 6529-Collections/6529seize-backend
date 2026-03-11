import { ART_CURATION_TOKEN_WATCH_DROPS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(ART_CURATION_TOKEN_WATCH_DROPS_TABLE)
@Index('idx_art_curation_token_watch_drops_watch_id', ['watch_id'])
@Index('idx_art_curation_token_watch_drops_canonical_id', ['canonical_id'])
@Index('idx_art_curation_token_watch_drops_drop_id', ['drop_id'], {
  unique: true
})
export class ArtCurationTokenWatchDropEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly watch_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 500, nullable: false })
  readonly canonical_id!: string;

  @Column({ type: 'varchar', length: 2000, nullable: false })
  readonly url_in_text!: string;

  @Column({ type: 'varchar', length: 42, nullable: false })
  readonly owner_at_submission!: string;

  @Column({
    type: 'bigint',
    nullable: false
  })
  readonly created_at!: number;

  @Column({
    type: 'bigint',
    nullable: false
  })
  readonly updated_at!: number;
}
