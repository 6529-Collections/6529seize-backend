import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { PoolConnection } from 'mysql';
import { execSQLWithParams } from '@/db/my-sql.helpers';
import { PROXY_PIN_STATEMENT_BYTES } from '@/db/proxy-session-pinning';
import { Logger } from '@/logging';
import { startFileServer, checkFiles } from '@/rebuild/sources/file-server';
import { startHttpRecording } from '@/rebuild/sources/http-recording';
import { SqlExecutor } from '@/sql-executor';
import {
  FIXTURE_DROPS,
  FIXTURE_PARTS,
  FIXTURE_WAVES
} from '@/tests/fixtures/drop-archive.fixture';
import {
  buildDropArchives,
  waveDocumentOf,
  wavesFileFor
} from '@/waves-import-files/drop-archive.build';
import { keccak256Hex } from '@/waves-import-files/drop-archive.format';
import { importDropArchives } from '@/waves-import-files/drop-archive.reader';
import { DropArchiveDropRow } from '@/waves-import-files/drop-archive.rows';
import {
  DROP_ARCHIVE_FILE_IDS,
  dbDropArchiveWriter,
  gatewayDropArchiveChain,
  httpDropArchiveFiles,
  layoutSnapshotFiles,
  writeDropArchiveFiles
} from '@/waves-import-files/drop-archive.sources';
import { rawCidOf } from '@/waves-import-files/drop-archive.build';

/** Each wave's document: wave A's description is drop 1, wave B's drop 4. */
const DOCUMENTS: Record<string, Buffer> = {
  [FIXTURE_WAVES.a]: waveDocumentOf(
    FIXTURE_WAVES.a,
    FIXTURE_PARTS.filter((p) => p.drop_id === FIXTURE_DROPS[0].id)
  ),
  [FIXTURE_WAVES.b]: waveDocumentOf(
    FIXTURE_WAVES.b,
    FIXTURE_PARTS.filter((p) => p.drop_id === FIXTURE_DROPS[3].id)
  )
};

/**
 * The snapshot tooling's output for the fixture: waves-v1.bin, archives/
 * and docs/ (holding `documents`, by wave), each with its index.json.
 */
function snapshotOut(dir: string, documents: Record<string, Buffer>) {
  const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
  const wavesFile = wavesFileFor(built, DOCUMENTS);
  fs.mkdirSync(path.join(dir, 'archives'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'waves-v1.bin'), wavesFile);
  fs.writeFileSync(path.join(dir, 'archives', 'index.json'), built.index);
  built.archives.forEach((archive) =>
    fs.writeFileSync(
      path.join(dir, 'archives', `${archive.waveId.slice(2)}.jsonl`),
      archive.bytes
    )
  );
  const docs = Object.keys(documents).map((wave, i) => {
    const file = `3-${i}.json`;
    fs.writeFileSync(path.join(dir, 'docs', file), documents[wave]);
    return { cid: rawCidOf(documents[wave]).slice(2), docClass: 3, file };
  });
  // A commitment document has no CID: not served by one.
  fs.writeFileSync(path.join(dir, 'docs', '6-0.json'), '{}');
  docs.push({ cid: '', docClass: 6, file: '6-0.json' });
  fs.writeFileSync(
    path.join(dir, 'docs', 'index.json'),
    JSON.stringify({ docs })
  );
  return { built, wavesFile };
}

/** The wave documents as the rebuild check's files source names them. */
function documentFiles(
  documents: Record<string, Buffer>
): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  Object.keys(documents).forEach((wave) => {
    files[DROP_ARCHIVE_FILE_IDS.document(rawCidOf(DOCUMENTS[wave]))] =
      documents[wave];
  });
  return files;
}

function aDrop(i: number): DropArchiveDropRow {
  return {
    ...FIXTURE_DROPS[0],
    id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
    serial_no: i + 1,
    parts_count: 1,
    drop_type: FIXTURE_DROPS[0].drop_type as never,
    signature: null,
    is_additional_action_promised: null,
    hide_link_preview: false,
    collapse_replies: false
  };
}

describe('the drop archive sources', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-archive-sources-'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Reads the fixture over HTTP from a files directory laid out from the
   * tooling's output with `laidOut` in docs/, plus `added` as served.
   */
  async function readOverHttp(
    laidOut: Record<string, Buffer>,
    added: Record<string, Buffer> = {}
  ) {
    const out = path.join(tmp, 'out');
    const filesDir = path.join(tmp, 'files');
    const { built, wavesFile } = snapshotOut(out, laidOut);
    expect(layoutSnapshotFiles(out, filesDir)).toEqual({
      archives: 2,
      documents: Object.keys(laidOut).length
    });
    writeDropArchiveFiles(filesDir, documentFiles(added));
    const server = await startFileServer(filesDir);
    try {
      const written: string[] = [];
      const report = await importDropArchives({
        chain: { importedFileHash: async () => keccak256Hex(wavesFile) },
        files: httpDropArchiveFiles(server.url),
        writer: {
          write: async (drops) => {
            written.push(...drops.map((d) => d.id));
          }
        }
      });
      return { built, filesDir, report, written };
    } finally {
      await server.stop();
    }
  }

  it("lay out the snapshot tooling's output as a files source the reader reads over HTTP", async () => {
    const { built, filesDir, report, written } = await readOverHttp(DOCUMENTS);
    const { files, problems } = checkFiles(filesDir);
    expect(problems).toEqual([]);
    expect(Array.from(files.keys()).sort()).toEqual(
      [
        DROP_ARCHIVE_FILE_IDS.wavesFile,
        DROP_ARCHIVE_FILE_IDS.index,
        ...built.archives.map((a) => DROP_ARCHIVE_FILE_IDS.archive(a.waveId)),
        ...Object.keys(documentFiles(DOCUMENTS))
      ].sort()
    );
    expect(report.refused).toEqual([]);
    expect(written.sort()).toEqual(FIXTURE_DROPS.map((d) => d.id).sort());
    expect(Array.from(report.descriptionDropIds.entries())).toEqual([
      [FIXTURE_WAVES.a, FIXTURE_DROPS[0].id],
      [FIXTURE_WAVES.b, FIXTURE_DROPS[3].id]
    ]);
  });

  it('refuse a wave whose document is missing or does not match its CID', async () => {
    const { built, report, written } = await readOverHttp(
      {},
      { [FIXTURE_WAVES.b]: Buffer.from('{"kind":"wave","description":[]}') }
    );
    const [a, b] = built.archives;
    expect(report.refused).toEqual([
      {
        waveId: a.waveId,
        reason: `its wave document ${rawCidOf(DOCUMENTS[FIXTURE_WAVES.a])} is missing`
      },
      {
        waveId: b.waveId,
        reason: `its wave document does not match its CID ${rawCidOf(DOCUMENTS[FIXTURE_WAVES.b])}`
      }
    ]);
    expect(written).toEqual([]);
  });

  it('write inserts under the proxy pinning size, one transaction a batch', async () => {
    const statements: string[] = [];
    let transactions = 0;
    const db = {
      execute: async (sql: string) => {
        statements.push(sql);
        return [];
      },
      executeNativeQueriesInTransaction: async (
        run: (connection: { connection: unknown }) => Promise<unknown>
      ) => {
        transactions++;
        return run({ connection: {} });
      }
    } as unknown as SqlExecutor;
    const drops = Array.from({ length: 300 }, (_, i) => aDrop(i));
    const big = 'x'.repeat(PROXY_PIN_STATEMENT_BYTES + 10);
    const parts = drops.map((d, i) => ({
      drop_id: d.id,
      drop_part_id: 1,
      content: i === 7 ? big : 'a part \u{1F30A}',
      quoted_drop_id: null,
      quoted_drop_part_id: null,
      wave_id: d.wave_id
    }));
    await dbDropArchiveWriter(db).write(drops, parts);
    expect(transactions).toBe(1);
    const tuples = (sql: string) => sql.split('), (').length;
    // Only the statement of the one oversized part, alone, is above.
    const over = statements.filter(
      (sql) => Buffer.byteLength(sql, 'utf8') > PROXY_PIN_STATEMENT_BYTES
    );
    expect(over).toHaveLength(1);
    expect(over[0]).toContain(big);
    expect(tuples(over[0])).toBe(1);
    const rowsInto = (table: string) =>
      statements
        .filter((sql) =>
          sql.startsWith(`/* drop archive import */ insert into ${table} `)
        )
        .reduce((n, sql) => n + tuples(sql), 0);
    expect(rowsInto('drops')).toBe(300);
    expect(rowsInto('drops_parts')).toBe(300);
    expect(statements.length).toBeGreaterThan(4);
  });

  it("keep a failed insert's text out of the error and the database layer's logs", async () => {
    const secret = 'a members-only drop text';
    // The database layer, as a failed insert meets it.
    const logged = jest.fn();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(logged);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(logged);
    const connection = {
      config: {},
      query: (_query: unknown, callback: (error: Error) => void) =>
        callback(
          Object.assign(new Error(`Duplicate entry '${secret}'`), {
            code: 'ER_DUP_ENTRY'
          })
        ),
      release: jest.fn()
    } as unknown as PoolConnection;
    const db = {
      execute: (sql: string) => execSQLWithParams(sql, connection, true),
      executeNativeQueriesInTransaction: async (
        run: (connection: { connection: unknown }) => Promise<unknown>
      ) => run({ connection: {} })
    } as unknown as SqlExecutor;
    const drop = { ...aDrop(1), title: secret };
    const failed = await dbDropArchiveWriter(db)
      .write([drop], [])
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(String(failed)).not.toContain(secret);
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('insert into');
  });

  it('read a file again when the connection is reset before an answer', async () => {
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests++;
      if (requests === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200);
      response.end('the index');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    try {
      const { port } = server.address() as { port: number };
      const bytes = await httpDropArchiveFiles(
        `http://127.0.0.1:${port}`
      ).archiveIndex();
      expect(Buffer.from(bytes!).toString('utf8')).toBe('the index');
      expect(requests).toBe(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuse a document that does not match its CID when laying out', () => {
    const out = path.join(tmp, 'out');
    snapshotOut(out, DOCUMENTS);
    fs.writeFileSync(path.join(out, 'docs', '3-0.json'), '{}');
    expect(() => layoutSnapshotFiles(out, path.join(tmp, 'files'))).toThrow(
      'does not match its CID'
    );
  });

  it('refuse an index that names a file outside archives/', () => {
    const out = path.join(tmp, 'out');
    snapshotOut(out, DOCUMENTS);
    const indexFile = path.join(out, 'archives', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index.archives[0].file = '../waves-v1.bin';
    fs.writeFileSync(indexFile, JSON.stringify(index));
    expect(() => layoutSnapshotFiles(out, path.join(tmp, 'files'))).toThrow(
      'outside archives/'
    );
  });

  it("read the imported file's hash from the gateway as the waves world's recording holds it", async () => {
    const gateway = await startHttpRecording({
      name: 'gateway',
      dir: path.resolve(__dirname, '../rebuild/world/waves/gateway')
    });
    try {
      // The recording's mark and the import's done height.
      for (const height of [2798, 2160]) {
        expect(
          await gatewayDropArchiveChain(gateway.url, height).importedFileHash()
        ).toBe(
          '0xe1e6cafff9bacc1d97ce9d60fe7d9923faabffd0352547d9e860773922796542'
        );
      }
    } finally {
      await gateway.stop();
    }
  });
});
