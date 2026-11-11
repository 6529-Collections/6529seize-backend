import { ApiDropMedia } from '@/api/generated/models/ApiDropMedia';
import { ApiDropMediaStatus } from '@/api/generated/models/ApiDropMediaStatus';
import { DropMediaEntity } from '@/entities/IDrop';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';
import { dropMediaLayoutHints } from './drop-media-layout-hints';

function mapStatus(status: string | null | undefined): ApiDropMediaStatus {
  switch (status) {
    case ApiDropMediaStatus.Uploading:
      return ApiDropMediaStatus.Uploading;
    case ApiDropMediaStatus.Processing:
    case DropMediaUploadStatus.COMPLETING:
    case DropMediaUploadStatus.SANITIZING:
      return ApiDropMediaStatus.Processing;
    case ApiDropMediaStatus.Failed:
      return ApiDropMediaStatus.Failed;
    default:
      return ApiDropMediaStatus.Ready;
  }
}

/** V1 and V2 expose the same sanitized-media lifecycle and layout hints. */
export function mapDropMedia(media: DropMediaEntity): ApiDropMedia {
  return {
    url: media.url,
    mime_type: media.mime_type,
    media_upload_id: media.media_upload_id,
    media_status: mapStatus(media.media_status),
    media_error: media.media_error ?? null,
    ...dropMediaLayoutHints(media)
  };
}
