/**
 * What kind of identifying metadata a file carries. Only the presence of a
 * category is recorded, never a value.
 */
export enum MetadataCategory {
  GPS = 'gps',
  /** Body, lens or camera serials, unique image IDs and maker notes. */
  SERIAL = 'serial',
  /** Artist, copyright, camera owner and author fields. */
  OWNER_ARTIST = 'owner_artist',
  /** Capture, digitized and modification dates and times. */
  CAPTURE_TIME = 'capture_time',
  /** Embedded preview images (EXIF IFD1, JFIF/JFXX, Photoshop, XMP). */
  THUMBNAIL = 'thumbnail',
  /** XMP packets, including edit history, and IPTC/Photoshop records. */
  XMP_IPTC = 'xmp_iptc',
  /** Camera and lens make and model. */
  CAMERA = 'camera',
  /** Anything else removed: comments, text chunks, software, trailing data. */
  OTHER = 'other'
}

/** How a file without identifying metadata looks, for the report. */
export enum CleanState {
  /** Nothing the strip would remove. */
  NO_METADATA = 'no_metadata',
  /** Only the EXIF Orientation that display depends on. */
  ORIENTATION_ONLY = 'orientation_only',
  /** EXIF with layout/colour tags only (resolution, colour space, size). */
  TECHNICAL_EXIF_ONLY = 'technical_exif_only'
}
