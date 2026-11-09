import { createHash, Hash } from 'node:crypto';

/** The container cannot be stripped losslessly; callers fall back or reject. */
export class LosslessStripUnsupported extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

export interface ContainerDescription {
  /** Stored (not oriented) size from the container header. */
  readonly width: number;
  readonly height: number;
  /** EXIF orientation 1-8 that decoders apply; 1 when absent. */
  readonly orientation: number;
  /**
   * SHA-256 of every byte a decoder reads to render pixels and colour, in
   * order (image data, tables, palettes, colour profiles, animation control).
   */
  readonly renderDigest: string;
  /** Identifying blocks present, for example `APP1:Exif` or `tEXt`. */
  readonly metadataBlocks: readonly string[];
  /** JPEG HDR gain map images a strip keeps, in file order. */
  readonly gainMaps?: readonly GainMapDescription[];
  /** Why a JPEG HDR gain map in the file cannot be kept. */
  readonly gainMapIssue?: string;
}

export interface GainMapDescription {
  readonly width: number;
  readonly height: number;
  /** See {@link ContainerDescription.renderDigest}. */
  readonly renderDigest: string;
}

export interface StripOptions {
  /** `drop` also removes JPEG gain maps, leaving the SDR base image. */
  readonly gainMaps?: 'keep' | 'drop';
}

export interface FormatMetadataStripper {
  strip(input: Buffer, options?: StripOptions): Buffer;
  describe(input: Buffer): ContainerDescription;
}

/** Hashes the render stream; see {@link ContainerDescription.renderDigest}. */
export function newRenderHash(): Hash {
  return createHash('sha256');
}

export function assertWithin(input: Buffer, end: number, what: string): void {
  if (!Number.isSafeInteger(end) || end > input.length) {
    throw new LosslessStripUnsupported(`Truncated ${what}`);
  }
}
