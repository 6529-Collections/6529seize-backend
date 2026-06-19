import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import {
  CloudFrontClient,
  CreateInvalidationCommand
} from '@aws-sdk/client-cloudfront';
import {
  CLOUDFRONT_DISTRIBUTION,
  CLOUDFRONT_LINK,
  DROP_MEDIA_TABLE
} from '@/constants';
import {
  DROP_MEDIA_CACHE_CONTROL,
  DROP_MEDIA_SANITIZED_METADATA_KEY,
  DROP_MEDIA_SANITIZED_METADATA_VALUE
} from '@/drops/drop-media-upload.config';
import { dropMediaSanitizerService } from '@/drops/drop-media-sanitizer.service';
import { getS3 } from '@/s3.client';
import { doInDbContext } from '@/secrets';
import { sqlExecutor } from '@/sql-executor';
import { Logger } from '@/logging';

type DropMediaBackfillRow = {
  readonly id: string;
  readonly url: string;
  readonly mime_type: string;
};

type BackfillOptions = {
  readonly dryRun: boolean;
  readonly limit: number | null;
  readonly skipInvalidation: boolean;
};

const logger = Logger.get('DROP_MEDIA_SANITIZER_BACKFILL');
const DEFAULT_PAGE_SIZE = 100;
const INVALIDATION_BATCH_SIZE = 1000;

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const report = {
    processed: 0,
    skipped: 0,
    failed: 0,
    invalidated: 0,
    failures: [] as Array<{ id: string; key: string; error: string }>
  };
  const invalidationPaths: string[] = [];
  let lastId = 0;

  await doInDbContext(
    async () => {
      while (options.limit === null || report.processed < options.limit) {
        const rows = await fetchPage(lastId, options.limit, report.processed);
        if (!rows.length) {
          break;
        }
        lastId = Number(rows[rows.length - 1].id);
        for (const row of rows) {
          const key = parseCloudFrontMediaKey(row.url);
          if (!key) {
            report.skipped++;
            continue;
          }
          try {
            const result = await processRow({ row, key, options });
            report[result]++;
            if (result === 'processed') {
              invalidationPaths.push(`/${key}`);
            }
          } catch (error) {
            report.failed++;
            report.failures.push({
              id: row.id,
              key,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      if (
        !options.dryRun &&
        !options.skipInvalidation &&
        invalidationPaths.length
      ) {
        report.invalidated = await invalidatePaths(invalidationPaths);
      }
    },
    { logger }
  );

  logger.info(`Drop media backfill report: ${JSON.stringify(report)}`);
}

async function fetchPage(
  lastId: number,
  limit: number | null,
  processed: number
): Promise<DropMediaBackfillRow[]> {
  const remaining =
    limit === null
      ? DEFAULT_PAGE_SIZE
      : Math.min(DEFAULT_PAGE_SIZE, limit - processed);
  if (remaining <= 0) {
    return [];
  }
  return await sqlExecutor.execute<DropMediaBackfillRow>(
    `select id, url, mime_type
     from ${DROP_MEDIA_TABLE}
     where id > :lastId
       and (
         url like :dropUrlPrefix
         or url like :waveUrlPrefix
       )
       and mime_type in ('image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif')
     order by id asc
     limit :limit`,
    {
      lastId,
      dropUrlPrefix: `${CLOUDFRONT_LINK}/drops/%`,
      waveUrlPrefix: `${CLOUDFRONT_LINK}/waves/%`,
      limit: remaining
    }
  );
}

async function processRow({
  row,
  key,
  options
}: {
  row: DropMediaBackfillRow;
  key: string;
  options: BackfillOptions;
}): Promise<'processed' | 'skipped'> {
  const head = await getS3().send(
    new HeadObjectCommand({
      Bucket: getPublicBucket(),
      Key: key
    })
  );
  if (
    head.Metadata?.[DROP_MEDIA_SANITIZED_METADATA_KEY] ===
    DROP_MEDIA_SANITIZED_METADATA_VALUE
  ) {
    return 'skipped';
  }
  if (options.dryRun) {
    return 'processed';
  }

  const object = await getS3().send(
    new GetObjectCommand({
      Bucket: getPublicBucket(),
      Key: key
    })
  );
  if (!object.Body) {
    throw new Error(`Missing object body for ${key}`);
  }
  const sanitized = await dropMediaSanitizerService.sanitizeBuffer({
    input: Buffer.from(await (object.Body as any).transformToByteArray()),
    declaredMimeType: row.mime_type
  });
  await getS3().send(
    new PutObjectCommand({
      Bucket: getPublicBucket(),
      Key: key,
      Body: sanitized.buffer,
      ContentType: sanitized.contentType,
      CacheControl: DROP_MEDIA_CACHE_CONTROL,
      Metadata: {
        [DROP_MEDIA_SANITIZED_METADATA_KEY]: DROP_MEDIA_SANITIZED_METADATA_VALUE
      }
    })
  );
  return 'processed';
}

function parseCloudFrontMediaKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== getCloudFrontOrigin()) {
    return null;
  }
  const key = parsed.pathname.replace(/^\/+/, '');
  if (!key.startsWith('drops/') && !key.startsWith('waves/')) {
    return null;
  }
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function getCloudFrontOrigin(): string {
  return new URL(CLOUDFRONT_LINK).origin;
}

async function invalidatePaths(paths: string[]): Promise<number> {
  const cloudFront = new CloudFrontClient({ region: 'us-east-1' });
  let invalidated = 0;
  for (let i = 0; i < paths.length; i += INVALIDATION_BATCH_SIZE) {
    const batch = paths.slice(i, i + INVALIDATION_BATCH_SIZE);
    await cloudFront.send(
      new CreateInvalidationCommand({
        DistributionId: CLOUDFRONT_DISTRIBUTION,
        InvalidationBatch: {
          CallerReference: `drop-media-sanitizer-${Date.now()}-${i}`,
          Paths: {
            Quantity: batch.length,
            Items: batch
          }
        }
      })
    );
    invalidated += batch.length;
  }
  return invalidated;
}

function parseOptions(args: string[]): BackfillOptions {
  const dryRun = !args.includes('--live');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const parsedLimit = limitArg ? Number(limitArg.split('=')[1]) : null;
  const limit =
    parsedLimit !== null && Number.isInteger(parsedLimit) && parsedLimit > 0
      ? parsedLimit
      : null;
  return {
    dryRun,
    limit,
    skipInvalidation: args.includes('--skip-invalidation')
  };
}

function getPublicBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error('S3_BUCKET is not configured');
  }
  return bucket;
}

void main().catch((error) => {
  logger.error('Drop media backfill failed', error);
  process.exit(1);
});
