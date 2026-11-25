import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NFTDELEGATION_BLOCKS_TABLE } from '@/constants';
import { DB_DUMPS_DAILY_TABLES } from './db-dumps-daily-tables';
import { sqlExecutor } from '../sql-executor';
import { json2csv } from 'json-2-csv';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { doInDbContext } from '../secrets';
import type { Context } from 'aws-lambda';

const logger = Logger.get('DB_DUMPS_DAILY');
const s3 = new S3Client({ region: 'eu-west-1' });

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
      for (const table of DB_DUMPS_DAILY_TABLES) {
        await dumpTable(table);
      }

      const nftDelData = await sqlExecutor.execute(
        `SELECT * FROM ${NFTDELEGATION_BLOCKS_TABLE} ORDER BY block DESC LIMIT 1`
      );
      await dumpData(NFTDELEGATION_BLOCKS_TABLE, nftDelData);
    },
    { logger }
  );
}

async function dumpTable(tableName: string) {
  logger.info(`[TABLE ${tableName}] : [DUMPING...]`);

  const data = await sqlExecutor.execute(`SELECT * FROM ${tableName}`);
  await dumpData(tableName, data);
}

async function dumpData(tableName: string, data: any) {
  const csv = json2csv(data);

  logger.info(
    `[TABLE ${tableName}] : [FOUND ${data.length} ROWS] : [UPLOADING TO S3]`
  );

  const put = await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_6529_IMAGES_BUCKET_NAME!,
      Key: `db-dumps/${process.env.NODE_ENV}/${tableName}.csv`,
      Body: csv,
      ContentType: 'text/csv'
    })
  );

  logger.info(
    `[TABLE ${tableName}] : [UPLOAD STATUS ${put.$metadata.httpStatusCode}]`
  );
}
