import { Column, Entity, PrimaryColumn, Unique } from 'typeorm';
import { RATE_MATTERS_CATEGORIES_TABLE } from '../constants';

@Entity(RATE_MATTERS_CATEGORIES_TABLE)
@Unique(['matter_target_type', 'matter', 'matter_category_tag'])
export class RateMatterCategory {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;
  @Column({ type: 'varchar', length: 256 })
  matter_target_type!: RateMatterTargetType;
  @Column({ type: 'varchar', length: 256 })
  matter!: string;
  @Column({ type: 'varchar', length: 256 })
  matter_category_tag!: string;
  @Column({ type: 'varchar', length: 256 })
  matter_category_display_name!: string;
  @Column({ type: 'json', nullable: true })
  matter_category_media!: string | null;
  @Column({ type: 'timestamp' })
  created_time!: Date;
  @Column({ type: 'timestamp', nullable: true })
  disabled_time!: Date | null;
}

export interface RateCategoryMedia {
  media_type: string;
  media_url: string;
}

export enum RateMatterTargetType {
  WALLET = 'WALLET',
  PROFILE_ID = 'PROFILE_ID'
}
