import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { getPublishedDropMediaMimeType } from '@/drops/drop-media-upload.config';
import {
  dropMediaUploadsDb,
  DropMediaUploadsDb
} from '@/drops/drop-media-uploads.db';
import {
  DropMediaUploadEntity,
  DropMediaUploadStatus
} from '@/entities/IDropMediaUpload';
import { Logger } from '@/logging';

const logger = Logger.get('DROP_MEDIA_UPLOAD_REFS');

const ATTACHABLE_STATUSES: ReadonlySet<string> = new Set([
  DropMediaUploadStatus.PROCESSING,
  DropMediaUploadStatus.SANITIZING,
  DropMediaUploadStatus.READY
]);

interface MediaUploadRequest {
  readonly parts: ReadonlyArray<{
    readonly media?: ReadonlyArray<{
      readonly media_upload_id?: string | null;
    }> | null;
  }>;
}

function attachable(
  upload: DropMediaUploadEntity | null,
  media: { url: string; mime_type: string },
  model: CreateOrUpdateDropModel,
  publishedDropId: string | null
): boolean {
  if (!upload) return false;
  const mimeType =
    media.mime_type === 'image/jpg' ? 'image/jpeg' : media.mime_type;
  const sameMedia =
    upload.public_url === media.url &&
    upload.profile_id === model.author_id &&
    getPublishedDropMediaMimeType(upload.declared_mime_type) === mimeType;
  if (publishedDropId !== null) {
    // A replay of a request that already published. That attempt attached
    // exactly the ids it kept, in the same transaction, so this reproduces
    // its decision whatever the upload's status has become since. A replay
    // only compares fingerprints; it never writes.
    return sameMedia && upload.drop_id === publishedDropId;
  }
  return (
    sameMedia &&
    ATTACHABLE_STATUSES.has(upload.status) &&
    (upload.drop_id === null || upload.drop_id === model.drop_id) &&
    (upload.wave_id === null || upload.wave_id === model.wave_id)
  );
}

/**
 * Carries a media item's `media_upload_id` from an API drop request onto the
 * write model (waves R11-2), so the drop's media links to its upload's layout
 * hints and status.
 *
 * Only an upload that is the author's, for this exact URL and type, and not
 * attached to another drop is kept; the create path verifies these again.
 * Anything else is dropped, as every id was before, so no request that
 * posts today starts failing (proxy uploads, for example, stay unlinked).
 *
 * `publishedDropId` is the drop an earlier attempt of the same request
 * published (a moderation replay). The ids resolve exactly as that attempt
 * resolved them, so the replay's fingerprint, which covers the model, still
 * matches.
 *
 * Request and model media line up by position: the API mappers map parts
 * and media one to one, in order.
 */
export async function withOwnedMediaUploadIds(
  model: CreateOrUpdateDropModel,
  request: MediaUploadRequest,
  { publishedDropId = null }: { publishedDropId?: string | null } = {},
  db: Pick<DropMediaUploadsDb, 'findById'> = dropMediaUploadsDb
): Promise<CreateOrUpdateDropModel> {
  const ids = Array.from(
    new Set(
      (request.parts ?? [])
        .flatMap((part) => part.media ?? [])
        .map((media) => media.media_upload_id)
        .filter((id): id is string => !!id)
    )
  );
  if (!ids.length) {
    return model;
  }
  const requested = model.parts.map((part, partIndex) =>
    part.media.map(
      (_, mediaIndex) =>
        request.parts[partIndex]?.media?.[mediaIndex]?.media_upload_id ?? null
    )
  );
  let uploads: Map<string, DropMediaUploadEntity | null>;
  try {
    uploads = new Map(
      await Promise.all(
        ids.map(async (id) => [id, await db.findById(id)] as const)
      )
    );
  } catch (error) {
    // Linking is an extra: without it the drop posts exactly as before.
    logger.warn(
      `Could not look up media uploads for a drop: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return model;
  }
  return {
    ...model,
    parts: model.parts.map((part, partIndex) => ({
      ...part,
      media: part.media.map((media, mediaIndex) => {
        const id = requested[partIndex][mediaIndex];
        const keep =
          !!id &&
          attachable(uploads.get(id) ?? null, media, model, publishedDropId);
        return { ...media, media_upload_id: keep ? id : null };
      })
    }))
  };
}
