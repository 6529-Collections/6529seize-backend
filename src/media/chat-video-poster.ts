export const MAX_DEVICE_POSTER_BYTES = 128 * 1024;
export const MAX_DEVICE_POSTER_BASE64_LENGTH =
  Math.ceil(MAX_DEVICE_POSTER_BYTES / 3) * 4;
export const DEVICE_POSTER_METADATA_KEY = 'chat-video-poster';
export const DEVICE_POSTER_METADATA_VALUE = 'validated-v1';

/** Device posters are only written for the upload service's canonical video keys. */
export function getDeviceVideoPosterKey(key: string): string | undefined {
  if (
    !/^drops\/author_[^/]+\/[0-9a-f-]{36}\/[^/]+$/i.test(key) ||
    !/\.(mp4|mov|avi|webm)$/i.test(key)
  ) {
    return undefined;
  }
  const base = key.replace(/\.[^.]+$/, '');
  const name = base.slice(base.lastIndexOf('/') + 1);
  return `renditions/${base}/poster/${name}_device.jpg`;
}
