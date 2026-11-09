import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLOUDFRONT_DISTRIBUTION } from '@/constants';
import {
  getDropMediaIngestS3,
  getDropMediaIngestS3Bucket,
  getDropMediaIngestStagePrefix
} from '@/drops/drop-media-upload.config';
import { prepEnvironment } from '@/env';
import { Logger } from '@/logging';
import { getS3 } from '@/s3.client';
import { doInDbContext } from '@/secrets';
import { BackfillOriginals } from './backfill-originals';
import { BackfillReport } from './backfill-report';
import {
  assertSafetyLocation,
  MediaObjectStore,
  newRunId,
  S3MediaObjectStore,
  SafetyCopyLayout
} from './backfill-storage';
import { CloudFrontInvalidator, InvalidationQueue } from './cdn-invalidation';
import {
  BACKFILL_USAGE,
  BackfillCliOptions,
  parseBackfillArgs,
  ScanCliOptions
} from './chat-media-backfill.options';
import { chatMediaBackfillDb } from './chat-media-backfill.db';
import { ChatMediaObjectProcessor } from './chat-media-object-processor';
import { ChatMediaScan } from './chat-media-scan';
import { DecisionEntryExclusions } from './decision-entry-exclusions';

const logger = Logger.get('CHAT_MEDIA_BACKFILL');
const EXCLUSION_REFRESH_MILLIS = 60_000;

function publicBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is not configured');
  return bucket;
}

/** The configuration loaded for NODE_ENV must be the environment named on the command line. */
function assertEnvironment(options: BackfillCliOptions): string {
  const stage = getDropMediaIngestStagePrefix();
  if (stage !== options.environment) {
    throw new Error(
      `--environment ${options.environment} does not match the loaded configuration (${stage})`
    );
  }
  if (options.execute && stage === 'local') {
    throw new Error(
      'Writes are refused for local: the public bucket is shared with deployed environments'
    );
  }
  return stage;
}

function safetyStore(): MediaObjectStore {
  return new S3MediaObjectStore(
    getDropMediaIngestS3(),
    getDropMediaIngestS3Bucket()
  );
}

function writeReport(
  options: BackfillCliOptions,
  runId: string,
  report: unknown
) {
  const path = resolve(
    options.reportPath ?? `drop-media-backfill-${options.command}-${runId}.json`
  );
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  logger.info(`Report written to ${path}`);
}

async function runScan(options: ScanCliOptions): Promise<void> {
  const stage = assertEnvironment(options);
  const publicStore = new S3MediaObjectStore(getS3(), publicBucket());
  const runId = options.runId ?? newRunId(new Date());
  const report = new BackfillReport(
    runId,
    'scan',
    options.execute ? 'execute' : 'dry-run',
    stage,
    {
      limit: options.limit,
      sample: options.sample,
      concurrency: options.concurrency,
      page_size: options.pageSize,
      resume_after: options.resumeAfter,
      probe_videos: options.probeVideos
    },
    new Date()
  );
  report.publicBucket = {
    name: publicStore.bucket,
    versioning: await publicStore.versioningStatus()
  };
  let invalidations: InvalidationQueue | null = null;
  let writer: ConstructorParameters<
    typeof ChatMediaObjectProcessor
  >[0]['writer'] = null;
  if (options.execute) {
    const safety = safetyStore();
    const layout = new SafetyCopyLayout(stage, runId);
    await assertSafetyLocation(safety, publicStore, layout);
    const queue = new InvalidationQueue(
      new CloudFrontInvalidator(CLOUDFRONT_DISTRIBUTION)
    );
    invalidations = queue;
    writer = {
      safetyStore: safety,
      layout,
      onRewritten: (paths) => queue.add(paths)
    };
    report.safetyCopyPrefix = `s3://${safety.bucket}/${layout.runPrefix}`;
  }
  const exclusions = new DecisionEntryExclusions(chatMediaBackfillDb);
  await exclusions.build({ collectUploadKeys: stage !== 'prod' });
  report.exclusionStats = exclusions.stats;
  const scan = new ChatMediaScan(
    {
      db: chatMediaBackfillDb,
      exclusions,
      processor: new ChatMediaObjectProcessor({
        publicStore,
        writer,
        runId,
        now: () => new Date()
      }),
      publicStore,
      invalidations,
      report,
      random: Math.random,
      now: Date.now
    },
    { ...options, exclusionRefreshMillis: EXCLUSION_REFRESH_MILLIS }
  );
  let completed = false;
  try {
    completed = await scan.run();
  } finally {
    await invalidations?.flush();
    report.finish(new Date(), completed);
    writeReport(options, runId, report);
  }
}

async function runOriginalsCommand(
  options: Exclude<BackfillCliOptions, ScanCliOptions>
): Promise<void> {
  await prepEnvironment();
  const stage = assertEnvironment(options);
  const publicStore = new S3MediaObjectStore(getS3(), publicBucket());
  const originals = new BackfillOriginals({
    publicStore,
    safetyStore: safetyStore(),
    layout: new SafetyCopyLayout(stage, options.runId),
    execute: options.execute,
    invalidations: options.execute
      ? new InvalidationQueue(
          new CloudFrontInvalidator(CLOUDFRONT_DISTRIBUTION)
        )
      : null,
    now: () => new Date()
  });
  let report;
  if (options.command === 'restore')
    report = await originals.restore(options.key);
  else if (options.command === 'invalidate')
    report = await originals.invalidate();
  else {
    report = await originals.purge({
      olderThanMillis: options.olderThanMillis,
      deleteNoncurrentVersions: options.deleteNoncurrentPublicVersions
    });
  }
  writeReport(options, options.runId, report);
}

async function main(): Promise<void> {
  let options: BackfillCliOptions;
  try {
    options = parseBackfillArgs(process.argv.slice(2));
  } catch (error) {
    logger.error(
      `${error instanceof Error ? error.message : String(error)}\n${BACKFILL_USAGE}`
    );
    process.exit(2);
  }
  logger.info(
    `[${options.command}] [${options.execute ? 'EXECUTE' : 'DRY RUN'}] [${options.environment}]`
  );
  if (options.command === 'scan') {
    const scanOptions = options;
    await doInDbContext(() => runScan(scanOptions), {
      logger,
      skipRedis: true
    });
  } else {
    await runOriginalsCommand(options);
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Drop media metadata backfill failed', error);
    process.exit(1);
  });
}
