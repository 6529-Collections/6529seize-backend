export const NftLinkMediaPreviewStatuses = [
  'PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
  'SKIPPED'
] as const;

export type NftLinkMediaPreviewStatus =
  (typeof NftLinkMediaPreviewStatuses)[number];

export const NftLinkMediaPreviewKinds = [
  'image',
  'video',
  'animation',
  'unknown'
] as const;

export type NftLinkMediaPreviewKind = (typeof NftLinkMediaPreviewKinds)[number];

export interface NftLinkMediaPreviewJobMessage {
  canonicalId: string;
  sourceHash?: string | null;
}
