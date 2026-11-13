import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { ARTIST_ARTWORK_ALERTS_TABLE } from '@/constants';

/** Independent of feed subscriptions. Deleting a preference never unfollows. */
@Entity(ARTIST_ARTWORK_ALERTS_TABLE)
@Index('artist_artwork_alert_recipients', ['artist_id', 'subscriber_id'])
export class ArtistArtworkAlertEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  readonly subscriber_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  readonly artist_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly enabled_at!: number;
}
