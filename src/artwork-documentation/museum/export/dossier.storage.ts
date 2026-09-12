import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  artworkArchiveBucket,
  getArtworkArchiveS3
} from '../../assets/artwork-assets.config';
import { DossierExportRow } from './dossier.types';

const PART_BYTES = 16 * 1024 * 1024;
const key = (id: string) => `exports/${id}/artwork-dossier.tar`;
async function* parts(
  source: AsyncIterable<Uint8Array>
): AsyncGenerator<Buffer> {
  let buffer = Buffer.allocUnsafe(PART_BYTES);
  let used = 0;
  for await (const value of source) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(PART_BYTES - used, bytes.length - offset);
      bytes.copy(buffer, used, offset, offset + length);
      used += length;
      offset += length;
      if (used === PART_BYTES) {
        yield buffer;
        buffer = Buffer.allocUnsafe(PART_BYTES);
        used = 0;
      }
    }
  }
  if (used) yield buffer.subarray(0, used);
}

export class DossierStorage {
  constructor(private readonly client: () => S3Client = getArtworkArchiveS3) {}

  async upload(
    id: string,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal
  ) {
    const s3 = this.client();
    const target = { Bucket: artworkArchiveBucket(), Key: key(id) };
    const started = await s3.send(
      new CreateMultipartUploadCommand({
        ...target,
        ContentType: 'application/octet-stream',
        ContentDisposition: 'attachment; filename="artwork-dossier.tar"',
        CacheControl: 'private, no-store',
        ServerSideEncryption: 'AES256'
      }),
      { abortSignal: signal }
    );
    if (!started.UploadId) throw new Error('Dossier upload did not start');
    const targetUpload = { ...target, UploadId: started.UploadId };
    const uploaded: { ETag: string; PartNumber: number }[] = [];
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const body of parts(source)) {
        if (signal.aborted) throw new Error('Dossier export timed out');
        hash.update(body);
        size += body.length;
        if (uploaded.length >= 10000)
          throw new Error('Dossier exceeds archive capacity');
        const partNumber = uploaded.length + 1;
        const result = await s3.send(
          new UploadPartCommand({
            ...targetUpload,
            PartNumber: partNumber,
            Body: body,
            ContentLength: body.length
          }),
          { abortSignal: signal }
        );
        if (!result.ETag)
          throw new Error('Dossier upload part missing receipt');
        uploaded.push({ ETag: result.ETag, PartNumber: partNumber });
      }
      const completed = await s3.send(
        new CompleteMultipartUploadCommand({
          ...targetUpload,
          MultipartUpload: { Parts: uploaded }
        }),
        { abortSignal: signal }
      );
      if (!completed.VersionId)
        throw new Error('Dossier must have an immutable object version');
      return {
        object_version: completed.VersionId,
        sha256: hash.digest('hex'),
        size_bytes: size
      };
    } catch (error) {
      await s3
        .send(new AbortMultipartUploadCommand(targetUpload))
        .catch(() => undefined);
      throw error;
    }
  }

  async readReport(
    bucket: string,
    objectKey: string,
    signal: AbortSignal
  ): Promise<Readable> {
    const response = await this.client().send(
      new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
      { abortSignal: signal }
    );
    if (!(response.Body instanceof Readable))
      throw new Error('Dossier report is unavailable');
    return response.Body;
  }

  async download(row: DossierExportRow): Promise<string> {
    if (!row.object_version) throw new Error('Dossier version is unavailable');
    return getSignedUrl(
      this.client(),
      new GetObjectCommand({
        Bucket: artworkArchiveBucket(),
        Key: key(row.id),
        VersionId: row.object_version,
        ResponseContentType: 'application/octet-stream',
        ResponseContentDisposition:
          'attachment; filename="artwork-dossier.tar"',
        ResponseCacheControl: 'private, no-store'
      }),
      { expiresIn: 60 }
    );
  }
}
export const dossierStorage = new DossierStorage();
