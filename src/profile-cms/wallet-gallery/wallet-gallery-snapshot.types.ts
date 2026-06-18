export enum WalletGalleryCollectionKey {
  MEMES = 'MEMES',
  MEMELAB = 'MEMELAB',
  GRADIENTS = 'GRADIENTS',
  NEXTGEN = 'NEXTGEN'
}

export enum WalletGalleryWalletResolutionStatus {
  RESOLVED = 'resolved',
  UNRESOLVED = 'unresolved'
}

export interface WalletGalleryWalletInputResolution {
  readonly input: string;
  readonly address: string | null;
  readonly ens: string | null;
  readonly display: string | null;
  readonly status: WalletGalleryWalletResolutionStatus;
  readonly reason: string | null;
}

export interface WalletGalleryNormalizedInputs {
  readonly inputs: WalletGalleryWalletInputResolution[];
  readonly addresses: string[];
}

export interface WalletGalleryOwnershipRow {
  readonly owner_wallet: string;
  readonly owner_display: string | null;
  readonly contract: string;
  readonly token_id: number | string;
  readonly balance: number | string;
  readonly block_reference: number | string | null;
  readonly name: string | null;
  readonly collection: string | null;
  readonly collection_key: WalletGalleryCollectionKey;
  readonly token_type: string | null;
  readonly description: string | null;
  readonly artist: string | null;
  readonly artist_seize_handle: string | null;
  readonly thumbnail: string | null;
  readonly image: string | null;
  readonly scaled: string | null;
  readonly animation: string | null;
  readonly compressed_animation: string | null;
  readonly icon: string | null;
  readonly metadata: unknown | null;
}

export interface WalletGalleryMediaSource {
  readonly thumbnail?: string | null;
  readonly image?: string | null;
  readonly scaled?: string | null;
  readonly animation?: string | null;
  readonly compressed_animation?: string | null;
  readonly icon?: string | null;
}
