import { Profile } from '../entities/IProfile';
import { ProfileMin } from '../profiles/profile-min';
import {
  DropMentionEntity,
  DropMetadataEntity,
  DropReferencedNftEntity
} from '../entities/IDrop';

export interface CreateNewDropRequest {
  readonly author: Profile;
  readonly title: string | null;
  readonly content: string | null;
  readonly root_drop_id: number | null;
  readonly quoted_drop_id: number | null;
  readonly referenced_nfts: DropReferencedNft[];
  readonly mentioned_users: DropMentionedUser[];
  readonly metadata: DropMetadata[];
  readonly dropMedia: NewDropMedia | null;
}

export type DropMentionedUser = Omit<DropMentionEntity, 'drop_id' | 'id'>;
export type DropReferencedNft = Omit<DropReferencedNftEntity, 'drop_id' | 'id'>;
export type DropMetadata = Omit<DropMetadataEntity, 'drop_id' | 'id'>;

export interface MentionedUserResponse extends DropMentionedUser {
  readonly current_handle: string | null;
}

export interface DropFull {
  readonly id: number;
  readonly author: ProfileMin;
  readonly author_archived: boolean;
  readonly created_at: number;
  readonly title: string | null;
  readonly content: string | null;
  readonly quoted_drop_id: number | null;
  readonly referenced_nfts: DropReferencedNft[];
  readonly mentioned_users: MentionedUserResponse[];
  readonly metadata: DropMetadata[];
  readonly media_url: string | null;
  readonly media_mime_type: string | null;
  readonly root_drop_id: number | null;
  readonly storm_sequence: number;
  readonly max_storm_sequence: number;
  readonly rep: number;
}

export interface NewDropMedia {
  readonly stream: Buffer;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
}
