export interface CreateOrUpdateDropModel {
  readonly drop_id: string | null;
  readonly wave_id: string;
  readonly reply_to: DropPartIdentifierModel | null;
  readonly title: string | null;
  readonly parts: CreateOrUpdateDropPartModel[];
  readonly referenced_nfts: DropReferencedNftModel[];
  readonly mentioned_users: DropMentionedUserModel[];
  readonly metadata: DropMetadataModel[];
  readonly author_identity: string;
  readonly author_id?: string;
  readonly proxy_identity?: string;
  readonly proxy_id?: string;
}

export interface CreateOrUpdateDropPartModel {
  readonly content: string | null;
  readonly quoted_drop: DropPartIdentifierModel | null;
  readonly media: DropMediaModel[];
}

export interface DropPartIdentifierModel {
  readonly drop_id: string;
  readonly drop_part_id: number;
}

export interface DropMediaModel {
  readonly url: string;
  readonly mime_type: string;
}

export interface DropReferencedNftModel {
  readonly contract: string;
  readonly token: string;
  readonly name: string;
}

export interface DropMentionedUserModel {
  readonly handle: string;
}

export interface DropMetadataModel {
  readonly data_key: string;
  readonly data_value: string;
}
