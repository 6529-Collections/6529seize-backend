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
 * The daily dump on its schedule. An invocation whose event names a `job`
 * runs that job instead (the chain exports, invoked by hand); a job no
 * module knows fails, so a typo never runs the daily dump.
 */
export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown, context: Context) => {
    if (event && typeof event === 'object' && 'job' in event) {
      // Loaded only for a job, so the export's modules never touch the dump.
      const { parseProfileSiteExportEvent, runProfileSiteExportJob } =
        await import('./profile-site-export.handler');
      const profileSiteExport = parseProfileSiteExportEvent(event);
      if (profileSiteExport) {
        return await runProfileSiteExportJob(profileSiteExport, context);
      }
      throw new Error(`Unknown dbDumpsDaily job: ${String(event.job)}`);
    }
    await dumpDaily();
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
