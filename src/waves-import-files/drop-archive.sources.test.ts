import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startFileServer, checkFiles } from '@/rebuild/sources/file-server';
import { startHttpRecording } from '@/rebuild/sources/http-recording';
import {
  FIXTURE_DROPS,
  FIXTURE_PARTS,
  FIXTURE_WAVES
} from '@/tests/fixtures/drop-archive.fixture';
import {
  buildDropArchives,
  rawCidOf,
  wavesFileCommitting
} from '@/waves-import-files/drop-archive.build';
import { keccak256Hex } from '@/waves-import-files/drop-archive.format';
import { importDropArchives } from '@/waves-import-files/drop-archive.reader';
import { PROXY_PIN_STATEMENT_BYTES } from '@/db/proxy-session-pinning';
import { SqlExecutor } from '@/sql-executor';
import {
  DROP_ARCHIVE_FILE_IDS,
  dbDropArchiveWriter,
  gatewayDropArchiveChain,
  httpDropArchiveFiles,
  layoutSnapshotFiles,
  writeDropArchiveFiles
} from '@/waves-import-files/drop-archive.sources';

/** Wave B's document: its description is drop 4's one part. */
const WAVE_B_DOCUMENT = Buffer.from(
  JSON.stringify({
    v: 1,
    kind: 'wave',
    legacy_id: FIXTURE_WAVES.b,
    description: [{ content: FIXTURE_PARTS[4].content, media: [] }]
  }),
  'utf8'
);
const WAVE_B_CID = rawCidOf(WAVE_B_DOCUMENT);

/**
 * The snapshot tooling's output for the fixture: waves-v1.bin (with wave
 * B's row, naming its document) and archives/.
 */
function snapshotOut(dir: string) {
  const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
  const wavesFile = wavesFileCommitting(built.dropArchiveRoot, undefined, [
    { legacyWave: FIXTURE_WAVES.b, documentCid: WAVE_B_CID }
  ]);
  fs.mkdirSync(path.join(dir, 'archives'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'waves-v1.bin'), wavesFile);
  fs.writeFileSync(path.join(dir, 'archives', 'index.json'), built.index);
  built.archives.forEach((archive) =>
    fs.writeFileSync(
      path.join(dir, 'archives', `${archive.waveId.slice(2)}.jsonl`),
      archive.bytes
    )
  );
  return { built, wavesFile };
}

describe('the drop archive sources', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-archive-sources-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("lay out the snapshot tooling's output as a files source the reader reads over HTTP", async () => {
    const out = path.join(tmp, 'out');
    const filesDir = path.join(tmp, 'files');
    const { built, wavesFile } = snapshotOut(out);
    expect(layoutSnapshotFiles(out, filesDir)).toBe(2);
    const { files, problems } = checkFiles(filesDir);
    expect(problems).toEqual([]);
    expect(Array.from(files.keys()).sort()).toEqual(
      [
        DROP_ARCHIVE_FILE_IDS.wavesFile,
        DROP_ARCHIVE_FILE_IDS.index,
        ...built.archives.map((a) => DROP_ARCHIVE_FILE_IDS.archive(a.waveId))
      ].sort()
    );
    // Documents are served by CID, as the rebuild check's files are.
    writeDropArchiveFiles(filesDir, {
      [DROP_ARCHIVE_FILE_IDS.document(WAVE_B_CID)]: WAVE_B_DOCUMENT
    });
    const server = await startFileServer(filesDir);
    try {
      const source = httpDropArchiveFiles(server.url);
      expect(await source.archive(`0x${'00'.repeat(32)}`)).toBeNull();
      const written: string[] = [];
      const report = await importDropArchives({
        chain: { importedFileHash: async () => keccak256Hex(wavesFile) },
        files: source,
        writer: {
          write: async (drops) => {
            written.push(...drops.map((d) => d.id));
          }
        }
      });
      expect(report.refused).toEqual([]);
      expect(written.sort()).toEqual(FIXTURE_DROPS.map((d) => d.id).sort());
      expect(Array.from(report.descriptionDropIds.entries())).toEqual([
        [FIXTURE_WAVES.b, FIXTURE_DROPS[3].id]
      ]);
    } finally {
      await server.stop();
    }
  });

  it('refuse a document that does not match its CID', async () => {
    const filesDir = path.join(tmp, 'files');
    writeDropArchiveFiles(filesDir, {
      [DROP_ARCHIVE_FILE_IDS.document(WAVE_B_CID)]: Buffer.from('{}')
    });
    const server = await startFileServer(filesDir);
    try {
      await expect(
        httpDropArchiveFiles(server.url).document!(WAVE_B_CID)
      ).rejects.toThrow('does not match its CID');
    } finally {
      await server.stop();
    }
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
    const drops = Array.from({ length: 300 }, (_, i) => ({
      ...FIXTURE_DROPS[0],
      id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
      serial_no: i + 1,
      parts_count: 1,
      drop_type: FIXTURE_DROPS[0].drop_type as never,
      signature: null,
      is_additional_action_promised: null,
      hide_link_preview: false,
      collapse_replies: false
    }));
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
        .filter((sql) => sql.startsWith(`insert into ${table} `))
        .reduce((n, sql) => n + tuples(sql), 0);
    expect(rowsInto('drops')).toBe(300);
    expect(rowsInto('drops_parts')).toBe(300);
    expect(statements.length).toBeGreaterThan(4);
  });

  it('refuse an index that names a file outside archives/', () => {
    const out = path.join(tmp, 'out');
    snapshotOut(out);
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
