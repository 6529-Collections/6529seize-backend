import { Profile } from '../entities/IProfile';
import { ProfileMin } from '../profiles/profile-min';
import {
  DropMentionEntity,
  DropMetadataEntity,
  DropReferencedNftEntity
} from '../entities/IDrop';
import { ProfileActivityLog } from '../entities/IProfileActivityLog';

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
  readonly top_rep_givers: {
    rep_given: number;
    profile: ProfileMin;
  }[];
  readonly total_number_of_rep_givers: number;
  readonly top_rep_categories: {
    rep_given: number;
    category: string;
  }[];
  readonly total_number_of_categories: number;
  readonly input_profile_categories:
    | {
        category: string;
        rep_given: number;
        rep_given_by_input_profile: number;
      }[]
    | null;
  readonly rep_given_by_input_profile: number | null;
  readonly discussion_comments_count: number;
  readonly rep_logs_count: number;
  readonly input_profile_discussion_comments_count: number | null;
  readonly quote_count: number;
  readonly quote_count_by_input_profile: number | null;
}

export interface DropActivityLog extends ProfileActivityLog {
  readonly author: ProfileMin | null;
}

export interface NewDropMedia {
  readonly url: string;
  readonly mimetype: string;
}
