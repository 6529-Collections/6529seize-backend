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
import {
  DumpSource,
  readChainTables,
  readTransactions,
  TableRead
} from './db-dumps-sources';

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

type ManifestEntry =
  | (DumpedFile & { readonly source: DumpSource })
  | { readonly table: string; readonly key: string; readonly skipped: string };

/**
 * FEATURE_DB_DUMPS_MANIFEST: dumps delegations and consolidations first, read
 * with the identity mirror's state in one snapshot, then the transactions and
 * the latest NFTDelegation block, then writes manifest.json beside the CSVs:
 * each file's row count, SHA-256 and source, so a reader can check them
 * against Ethereum and the 6529 chain. A skipped table keeps its previous
 * file and has an entry that says so. The manifest goes up last, so a run
 * that fails part way leaves the previous manifest, whose hashes then show
 * which files changed since.
 */
async function dumpWithManifest() {
  const now = Time.currentMillis();
  const files: ManifestEntry[] = [];
  const reads: TableRead[] = [
    ...(await readChainTables(now)),
    await readTransactions()
  ];
  for (const read of reads) {
    if ('skip' in read) {
      logger.warn(`[TABLE ${read.table}] : [SKIPPED] : [${read.skip}]`);
      files.push({
        table: read.table,
        key: objectKey(`${read.table}.csv`),
        skipped: read.skip
      });
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
