import { CLOUDFRONT_LINK } from '@/constants';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropMediaUploadsDb } from '@/drops/drop-media-uploads.db';
import { DropType } from '@/entities/IDrop';
import {
  DropMediaUploadEntity,
  DropMediaUploadPurpose
} from '@/entities/IDropMediaUpload';
import { BadRequestException } from '@/exceptions';

/** Upload keys since purposes exist: `drops/<upload record id>/<file>`. */
const DROP_MEDIA_KEY =
  /^drops\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]+$/;

/** Compared as an origin, so a path or trailing slash on the link cannot fail open. */
const MEDIA_ORIGIN = new URL(CLOUDFRONT_LINK).origin;

export const DECISION_ENTRY_MEDIA_MISUSE_MESSAGE =
  'This media was uploaded for a decision entry and can only be attached to a decision entry. Upload it again to post it in chat.';

/** A decision entry is a participatory drop; it is never a reply. */
export function isDecisionEntryDrop(
  model: Pick<CreateOrUpdateDropModel, 'drop_type' | 'reply_to'>
): boolean {
  return model.drop_type === DropType.PARTICIPATORY && !model.reply_to;
}

/**
 * The S3 key a media CDN URL serves, or null for any other URL. Query,
 * fragment and percent-encoding variants of one object resolve to one key.
 */
export function publicMediaKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== MEDIA_ORIGIN) return null;
  try {
    return decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
}

/**
 * The upload record behind a drop media URL, found by primary key from the
 * key's folder. Uploads from before purposes were recorded use a different
 * folder id and resolve to null, as does any URL the record does not serve.
 */
export async function findDropMediaUploadForUrl(
  url: string,
  db: Pick<DropMediaUploadsDb, 'findById'>
): Promise<DropMediaUploadEntity | null> {
  const key = publicMediaKey(url);
  const uploadId = key ? DROP_MEDIA_KEY.exec(key)?.[1] : undefined;
  if (!key || !uploadId) return null;
  const upload = await db.findById(uploadId);
  return upload?.public_key === key ? upload : null;
}

/** Decision-entry media keeps its metadata, so it may not appear elsewhere. */
export function assertDropMediaPurposeAllowed({
  upload,
  isDecisionEntry
}: {
  upload: Pick<DropMediaUploadEntity, 'purpose'> | null;
  isDecisionEntry: boolean;
}): void {
  if (
    !isDecisionEntry &&
    upload?.purpose === DropMediaUploadPurpose.DECISION_ENTRY
  ) {
    throw new BadRequestException(DECISION_ENTRY_MEDIA_MISUSE_MESSAGE);
  }
}
