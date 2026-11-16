import { publicMediaKey } from '@/drops/drop-media-purpose';
import { DropType } from '@/entities/IDrop';
import { DropMediaUploadPurpose } from '@/entities/IDropMediaUpload';
import {
  DropMediaCandidateRow,
  WavePictureRow
} from './chat-media-backfill.db';
import {
  AmbiguityReason,
  ExclusionReason,
  MediaExclusionIndex,
  SkipReason
} from './media-exclusion-index';
import { isBackfillScopeKey } from './media-references';

export type ChatMediaKind = 'image' | 'video';

export enum ChatMediaSource {
  DROP_MEDIA = 'drop_media',
  WAVE_PICTURE = 'wave_picture',
  ARCHIVED_WAVE_PICTURE = 'archived_wave_picture'
}

/** Rows the backfill does not consider at all; they are only counted. */
export enum OutOfScopeReason {
  NOT_WAVE_MEDIA_URL = 'not_wave_media_url',
  OTHER_MEDIA_TYPE = 'other_media_type',
  NO_PICTURE = 'no_picture'
}

export enum EnvironmentGuardReason {
  /**
   * The public bucket is shared between environments, so outside production
   * only objects this environment's own upload records prove it published
   * are touched.
   */
  NOT_UPLOADED_IN_THIS_ENVIRONMENT = 'not_uploaded_in_this_environment'
}

export type CandidateSkipReason = SkipReason | EnvironmentGuardReason;

export interface ChatMediaTarget {
  readonly key: string;
  readonly kind: ChatMediaKind;
  readonly source: ChatMediaSource;
  readonly urls: string[];
  readonly inDirectMessage: boolean;
  readonly isReply: boolean;
}

export type CandidateDecision =
  | { readonly kind: 'target'; readonly target: ChatMediaTarget }
  | {
      readonly kind: 'skipped';
      readonly key: string;
      readonly reasons: CandidateSkipReason[];
    }
  | { readonly kind: 'out_of_scope'; readonly reason: OutOfScopeReason };

export interface CandidateContext {
  readonly exclusions: MediaExclusionIndex;
  /** Set when only keys with an upload record in this database may change. */
  readonly uploadKeys: ReadonlySet<string> | null;
}

function mediaKind(mimeType: string): ChatMediaKind | null {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  return null;
}

function truthy(value: number | boolean | null): boolean {
  return value === true || Number(value) === 1;
}

/** Per-row reasons; the exclusion index already covers other drops' use of the key. */
function dropMediaRowReasons(row: DropMediaCandidateRow): SkipReason[] {
  if (!row.joined_drop_id) return [AmbiguityReason.ORPHAN_DROP_MEDIA];
  if (
    row.drop_type !== DropType.CHAT ||
    Number(row.has_competition_entry ?? 0) === 1
  ) {
    return [ExclusionReason.DECISION_ENTRY_MEDIA];
  }
  if (row.upload_purpose === DropMediaUploadPurpose.DECISION_ENTRY) {
    return [ExclusionReason.DECISION_ENTRY_UPLOAD];
  }
  if (
    row.upload_purpose !== null &&
    row.upload_purpose !== DropMediaUploadPurpose.CHAT
  ) {
    return [AmbiguityReason.UNKNOWN_UPLOAD_PURPOSE];
  }
  return [];
}

function decide(
  key: string,
  rowReasons: SkipReason[],
  context: CandidateContext,
  target: Omit<ChatMediaTarget, 'key'>
): CandidateDecision {
  const reasons: CandidateSkipReason[] = Array.from(
    new Set([...rowReasons, ...context.exclusions.reasonsFor(key)])
  ).sort((a, b) => a.localeCompare(b));
  if (!reasons.length && context.uploadKeys && !context.uploadKeys.has(key)) {
    reasons.push(EnvironmentGuardReason.NOT_UPLOADED_IN_THIS_ENVIRONMENT);
  }
  if (reasons.length) return { kind: 'skipped', key, reasons };
  return { kind: 'target', target: { key, ...target } };
}

/**
 * Chat media: an image or video on a chat drop (replies and DMs included),
 * whose object no decision entry uses, which was not uploaded as a decision
 * entry, and whose classification is unambiguous.
 */
export function classifyDropMediaRow(
  row: DropMediaCandidateRow,
  context: CandidateContext
): CandidateDecision {
  const key = publicMediaKey(row.url);
  if (!key || !isBackfillScopeKey(key)) {
    return {
      kind: 'out_of_scope',
      reason: OutOfScopeReason.NOT_WAVE_MEDIA_URL
    };
  }
  const kind = mediaKind(row.mime_type ?? '');
  if (!kind) {
    return { kind: 'out_of_scope', reason: OutOfScopeReason.OTHER_MEDIA_TYPE };
  }
  return decide(key, dropMediaRowReasons(row), context, {
    kind,
    source: ChatMediaSource.DROP_MEDIA,
    urls: [row.url],
    inDirectMessage: truthy(row.is_direct_message),
    isReply: !!row.reply_to_drop_id
  });
}

/** Wave pictures are chat media; only `waves/` keys qualify. */
export function classifyWavePictureRow(
  row: WavePictureRow,
  source: ChatMediaSource,
  context: CandidateContext
): CandidateDecision {
  const picture = row.picture?.trim();
  if (!picture) {
    return { kind: 'out_of_scope', reason: OutOfScopeReason.NO_PICTURE };
  }
  const key = publicMediaKey(picture);
  if (!key || !isBackfillScopeKey(key)) {
    return {
      kind: 'out_of_scope',
      reason: OutOfScopeReason.NOT_WAVE_MEDIA_URL
    };
  }
  const rowReasons = key.startsWith('waves/')
    ? []
    : [AmbiguityReason.WAVE_PICTURE_OUTSIDE_WAVES_PREFIX];
  return decide(key, rowReasons, context, {
    kind: 'image',
    source,
    urls: [picture],
    inDirectMessage: truthy(row.is_direct_message),
    isReply: false
  });
}
