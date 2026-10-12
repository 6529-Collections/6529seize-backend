/**
 * Structural limits for a single drop: how many parts, media items,
 * attachments, metadata entries, mentions and NFT references it may carry, and
 * how long the individual media / NFT strings may be. Content length is bounded
 * separately in drop-content-limits.ts.
 *
 * Counts are hard caps set well above anything the 6529 clients produce:
 * - the frontend composer allows at most 8 files (media + attachments) per
 *   drop, builds storms one part at a time, sends ~46 metadata entries for a
 *   meme submission, and derives mentions / NFT references from content that is
 *   itself capped at DROP_TOTAL_MAX_UTF16_CODE_UNITS.
 *
 * String lengths mirror the column sizes the values are stored in:
 * - drop_media.url varchar(2000), drop_media.mime_type varchar(100),
 *   drop_media.media_upload_id varchar(100)
 * - drop_attachments.attachment_id varchar(100)
 * - drop_referenced_nfts.token varchar(250), drop_referenced_nfts.name
 *   varchar(500)
 * - waves.name varchar(250) bounds a mentioned wave name
 */
export const DROP_MAX_PARTS = 250;
export const DROP_PART_MAX_MEDIA = 20;
export const DROP_PART_MAX_ATTACHMENTS = 20;
export const DROP_MAX_MEDIA = 100;
export const DROP_MAX_ATTACHMENTS = 100;
export const DROP_MAX_METADATA_ENTRIES = 100;
export const DROP_MAX_MENTIONED_USERS = 500;
export const DROP_MAX_MENTIONED_WAVES = 100;
export const DROP_MAX_REFERENCED_NFTS = 500;

export const DROP_MEDIA_URL_MAX_LENGTH = 2000;
export const DROP_MEDIA_MIME_TYPE_MAX_LENGTH = 100;
export const DROP_MEDIA_UPLOAD_ID_MAX_LENGTH = 100;
export const DROP_ATTACHMENT_ID_MAX_LENGTH = 100;
export const DROP_REFERENCED_NFT_TOKEN_MAX_LENGTH = 250;
export const DROP_REFERENCED_NFT_NAME_MAX_LENGTH = 500;
export const DROP_MENTIONED_WAVE_NAME_MAX_LENGTH = 250;

export type DropPayloadLimitViolation =
  | {
      readonly kind: 'count';
      readonly path: string;
      readonly limit: number;
    }
  | {
      readonly kind: 'length';
      readonly path: string;
      readonly limit: number;
    }
  | {
      readonly kind: 'total-count';
      readonly field: 'media' | 'attachments';
      readonly limit: number;
    };

interface DropPayloadMedia {
  readonly url?: string | null;
  readonly mime_type?: string | null;
  readonly media_upload_id?: string | null;
}

interface DropPayloadPart {
  readonly media?: readonly DropPayloadMedia[] | null;
  readonly attachments?: readonly unknown[] | null;
}

export interface DropPayload {
  readonly parts: readonly DropPayloadPart[];
  readonly metadata?: readonly unknown[] | null;
  readonly mentioned_users?: readonly unknown[] | null;
  readonly mentioned_waves?: readonly unknown[] | null;
  readonly referenced_nfts?: readonly unknown[] | null;
}

const DROP_LIST_LIMITS = [
  ['parts', DROP_MAX_PARTS],
  ['metadata', DROP_MAX_METADATA_ENTRIES],
  ['mentioned_users', DROP_MAX_MENTIONED_USERS],
  ['mentioned_waves', DROP_MAX_MENTIONED_WAVES],
  ['referenced_nfts', DROP_MAX_REFERENCED_NFTS]
] as const;

const DROP_MEDIA_STRING_LIMITS = [
  ['url', DROP_MEDIA_URL_MAX_LENGTH],
  ['mime_type', DROP_MEDIA_MIME_TYPE_MAX_LENGTH],
  ['media_upload_id', DROP_MEDIA_UPLOAD_ID_MAX_LENGTH]
] as const;

function getListViolation(drop: DropPayload): DropPayloadLimitViolation | null {
  for (const [field, limit] of DROP_LIST_LIMITS) {
    if ((drop[field]?.length ?? 0) > limit) {
      return { kind: 'count', path: field, limit };
    }
  }
  return null;
}

function getMediaViolation(
  media: readonly DropPayloadMedia[],
  partIndex: number
): DropPayloadLimitViolation | null {
  for (let mediaIndex = 0; mediaIndex < media.length; mediaIndex++) {
    for (const [field, limit] of DROP_MEDIA_STRING_LIMITS) {
      if ((media[mediaIndex]?.[field]?.length ?? 0) > limit) {
        return {
          kind: 'length',
          path: `parts[${partIndex}].media[${mediaIndex}].${field}`,
          limit
        };
      }
    }
  }
  return null;
}

function getPartViolation(
  part: DropPayloadPart,
  partIndex: number
): DropPayloadLimitViolation | null {
  const media = part.media ?? [];
  if (media.length > DROP_PART_MAX_MEDIA) {
    return {
      kind: 'count',
      path: `parts[${partIndex}].media`,
      limit: DROP_PART_MAX_MEDIA
    };
  }
  if ((part.attachments?.length ?? 0) > DROP_PART_MAX_ATTACHMENTS) {
    return {
      kind: 'count',
      path: `parts[${partIndex}].attachments`,
      limit: DROP_PART_MAX_ATTACHMENTS
    };
  }
  return getMediaViolation(media, partIndex);
}

/**
 * Per-part limits are not enough on their own: parts x media-per-part would
 * still allow thousands of rows, so media and attachments are also capped
 * across the whole drop.
 */
export function getDropMediaTotalsViolation(
  parts: readonly DropPayloadPart[]
): DropPayloadLimitViolation | null {
  let totalMedia = 0;
  let totalAttachments = 0;
  for (const part of parts) {
    totalMedia += part.media?.length ?? 0;
    if (totalMedia > DROP_MAX_MEDIA) {
      return { kind: 'total-count', field: 'media', limit: DROP_MAX_MEDIA };
    }
    totalAttachments += part.attachments?.length ?? 0;
    if (totalAttachments > DROP_MAX_ATTACHMENTS) {
      return {
        kind: 'total-count',
        field: 'attachments',
        limit: DROP_MAX_ATTACHMENTS
      };
    }
  }
  return null;
}

/**
 * Checks the top-level list sizes first so every later loop is already bounded.
 */
export function getDropPayloadLimitViolation(
  drop: DropPayload
): DropPayloadLimitViolation | null {
  const listViolation = getListViolation(drop);
  if (listViolation) {
    return listViolation;
  }
  for (let partIndex = 0; partIndex < drop.parts.length; partIndex++) {
    const partViolation = getPartViolation(drop.parts[partIndex], partIndex);
    if (partViolation) {
      return partViolation;
    }
  }
  return getDropMediaTotalsViolation(drop.parts);
}

export function formatDropPayloadLimitViolation(
  violation: DropPayloadLimitViolation
): string {
  switch (violation.kind) {
    case 'count':
      return `${violation.path} must contain at most ${violation.limit} items`;
    case 'length':
      return `${violation.path} must be at most ${violation.limit} characters long`;
    case 'total-count':
      return `${violation.field} across all drop parts must contain at most ${violation.limit} items in total`;
  }
}
