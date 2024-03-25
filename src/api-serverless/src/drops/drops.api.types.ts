import {
  DropMentionedUser,
  DropMetadata,
  DropReferencedNft
} from '../../../drops/drops.types';

export interface DropApiRequest {
  readonly title: string | null;
  readonly content: string | null;
  readonly storm_id: number | null;
  readonly quoted_drop_id: number | null;
  readonly referenced_nfts: DropReferencedNft[];
  readonly mentioned_users: DropMentionedUser[];
  readonly metadata: DropMetadata[];
}

export function fromRawApiRequestToApiRequest(
  request: DropApiRawRequest
): DropApiRequest {
  return {
    ...request,
    referenced_nfts: request.referenced_nfts
      ? JSON.parse(request.referenced_nfts)
      : [],
    mentioned_users: request.mentioned_users
      ? JSON.parse(request.mentioned_users)
      : [],
    metadata: request.metadata ? JSON.parse(request.metadata) : []
  };
}

export interface DropApiRawRequest
  extends Omit<
    DropApiRequest,
    'referenced_nfts' | 'mentioned_users' | 'metadata'
  > {
  readonly referenced_nfts: string | null;
  readonly mentioned_users: string | null;
  readonly metadata: string | null;
}
