import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { env } from '@/env';
import {
  MARKET_DEPTH_ARCHIVE_PREFIX,
  MarketDepthArchiveKind,
  MarketDepthArchiveStore
} from './market-depth-archive';

export function marketDepthArchiveStateKey(
  kind: MarketDepthArchiveKind,
  contract: string
): string {
  return `${MARKET_DEPTH_ARCHIVE_PREFIX}/_state/${kind}/contract=${contract.toLowerCase()}.json`;
}

function isMissingObject(error: unknown): boolean {
  return (
    error instanceof NoSuchKey ||
    (error as { name?: unknown } | null)?.name === 'NoSuchKey'
  );
}

export class S3MarketDepthArchiveStore implements MarketDepthArchiveStore {
  constructor(
    private readonly bucket: string,
    private readonly s3: S3Client = new S3Client({
      region: process.env.AWS_REGION ?? 'us-east-1'
    })
  ) {}

  async getArchivedThrough(
    kind: MarketDepthArchiveKind,
    contract: string
  ): Promise<Date | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: marketDepthArchiveStateKey(kind, contract)
        })
      );
      const state = JSON.parse(
        (await response.Body?.transformToString()) ?? '{}'
      ) as { archived_through?: unknown };
      const archivedThrough =
        typeof state.archived_through === 'string'
          ? new Date(state.archived_through)
          : null;
      if (!archivedThrough || Number.isNaN(archivedThrough.getTime())) {
        throw new Error(`Invalid market-depth archive state for ${kind}`);
      }
      return archivedThrough;
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async setArchivedThrough(
    kind: MarketDepthArchiveKind,
    contract: string,
    archivedThrough: Date
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: marketDepthArchiveStateKey(kind, contract),
        Body: JSON.stringify({
          archived_through: archivedThrough.toISOString(),
          updated_at: new Date().toISOString()
        }),
        ContentType: 'application/json'
      })
    );
  }

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: input.metadata,
        ChecksumAlgorithm: 'SHA256'
      })
    );
  }
}

/** Null when this environment does not archive (no bucket configured). */
export function marketDepthArchiveStoreFromEnv(): MarketDepthArchiveStore | null {
  const bucket = env.getStringOrNull('MARKET_DEPTH_ARCHIVE_BUCKET');
  return bucket ? new S3MarketDepthArchiveStore(bucket) : null;
}
