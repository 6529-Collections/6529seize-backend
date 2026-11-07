import { ApiDropMedia } from '@/api/generated/models/ApiDropMedia';
import { DropMediaEntity } from '@/entities/IDrop';

/**
 * Layout hints for API drop media (waves R11-2). Fields are present only
 * when known, so payloads for media without hints stay as they were.
 */
export function dropMediaLayoutHints(
  media: Pick<
    DropMediaEntity,
    'media_width' | 'media_height' | 'media_thumbhash'
  >
): Pick<ApiDropMedia, 'width' | 'height' | 'thumbhash'> {
  const width = Number(media.media_width);
  const height = Number(media.media_height);
  return {
    ...(media.media_width != null &&
    media.media_height != null &&
    width > 0 &&
    height > 0
      ? { width, height }
      : {}),
    ...(media.media_thumbhash ? { thumbhash: media.media_thumbhash } : {})
  };
}
