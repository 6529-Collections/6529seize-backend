import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_BOOKMARKS_TABLE } from '@/constants';

@Entity(DROP_BOOKMARKS_TABLE)
@Index('idx_drop_bookmarks_identity_drop', ['identity_id', 'drop_id'], {
  unique: true
})
@Index('idx_drop_bookmarks_identity_bookmarked_at', [
  'identity_id',
  'bookmarked_at'
])
export class DropBookmarkEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly identity_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;

  @Column({ type: 'bigint' })
  readonly bookmarked_at!: number;
}
