import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DROPS_TABLE } from '@/constants';
import { RebuildContext } from '@/rebuild/manifest.types';
import { startFileServer } from '@/rebuild/sources/file-server';
import { startHttpRecording } from '@/rebuild/sources/http-recording';
import { RunningSource } from '@/rebuild/sources/running-source';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  FIXTURE_DROPS,
  FIXTURE_PARTS
} from '@/tests/fixtures/drop-archive.fixture';
import {
  buildDropArchives,
  wavesFileCommitting
} from '@/waves-import-files/drop-archive.build';
import { keccak256Hex } from '@/waves-import-files/drop-archive.format';
import {
  DROP_ARCHIVE_FILE_IDS,
  writeDropArchiveFiles
} from '@/waves-import-files/drop-archive.sources';
import { rebuildWavesImportFiles } from './waves-import-files.steps';

/**
 * The rebuild step end to end: the waves world's recorded gateway (its
 * status and its waves import at the mark), with the import's file hash
 * replaced by the fixture's, and a files source serving the fixture's
 * Waves v1 file and archives, into MySQL.
 */
const RECORDING = path.resolve(__dirname, '../world/waves/gateway');
const MARK = 2798;
const RECORDED_FILE_HASH =
  '0xe1e6cafff9bacc1d97ce9d60fe7d9923faabffd0352547d9e860773922796542';

function gatewayFor(dir: string, fileHash: string): void {
  const lines = fs
    .readFileSync(path.join(RECORDING, 'recording.jsonl'), 'utf8')
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('{"key":"GET /v1/status ') ||
        line.startsWith(`{"key":"GET /v1/waves/import?height=${MARK}&`)
    );
  expect(lines).toHaveLength(2);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'recording.jsonl'),
    lines.map((line) => line.replace(RECORDED_FILE_HASH, fileHash)).join('\n')
  );
}

function context(gateway: string, files: string): RebuildContext {
  return {
    area: 'waves',
    stepId: 'waves.import-files',
    sources: { gateway, files, relays: null, ethereum: null, repo: null },
    seedFilesDir: null,
    mark: { name: 'head', chainHeight: MARK, ethBlock: null }
  };
}

describeWithSeed('the waves import-files rebuild step', [], () => {
  let tmp: string;
  let running: RunningSource[];
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-files-step-'));
    running = [];
  });
  afterEach(async () => {
    for (const source of running) await source.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function sources(tamper: boolean) {
    const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
    const wavesFile = wavesFileCommitting(built.dropArchiveRoot);
    const filesDir = path.join(tmp, 'files');
    const files: Record<string, Uint8Array> = {
      [DROP_ARCHIVE_FILE_IDS.wavesFile]: wavesFile,
      [DROP_ARCHIVE_FILE_IDS.index]: built.index
    };
    built.archives.forEach((archive, i) => {
      const bytes = Buffer.from(archive.bytes);
      if (tamper && i === 0) bytes[bytes.indexOf('an entry')] = 0x41;
      files[DROP_ARCHIVE_FILE_IDS.archive(archive.waveId)] = bytes;
    });
    writeDropArchiveFiles(filesDir, files);
    gatewayFor(path.join(tmp, 'gateway'), keccak256Hex(wavesFile));
    const gateway = await startHttpRecording({
      name: 'gateway',
      dir: path.join(tmp, 'gateway')
    });
    running.push(gateway);
    const server = await startFileServer(filesDir);
    running.push(server);
    return context(gateway.url, server.url);
  }

  it("writes the archives' drops, checked against the recorded import", async () => {
    await rebuildWavesImportFiles(await sources(false));
    const rows = await sqlExecutor.execute<{ id: string; serial_no: number }>(
      `select id, serial_no from ${DROPS_TABLE} order by serial_no`
    );
    expect(rows.map((r) => [r.id, Number(r.serial_no)])).toEqual(
      [...FIXTURE_DROPS]
        .sort((a, b) => a.serial_no - b.serial_no)
        .map((d) => [d.id, d.serial_no])
    );
  });

  it('fails on a tampered archive and writes none of its drops', async () => {
    await expect(rebuildWavesImportFiles(await sources(true))).rejects.toThrow(
      '[DROP ARCHIVES REFUSED] 1 refused'
    );
    const rows = await sqlExecutor.execute<{ wave_id: string }>(
      `select distinct wave_id from ${DROPS_TABLE}`
    );
    const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
    expect(rows.map((r) => r.wave_id)).toEqual([built.archives[1].legacyWave]);
  });
});
