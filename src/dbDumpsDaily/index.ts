import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import {
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  NFTDELEGATION_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { sqlExecutor } from '../sql-executor';
import converter from 'json-2-csv';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { doInDbContext } from '../secrets';

const logger = Logger.get('DB_DUMPS_DAILY');
const s3 = new S3Client({ region: 'eu-west-1' });

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await dumpTable(TRANSACTIONS_TABLE);
      await dumpTable(DELEGATIONS_TABLE);
      await dumpTable(CONSOLIDATIONS_TABLE);

      const nftDelData = await sqlExecutor.execute(
        `SELECT * FROM ${NFTDELEGATION_BLOCKS_TABLE} ORDER BY block DESC LIMIT 1`
      );
      await dumpData(NFTDELEGATION_BLOCKS_TABLE, nftDelData);
    },
    { logger }
  );
});

async function dumpTable(tableName: string) {
  logger.info(`[TABLE ${tableName}] : [DUMPING...]`);

  const data = await sqlExecutor.execute(`SELECT * FROM ${tableName}`);
  await dumpData(tableName, data);
}

async function dumpData(tableName: string, data: any) {
  const csv = await converter.json2csvAsync(data);

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
