import { createHash } from 'node:crypto';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { E2eeBlobS3Client } from '@/e2ee/e2ee-blob-store.s3';

export interface StoredS3Object {
  readonly body: Buffer;
  readonly input: PutObjectCommand['input'];
}

/**
 * In-memory S3 for encrypted attachment tests: Put, Get (404 NoSuchKey when
 * missing), DeleteObjects and HeadBucket on one bucket. It verifies the
 * SHA-256 checksum the way S3 does and records every command.
 */
export class InMemoryE2eeBlobS3 implements E2eeBlobS3Client {
  readonly objects = new Map<string, StoredS3Object>();
  readonly commands: unknown[] = [];
  /** Throw this from the next matching command (once). */
  failNext: { readonly command: string; readonly error: Error } | null = null;

  constructor(readonly bucket: string) {}

  private checkBucket(bucket: string | undefined) {
    if (bucket !== this.bucket) {
      throw Object.assign(new Error('NoSuchBucket'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 }
      });
    }
  }

  private maybeFail(command: string) {
    if (this.failNext?.command === command) {
      const { error } = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async send(command: unknown): Promise<any> {
    this.commands.push(command);
    if (command instanceof PutObjectCommand) {
      this.maybeFail('PutObject');
      this.checkBucket(command.input.Bucket);
      const body = Buffer.from(command.input.Body as Buffer);
      const checksum = createHash('sha256').update(body).digest('base64');
      if (command.input.ChecksumSHA256 !== checksum) {
        throw Object.assign(new Error('BadDigest'), { name: 'BadDigest' });
      }
      this.objects.set(command.input.Key!, { body, input: command.input });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      this.maybeFail('GetObject');
      this.checkBucket(command.input.Bucket);
      const stored = this.objects.get(command.input.Key!);
      if (!stored) {
        throw Object.assign(new Error('NoSuchKey'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 }
        });
      }
      return {
        Body: {
          transformToByteArray: async () => new Uint8Array(stored.body)
        }
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      this.maybeFail('DeleteObjects');
      this.checkBucket(command.input.Bucket);
      for (const object of command.input.Delete?.Objects ?? []) {
        this.objects.delete(object.Key!);
      }
      return { Errors: [] };
    }
    if (command instanceof HeadBucketCommand) {
      this.maybeFail('HeadBucket');
      this.checkBucket(command.input.Bucket);
      return {};
    }
    throw new Error('Unexpected S3 command');
  }
}
