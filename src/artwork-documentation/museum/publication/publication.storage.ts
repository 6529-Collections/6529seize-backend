import { s3UploadObject } from '@/helpers/s3_helpers';

/**
 * Optional immutable copy of a published manifest. No bucket or edge is
 * provisioned here: when ARTWORK_PUBLICATION_BUCKET is unset the manifest is
 * served from the database row only.
 */
export interface PublicationStore {
  /** Returns the stored object key, or null when storage is not configured. */
  store(publication: {
    id: string;
    manifest_sha256: string;
    manifest_json: string;
  }): Promise<string | null>;
}

export const PUBLICATION_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const PUBLICATION_CONTENT_TYPE =
  'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"'; // NOSONAR: IIIF profile identifier, never fetched.
export const publicationObjectKey = (id: string, manifestSha256: string) =>
  `museum/publications/${id}/${manifestSha256}/manifest.json`;

type Uploader = (input: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  txId: string;
  cacheControl?: string;
}) => Promise<unknown>;

export class S3PublicationStorage implements PublicationStore {
  constructor(
    private readonly upload: Uploader = s3UploadObject,
    private readonly bucket: () => string | undefined = () =>
      process.env.ARTWORK_PUBLICATION_BUCKET || undefined
  ) {}

  async store(publication: {
    id: string;
    manifest_sha256: string;
    manifest_json: string;
  }): Promise<string | null> {
    const bucket = this.bucket();
    if (!bucket) return null;
    const key = publicationObjectKey(
      publication.id,
      publication.manifest_sha256
    );
    await this.upload({
      bucket,
      key,
      body: Buffer.from(publication.manifest_json, 'utf8'),
      contentType: PUBLICATION_CONTENT_TYPE,
      txId: publication.manifest_sha256,
      cacheControl: PUBLICATION_CACHE_CONTROL
    });
    return key;
  }
}

export const publicationStorage: PublicationStore = new S3PublicationStorage();
