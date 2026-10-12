import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  MEME_COLLABORATIONS_TABLE,
  MEME_COLLABORATION_INVITATIONS_TABLE
} from '@/constants';

export type MemeCollaborationStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'CLOSED';
export interface MemeCollaborationCredit {
  artist: string;
  artist_profiles: string;
  collab: boolean;
}

export interface MemeCollaborationArtwork {
  name: string;
  description: string;
  image_url: string | null;
  animation_url: string | null;
}

@Entity(MEME_COLLABORATIONS_TABLE)
export class MemeCollaborationEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  drop_id!: string;
  @Column({ type: 'varchar', length: 100 })
  author_id!: string;
  @Column({ type: 'varchar', length: 100 })
  author_handle!: string;
  @Column({ type: 'varchar', length: 100 })
  wave_id!: string;
  @Column({ type: 'varchar', length: 64 })
  artwork_hash!: string;
  @Column({ type: 'json' })
  artwork!: MemeCollaborationArtwork;
  @Column({ type: 'text' })
  base_artist!: string;
  @Column({ type: 'text', nullable: true })
  terms!: string | null;
  @Column({ type: 'varchar', length: 64 })
  terms_version!: string;
  @Column({ type: 'bigint', nullable: true })
  closed_at!: number | null;
  @Column({ type: 'json', nullable: true })
  credit!: MemeCollaborationCredit | null;
}

@Entity(MEME_COLLABORATION_INVITATIONS_TABLE)
@Index('meme_collaboration_drop_profile_uq', ['drop_id', 'profile_id'], {
  unique: true
})
@Index('meme_collaboration_profile_status', ['profile_id', 'status', 'drop_id'])
export class MemeCollaborationInvitationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;
  @Column({ type: 'varchar', length: 100 })
  drop_id!: string;
  @Column({ type: 'varchar', length: 100 })
  profile_id!: string;
  @Column({ type: 'varchar', length: 100 })
  profile_handle!: string;
  @Column({ type: 'varchar', length: 16 })
  status!: MemeCollaborationStatus;
  @Column({ type: 'bigint' })
  created_at!: number;
  @Column({ type: 'bigint', nullable: true })
  responded_at!: number | null;
  @Column({ type: 'varchar', length: 42, nullable: true })
  responder_wallet!: string | null;
  @Column({ type: 'varchar', length: 16, nullable: true })
  acceptance_copy_version!: string | null;
}
