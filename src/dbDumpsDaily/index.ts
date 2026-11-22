import { createHash } from 'node:crypto';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NFTDELEGATION_BLOCKS_TABLE } from '@/constants';
import { DB_DUMPS_DAILY_TABLES } from './db-dumps-daily-tables';
import { sqlExecutor } from '../sql-executor';
import { json2csv } from 'json-2-csv';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { doInDbContext } from '../secrets';
import { appFeatures } from '../app-features';
import { Time } from '../time';
import { DumpSource, planDumps } from './db-dumps-sources';

const logger = Logger.get('DB_DUMPS_DAILY');
const s3 = new S3Client({ region: 'eu-west-1' });

interface DumpedFile {
  readonly table: string;
  readonly key: string;
  readonly rows: number;
  readonly sha256: string;
}

export const handler = sentryContext.wrapLambdaHandler(async () => {
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
});

/**
 * FEATURE_DB_DUMPS_MANIFEST: dumps each table whose source is ready, then
 * writes manifest.json beside the CSVs with each file's row count, SHA-256
 * and source, so a reader can check the files against Ethereum and the 6529
 * chain. A skipped table keeps its previous file and is listed as skipped.
 */
async function dumpWithManifest() {
  const now = Time.currentMillis();
  const plans = await planDumps(
    (sql) => sqlExecutor.execute(sql),
    DB_DUMPS_DAILY_TABLES,
    now
  );
  const files: (DumpedFile & { source: DumpSource })[] = [];
  const skipped: { table: string; reason: string }[] = [];
  for (const plan of plans) {
    if ('skip' in plan) {
      logger.warn(`[TABLE ${plan.table}] : [SKIPPED] : [${plan.skip}]`);
      skipped.push({ table: plan.table, reason: plan.skip });
      continue;
    }
    files.push({ ...(await dumpTable(plan.table)), source: plan.source });
  }
  const { file, block } = await dumpLatestNftDelegationBlock();
  files.push({ ...file, source: { kind: 'nftdelegation', last_block: block } });
  await putObject(
    'manifest.json',
    JSON.stringify(
      {
        version: 1,
        generated_at: new Date(now).toISOString(),
        complete: skipped.length === 0,
        files,
        skipped
      },
      null,
      2
    ),
    'application/json'
  );
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

async function putObject(
  name: string,
  body: string,
  contentType: string
): Promise<string> {
  const key = `db-dumps/${process.env.NODE_ENV}/${name}`;
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
