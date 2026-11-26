import { Column, Entity, PrimaryColumn } from 'typeorm';
import { ARTISTS_TABLE } from '@/constants';

export interface ArtistMemesNfts {
  id: number;
  collboration_with: string[];
}

export interface ArtistWork {
  title: string;
  link: string;
}

export interface Artist {
  name: string;
  memes: ArtistMemesNfts[];
  memelab: ArtistMemesNfts[];
  gradients: number[];
  bio?: string;
  pfp?: string;
  work: ArtistWork[];
  social_links: any[];
}

/**
 * The artists table, as the code reads and writes it (db.ts persistArtists
 * and fetchAllArtists, db-api.ts artists names, the mint stats total,
 * collecting.db.ts). The NFTs loop derives the card lists from the cards'
 * artist names; bio, pfp, work and social links were typed in by hand and
 * no route serves them. The JSON lists are text here. Schema sync leaves the
 * table alone: production's table predates this entity and its exact column
 * types are not known here, so a difference must never plan an ALTER. A
 * fresh schema gets the table from the migrations loop
 * (unsynced-holdings-tables-schema.ts).
 */
@Entity({ name: ARTISTS_TABLE, synchronize: false })
export class ArtistEntity {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'datetime', nullable: true })
  created_at!: Date | null;

  /** JSON list of { id, collboration_with }: Memes cards. */
  @Column({ type: 'text', nullable: true })
  memes!: string | null;

  /** JSON list of { id, collboration_with }: Meme Lab cards. */
  @Column({ type: 'text', nullable: true })
  memelab!: string | null;

  /** JSON list of Gradient token ids. */
  @Column({ type: 'text', nullable: true })
  gradients!: string | null;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'text', nullable: true })
  pfp!: string | null;

  /** JSON list of { title, link }. */
  @Column({ type: 'text', nullable: true })
  work!: string | null;

  /** JSON list. */
  @Column({ type: 'text', nullable: true })
  social_links!: string | null;
}
