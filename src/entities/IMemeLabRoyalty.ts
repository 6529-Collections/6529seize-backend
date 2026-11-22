import { Column, Entity, PrimaryColumn } from 'typeorm';
import { MEME_LAB_ROYALTIES_TABLE } from '@/constants';

/**
 * Each Meme Lab card's royalty splits, as fractions of the sale, as the
 * royalties API reads them (royalties.db.ts, a LEFT JOIN on token_id). The
 * splits were typed in by hand; a rebuild reads them from
 * src/holdings/meme-lab-royalties.json. Schema sync leaves the table alone,
 * as it does the artists table; a fresh schema gets it from the migrations
 * loop.
 */
@Entity({ name: MEME_LAB_ROYALTIES_TABLE, synchronize: false })
export class MemeLabRoyaltyEntity {
  @PrimaryColumn({ type: 'int' })
  token_id!: number;

  @Column({ type: 'double', default: 0 })
  primary_royalty_split!: number;

  @Column({ type: 'double', default: 0 })
  secondary_royalty_split!: number;
}
