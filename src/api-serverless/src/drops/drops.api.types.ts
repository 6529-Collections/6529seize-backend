import {
  DropMentionedUser,
  DropMetadata,
  DropReferencedNft,
  NewDropMedia
} from '../../../drops/drops.types';

export interface DropApiRequest {
  readonly title: string | null;
  readonly content: string | null;
  readonly root_drop_id: number | null;
  readonly quoted_drop_id: number | null;
  readonly referenced_nfts: DropReferencedNft[];
  readonly mentioned_users: DropMentionedUser[];
  readonly metadata: DropMetadata[];
  readonly drop_media: NewDropMedia | null;
}
