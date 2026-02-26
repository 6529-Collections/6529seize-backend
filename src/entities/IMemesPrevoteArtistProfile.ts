import { Entity, Index, PrimaryColumn } from 'typeorm';
import { MEMES_PREVOTE_ARTIST_PROFILES_TABLE } from '@/constants';

@Entity(MEMES_PREVOTE_ARTIST_PROFILES_TABLE)
export class MemesPrevoteArtistProfileEntity {
  @Index()
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly profile_id!: string;

  @PrimaryColumn({ type: 'int', nullable: false })
  readonly card_no!: number;
}
