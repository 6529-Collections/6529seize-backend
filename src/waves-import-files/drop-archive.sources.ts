import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ChainGatewayClient,
  chainGatewayConfigFromEnv
} from '@/chain-gateway/chain-gateway.client';
import { DROPS_PARTS_TABLE, DROPS_TABLE } from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import {
  DropArchiveChain,
  DropArchiveFiles,
  DropArchiveWriter
} from '@/waves-import-files/drop-archive.reader';
import {
  DROP_ROW_COLUMNS,
  PART_ROW_COLUMNS
} from '@/waves-import-files/drop-archive.rows';

/**
 * Where the reader's inputs live: a content-addressed files source (the
 * rebuild check's, or any server of the same ids) and the chain gateway.
 *
 * File ids:
 * - `waves-v1`: the Waves v1 file the chain imported;
 * - `drop-archives`: the snapshot tooling's archives/index.json;
 * - `drop-archive-<wave id, 64 hex>`: each archive (the tooling's
 *   archives/<wave id>.jsonl).
 */
export const DROP_ARCHIVE_FILE_IDS = {
  wavesFile: 'waves-v1',
  index: 'drop-archives',
  archive: (waveId: string) => `drop-archive-${waveId.replace(/^0x/, '')}`
} as const;

/** The largest file the reader takes: above the largest archive, 395 MB. */
const MAX_FILE_BYTES = 1_500_000_000;

async function fetchFile(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Reading ${url} answered ${response.status}`);
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_FILE_BYTES) {
    throw new Error(`${url} has ${length} bytes, more than the reader takes`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** The files source at `baseUrl`, by the ids above. */
export function httpDropArchiveFiles(baseUrl: string): DropArchiveFiles {
  const base = baseUrl.replace(/\/$/, '');
  return {
    wavesFile: () => fetchFile(`${base}/${DROP_ARCHIVE_FILE_IDS.wavesFile}`),
    archiveIndex: () => fetchFile(`${base}/${DROP_ARCHIVE_FILE_IDS.index}`),
    archive: (waveId) =>
      fetchFile(`${base}/${DROP_ARCHIVE_FILE_IDS.archive(waveId)}`)
  };
}

/**
 * Writes files under the ids above into `dir`, and lists each in the
 * directory's files.json (id to SHA-256), as the rebuild check's files
 * source serves them. Entries already listed are kept.
 */
export function writeDropArchiveFiles(
  dir: string,
  files: Readonly<Record<string, Uint8Array>>
): void {
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, 'files.json');
  const index: Record<string, string> = fs.existsSync(indexFile)
    ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    : {};
  for (const [id, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, id), bytes);
    index[id] = createHash('sha256').update(bytes).digest('hex');
  }
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
}

/**
 * Lays out the snapshot tooling's output (`outDir` holding waves-v1.bin
 * and archives/ with index.json) as a files source directory under the ids
 * above, one file at a time. Returns how many archives it copied.
 */
export function layoutSnapshotFiles(outDir: string, filesDir: string): number {
  const archivesDir = path.join(outDir, 'archives');
  const indexBytes = fs.readFileSync(path.join(archivesDir, 'index.json'));
  const archives = (
    JSON.parse(indexBytes.toString('utf8')) as {
      archives: { waveId: string; file: string }[];
    }
  ).archives;
  writeDropArchiveFiles(filesDir, {
    [DROP_ARCHIVE_FILE_IDS.wavesFile]: fs.readFileSync(
      path.join(outDir, 'waves-v1.bin')
    ),
    [DROP_ARCHIVE_FILE_IDS.index]: indexBytes
  });
  archives.forEach((archive) => {
    if (path.basename(archive.file) !== archive.file) {
      throw new Error(`The archive index names a file outside archives/`);
    }
    writeDropArchiveFiles(filesDir, {
      [DROP_ARCHIVE_FILE_IDS.archive(archive.waveId)]: fs.readFileSync(
        path.join(archivesDir, archive.file)
      )
    });
  });
  return archives.length;
}

/**
 * The chain's waves import through the gateway at `height` (the run's mark),
 * or at the gateway's finalized height when null: the imported file's hash
 * once the import has completed.
 */
export function gatewayDropArchiveChain(
  baseUrl: string,
  height: number | null
): DropArchiveChain {
  const client = new ChainGatewayClient(() => ({
    ...chainGatewayConfigFromEnv({ CHAIN_GATEWAY_URL: baseUrl }),
    cacheEntries: 64
  }));
  return {
    importedFileHash: async () => {
      const at = height ?? (await client.getHead(true)).finalizedHeight;
      const answer = await client.read<Record<string, unknown>>(
        '/v1/waves/import',
        {},
        { height: at }
      );
      const data = answer?.data;
      if (!data || data.completed !== true) return null;
      const hash = data.fileHash;
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error(
          'The chain names its imported Waves v1 file by no hash'
        );
      }
      return hash.toLowerCase();
    }
  };
}

/** Plain inserts into drops and drops_parts, one transaction a batch. */
export function dbDropArchiveWriter(db: SqlExecutor): DropArchiveWriter {
  return {
    write: async (drops, parts) => {
      await db.executeNativeQueriesInTransaction(async (connection) => {
        await db.bulkInsert(
          DROPS_TABLE,
          drops,
          [...DROP_ROW_COLUMNS],
          undefined,
          { connection }
        );
        await db.bulkInsert(
          DROPS_PARTS_TABLE,
          parts,
          [...PART_ROW_COLUMNS],
          undefined,
          { connection }
        );
      });
    }
  };
}
