import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { getArtworkArchiveS3 } from '@/artwork-documentation/assets/artwork-assets.config';
import {
  ARTWORK_UPLOAD_POLICY,
  expectedPartSize
} from '@/artwork-documentation/assets/artwork-assets.policy';
import {
  AssetPart,
  CompletedAssetPart,
  ReceivedAssetPart,
  StoredAsset
} from '@/artwork-documentation/assets/artwork-assets.types';

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    ['NoSuchKey', 'NotFound', 'NoSuchUpload', 'NoSuchVersion'].includes(
      error.name
    )
  );
}
export class ArtworkAssetStorage {
  constructor(
    private readonly s3Getter: () => S3Client = getArtworkArchiveS3
  ) {}
  async create(asset: StoredAsset): Promise<string> {
    const result = await this.s3Getter().send(
      new CreateMultipartUploadCommand({
        Bucket: asset.bucket,
        Key: asset.object_key,
        ContentType: 'application/octet-stream',
        ContentDisposition: 'attachment',
        CacheControl: 'private, no-store',
        ServerSideEncryption: 'AES256',
        ChecksumAlgorithm: 'SHA256',
        Metadata: { 'artwork-asset-id': asset.id }
      })
    );
    if (!result.UploadId)
      throw new Error('Archive upload did not return an upload ID');
    return result.UploadId;
  }
  async signPart(asset: StoredAsset, part: AssetPart): Promise<string> {
    return getSignedUrl(
      this.s3Getter(),
      new UploadPartCommand({
        Bucket: asset.bucket,
        Key: asset.object_key,
        UploadId: asset.multipart_id!,
        PartNumber: part.part_number,
        ContentLength: expectedPartSize(part.part_number, asset.size_bytes),
        ChecksumSHA256: part.checksum_sha256
      }),
      {
        expiresIn: ARTWORK_UPLOAD_POLICY.part_url_seconds,
        unhoistableHeaders: new Set(['x-amz-checksum-sha256'])
      }
    );
  }
  async parts(asset: StoredAsset): Promise<ReceivedAssetPart[]> {
    if (!asset.multipart_id) return [];
    try {
      const result = await this.s3Getter().send(
        new ListPartsCommand({
          Bucket: asset.bucket,
          Key: asset.object_key,
          UploadId: asset.multipart_id,
          MaxParts: 1000
        })
      );
      if (result.IsTruncated)
        throw new Error('Archive part count exceeds policy');
      return (result.Parts ?? []).map((part) => ({
        part_number: part.PartNumber!,
        etag: part.ETag!,
        checksum_sha256: part.ChecksumSHA256 ?? '',
        size_bytes: part.Size ?? 0
      }));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
  async complete(
    asset: StoredAsset,
    parts: CompletedAssetPart[]
  ): Promise<{ size: number; version: string }> {
    // Recover a response lost after S3 committed completion. UUID object keys are single-use.
    const existing = await this.head(asset);
    if (existing) return existing;
    await this.s3Getter().send(
      new CompleteMultipartUploadCommand({
        Bucket: asset.bucket,
        Key: asset.object_key,
        UploadId: asset.multipart_id!,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.part_number,
            ETag: part.etag,
            ChecksumSHA256: part.checksum_sha256
          }))
        }
      })
    );
    const head = await this.head(asset);
    if (!head)
      throw new Error('Archive upload completed without a readable object');
    return head;
  }
  async head(
    asset: StoredAsset
  ): Promise<{ size: number; version: string } | null> {
    try {
      const result = await this.s3Getter().send(
        new HeadObjectCommand({
          Bucket: asset.bucket,
          Key: asset.object_key,
          ...(asset.object_version ? { VersionId: asset.object_version } : {})
        })
      );
      if (
        !result.VersionId ||
        result.Metadata?.['artwork-asset-id'] !== asset.id ||
        result.ContentLength === undefined
      )
        throw new Error('Archive object version or identity missing');
      return { size: result.ContentLength, version: result.VersionId };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  async cancel(asset: StoredAsset): Promise<void> {
    if (asset.multipart_id) {
      try {
        await this.s3Getter().send(
          new AbortMultipartUploadCommand({
            Bucket: asset.bucket,
            Key: asset.object_key,
            UploadId: asset.multipart_id
          })
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    const object = await this.head(asset);
    if (object)
      await this.s3Getter().send(
        new DeleteObjectCommand({
          Bucket: asset.bucket,
          Key: asset.object_key,
          VersionId: object.version
        })
      );
    if (asset.preview_key)
      await this.s3Getter().send(
        new DeleteObjectCommand({
          Bucket: asset.bucket,
          Key: asset.preview_key
        })
      );
  }
  async scanStatus(asset: StoredAsset): Promise<string | null> {
    const result = await this.s3Getter().send(
      new GetObjectTaggingCommand({
        Bucket: asset.bucket,
        Key: asset.object_key,
        VersionId: asset.object_version!
      })
    );
    return (
      result.TagSet?.find((tag) => tag.Key === 'GuardDutyMalwareScanStatus')
        ?.Value ?? null
    );
  }
  async read(asset: StoredAsset, signal: AbortSignal): Promise<Readable> {
    const result = await this.s3Getter().send(
      new GetObjectCommand({
        Bucket: asset.bucket,
        Key: asset.object_key,
        VersionId: asset.object_version!
      }),
      { abortSignal: signal }
    );
    if (!(result.Body instanceof Readable))
      throw new Error('Archive object body is not a stream');
    return result.Body;
  }
  async putPreview(asset: StoredAsset, bytes: Buffer): Promise<string> {
    const key = `previews/${asset.id}.jpg`;
    await this.s3Getter().send(
      new PutObjectCommand({
        Bucket: asset.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'image/jpeg',
        CacheControl: 'private, no-store',
        ServerSideEncryption: 'AES256'
      })
    );
    return key;
  }
  async download(asset: StoredAsset, preview: boolean): Promise<string> {
    // The API also returns nosniff/no-store. S3 originals are octet-stream attachments, never an active same-origin renderer.
    const filename = encodeURIComponent(asset.filename).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return getSignedUrl(
      this.s3Getter(),
      new GetObjectCommand({
        Bucket: asset.bucket,
        Key: preview ? asset.preview_key! : asset.object_key,
        ...(!preview ? { VersionId: asset.object_version! } : {}),
        ResponseCacheControl: 'private, no-store',
        ResponseContentType: preview
          ? 'image/jpeg'
          : 'application/octet-stream',
        ResponseContentDisposition: preview
          ? 'inline'
          : `attachment; filename="artwork-file"; filename*=UTF-8''${filename}`
      }),
      { expiresIn: ARTWORK_UPLOAD_POLICY.download_url_seconds }
    );
  }
}
export const artworkAssetStorage = new ArtworkAssetStorage();
