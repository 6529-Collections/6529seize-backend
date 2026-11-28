import { createHash } from 'node:crypto';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NFTDELEGATION_BLOCKS_TABLE } from '@/constants';
import { DB_DUMPS_DAILY_TABLES } from './db-dumps-daily-tables';
import { sqlExecutor } from '../sql-executor';
import { json2csv } from 'json-2-csv';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { doInDbContext } from '../secrets';
import { appFeatures } from '../app-features';
import { Time } from '../time';
import {
  DumpSource,
  readChainTables,
  readTransactions,
  TableRead
} from './db-dumps-sources';
import type { Context } from 'aws-lambda';

const logger = Logger.get('DB_DUMPS_DAILY');
const s3 = new S3Client({ region: 'eu-west-1' });

interface DumpedFile {
  readonly table: string;
  readonly key: string;
  readonly rows: number;
  readonly sha256: string;
}

/**
 * The daily dump runs for its schedule's event (source aws.events) or an
 * empty event. An event naming a `job` runs that job (the chain exports,
 * invoked by hand). Anything else fails, so a misspelled job never runs
 * the dump.
 */
export function isDailyDumpEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return false;
  }
  const record = event as Record<string, unknown>;
  return (
    Object.keys(record).length === 0 ||
    (record.source === 'aws.events' && !('job' in record))
  );
}

export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown, context: Context) => {
    if (isDailyDumpEvent(event)) {
      await dumpDaily();
      return;
    }
    // Loaded only for a job, so the export's modules never touch the dump.
    const { parseIdentityExportEvent, runIdentityExportJob } =
      await import('./identity-export.handler');
    const identityExport = parseIdentityExportEvent(event);
    if (identityExport) {
      return await runIdentityExportJob(identityExport, context);
    }
    const { parseProfileSiteExportEvent, runProfileSiteExportJob } =
      await import('./profile-site-export.handler');
    const profileSiteExport = parseProfileSiteExportEvent(event);
    if (profileSiteExport) {
      return await runProfileSiteExportJob(profileSiteExport, context);
    }
    const {
      parseWavesExportEvent,
      parseWavesExportUploadLinkEvent,
      runWavesExportJob,
      runWavesExportUploadLink
    } = await import('./waves-export.handler');
    const uploadLink = parseWavesExportUploadLinkEvent(event);
    if (uploadLink) {
      return await runWavesExportUploadLink(uploadLink, context);
    }
    const wavesExport = parseWavesExportEvent(event);
    if (wavesExport) {
      return await runWavesExportJob(wavesExport, context);
    }
    const job =
      event && typeof event === 'object' && 'job' in event
        ? String((event as { job: unknown }).job)
        : 'none';
    throw new Error(
      `Not a dbDumpsDaily event: unknown job ${job}. The daily dump runs only for its schedule or an empty event.`
    );
  }
);

async function dumpDaily() {
  await doInDbContext(
    async () => {
      if (appFeatures.isDbDumpsManifestEnabled()) {
        await dumpWithManifest();
        return;
      }
      for (const table of DB_DUMPS_DAILY_TABLES) {
        await dumpTable(table);
      }
      await dumpLatestNftDelegationBlock();
    },
    { logger }
  );
}

type DumpedEntry = DumpedFile & { readonly source: DumpSource };

type ManifestEntry =
  | DumpedEntry
  /** A skipped file whose CSV an earlier run wrote, as that run described it. */
  | (DumpedEntry & { readonly generated_at: string; readonly skipped: string })
  /** A skipped file that no manifest has described. */
  | { readonly table: string; readonly key: string; readonly skipped: string };

interface Manifest {
  readonly version: number;
  readonly generated_at: string;
  readonly complete: boolean;
  readonly files: ManifestEntry[];
}

/**
 * FEATURE_DB_DUMPS_MANIFEST: dumps delegations and consolidations first, read
 * with the identity mirror's state in one snapshot, then the transactions and
 * the latest NFTDelegation block, then writes manifest.json beside the CSVs:
 * each file's row count, SHA-256 and source, so a reader can check them
 * against Ethereum and the 6529 chain. A skipped table keeps its previous
 * file, and its entry says why and carries that file's hash, rows, source
 * and time forward from the previous manifest. The manifest goes up last,
 * so a run that fails part way leaves the previous manifest, whose hashes
 * then show which files changed since.
 */
async function dumpWithManifest() {
  const now = Time.currentMillis();
  const previous = await readPreviousManifest();
  const files: ManifestEntry[] = [];
  const reads: TableRead[] = [
    ...(await readChainTables(now)),
    await readTransactions()
  ];
  for (const read of reads) {
    if ('skip' in read) {
      logger.warn(`[TABLE ${read.table}] : [SKIPPED] : [${read.skip}]`);
      files.push(await skippedEntry(read.table, read.skip, previous));
      continue;
    }
    files.push({
      ...(await dumpData(read.table, read.rows)),
      source: read.source
    });
  }
  const { file, block } = await dumpLatestNftDelegationBlock();
  files.push({ ...file, source: { kind: 'nftdelegation', last_block: block } });
  await putObject(
    'manifest.json',
    JSON.stringify(
      {
        version: 1,
        generated_at: new Date(now).toISOString(),
        complete: files.every((entry) => !('skipped' in entry)),
        files
      },
      null,
      2
    ),
    'application/json'
  );
}

/**
 * A skipped table's entry. Its CSV is the one the previous manifest
 * described (directly, or carried forward itself), so that description
 * stays, with the time that file was written. If the CSV was written after
 * that manifest went up (a run with the flag off, or by hand), the
 * description no longer fits it, and the entry says only why it was skipped.
 */
async function skippedEntry(
  table: string,
  skipped: string,
  previous: PreviousManifest | null
): Promise<ManifestEntry> {
  const key = objectKey(`${table}.csv`);
  const earlier = previous?.manifest.files.find(
    (entry): entry is DumpedEntry =>
      entry.table === table && entry.key === key && 'sha256' in entry
  );
  if (!earlier) return { table, key, skipped };
  const written = await lastModified(key);
  if (!written || !previous!.lastModified || written > previous!.lastModified) {
    logger.warn(
      `[TABLE ${table}] : [CSV CHANGED SINCE THE PREVIOUS MANIFEST] : [NOT CARRIED]`
    );
    return { table, key, skipped };
  }
  return {
    table,
    key,
    rows: earlier.rows,
    sha256: earlier.sha256,
    source: earlier.source,
    generated_at:
      'generated_at' in earlier
        ? String(earlier.generated_at)
        : previous!.manifest.generated_at,
    skipped
  };
}

/** When the object was last written, or null when it is missing. */
async function lastModified(key: string): Promise<Date | null> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: process.env.AWS_6529_IMAGES_BUCKET_NAME!,
        Key: key
      })
    );
    return head.LastModified ?? null;
  } catch (error: any) {
    if (error?.name !== 'NotFound' && error?.name !== 'NoSuchKey')
      logger.warn(`[${key}] : [UNREADABLE] : [${error?.message ?? error}]`);
    return null;
  }
}

interface PreviousManifest {
  readonly manifest: Manifest;
  /** When it went up; every CSV it describes was written before. */
  readonly lastModified: Date | null;
}

/** The manifest the last run wrote, or null when there is none to read. */
async function readPreviousManifest(): Promise<PreviousManifest | null> {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.AWS_6529_IMAGES_BUCKET_NAME!,
        Key: objectKey('manifest.json')
      })
    );
    const body = await response.Body?.transformToString();
    const manifest = body ? JSON.parse(body) : null;
    return Array.isArray(manifest?.files)
      ? { manifest, lastModified: response.LastModified ?? null }
      : null;
  } catch (error: any) {
    if (error?.name !== 'NoSuchKey')
      logger.warn(
        `[MANIFEST] : [PREVIOUS UNREADABLE] : [${error?.message ?? error}]`
      );
    return null;
  }
}

async function dumpTable(tableName: string): Promise<DumpedFile> {
  logger.info(`[TABLE ${tableName}] : [DUMPING...]`);

  const data = await sqlExecutor.execute(`SELECT * FROM ${tableName}`);
  return await dumpData(tableName, data);
}

/** The last NFTDelegation block read; after the identity freeze, read but not applied. */
async function dumpLatestNftDelegationBlock(): Promise<{
  file: DumpedFile;
  block: number | null;
}> {
  const nftDelData = await sqlExecutor.execute(
    `SELECT * FROM ${NFTDELEGATION_BLOCKS_TABLE} ORDER BY block DESC LIMIT 1`
  );
  const block = nftDelData[0]?.block;
  return {
    file: await dumpData(NFTDELEGATION_BLOCKS_TABLE, nftDelData),
    block: block === undefined || block === null ? null : Number(block)
  };
}

async function dumpData(tableName: string, data: any): Promise<DumpedFile> {
  const csv = json2csv(data);

  logger.info(
    `[TABLE ${tableName}] : [FOUND ${data.length} ROWS] : [UPLOADING TO S3]`
  );

  const key = await putObject(`${tableName}.csv`, csv, 'text/csv');
  return {
    table: tableName,
    key,
    rows: data.length,
    sha256: createHash('sha256').update(csv).digest('hex')
  };
}

function objectKey(name: string): string {
  return `db-dumps/${process.env.NODE_ENV}/${name}`;
}

async function putObject(
  name: string,
  body: string,
  contentType: string
): Promise<string> {
  const key = objectKey(name);
  const put = await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_6529_IMAGES_BUCKET_NAME!,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );

  logger.info(`[${name}] : [UPLOAD STATUS ${put.$metadata.httpStatusCode}]`);
  return key;
}
