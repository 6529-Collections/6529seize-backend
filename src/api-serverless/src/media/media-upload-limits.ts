/**
 * The documented transport limit for media that is published directly from
 * a multipart upload: video, audio, 3D models and distribution photos
 * ("other media retains the existing 500 MB transport limit"; clients use
 * 500 MiB). Drop and wave images complete into private ingest instead, where
 * the sanitizer enforces the shared 256 MiB image source ceiling.
 */
export const MAX_DIRECT_MULTIPART_MEDIA_BYTES = 500 * 1024 * 1024;
