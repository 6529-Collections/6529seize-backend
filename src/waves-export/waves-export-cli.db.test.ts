import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { DROPS_PARTS_TABLE, DROPS_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { main } from './cli';

/**
 * The export as the CLI runs it, on made-up rows: `main` with its own DB
 * context, so every read goes through the export's DB layer and not the
 * test executor. The raw drop lines must hold numbers as numbers and the
 * API's legacy view of a drop's type (the public API's view).
 *
 * With WAVES_SNAPSHOT_TOOL set to the snapshot tooling's directory
 * (validator repository, tools/legacy-snapshot), the export then goes
 * through the tooling as the export run does: normalize and build must
 * exit 0 and write a Waves v1 file. WAVES_E2E_OUT keeps the output there.
 */
const AUTHOR = anIdentity(
  {},
  {
    consolidation_key: 'e2e-author-wallet',
    profile_id: 'e0000000-0000-4000-8000-000000000001',
    primary_address: '0x00000000000000000000000000000000000e2e01',
    handle: 'e2eauthor'
  }
);
const FIRST_ID = 'e1000000-0000-4000-8000-000000000001';
const SECOND_ID = 'e1000000-0000-4000-8000-000000000002';
const DROP = (n: number) => `e2000000-0000-4000-8000-00000000000${n}`;
const FIRST_WAVE = aWave(
  { created_by: AUTHOR.profile_id!, description_drop_id: DROP(1) },
  { id: FIRST_ID, name: 'First', serial_no: 1 }
);
const SECOND_WAVE = aWave(
  { created_by: AUTHOR.profile_id!, description_drop_id: DROP(4) },
  { id: SECOND_ID, name: 'Second', serial_no: 2 }
);

function dropRow(waveId: string, id: string, serial: number) {
  return {
    id,
    serial_no: serial,
    wave_id: waveId,
    author_id: AUTHOR.profile_id!,
    created_at: 1_700_000_000_000 + serial,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    hide_link_preview: false
  };
}

function partRow(waveId: string, dropId: string) {
  return {
    drop_id: dropId,
    drop_part_id: 1,
    content: `made-up text of ${dropId}`,
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: waveId
  };
}

const DROPS = [
  dropRow(FIRST_ID, DROP(1), 1),
  // A reply, with a part id.
  {
    ...dropRow(FIRST_ID, DROP(2), 2),
    reply_to_drop_id: DROP(1),
    reply_to_part_id: 1
  },
  // A native entry's drop with no entry: the legacy view shows it as chat.
  { ...dropRow(FIRST_ID, DROP(3), 3), drop_type: DropType.COMPETITION },
  dropRow(SECOND_ID, DROP(4), 4)
];

function readLines(file: string): Record<string, unknown>[] {
  return zlib
    .gunzipSync(fs.readFileSync(file))
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length)
    .map((line) => JSON.parse(line));
}

function python(tool: string, args: string[]) {
  const run = spawnSync(
    process.env.PYTHON ?? 'python',
    ['-I', path.join(tool, 'waves_snapshot.py'), ...args],
    { encoding: 'utf8', timeout: 300_000 }
  );
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

describeWithSeed(
  'waves:export through the CLI',
  [
    withIdentities([AUTHOR]),
    withWaves([FIRST_WAVE, SECOND_WAVE]),
    { table: DROPS_TABLE, rows: DROPS },
    {
      table: DROPS_PARTS_TABLE,
      rows: DROPS.map((drop) => partRow(drop.wave_id, drop.id))
    }
  ],
  () => {
    let out: string;
    beforeEach(() => {
      out =
        process.env.WAVES_E2E_OUT ??
        fs.mkdtempSync(path.join(os.tmpdir(), 'waves-export-cli-'));
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
    });
    afterEach(() => {
      if (!process.env.WAVES_E2E_OUT) {
        fs.rmSync(out, { recursive: true, force: true });
      }
    });

    it("writes the API's view with numbers as numbers, and the tooling builds from it", async () => {
      // The CLI opens its own DB context and executor; the test's comes
      // back afterwards for the hooks that reset the database.
      const testExecutor = sqlExecutor;
      const stdout = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        await main([
          '--out',
          out,
          '--revision',
          'ab'.repeat(20),
          '--rehearsal',
          '--waves',
          `${FIRST_ID},${SECOND_ID}`
        ]);
      } finally {
        stdout.mockRestore();
        setSqlExecutor(testExecutor);
      }
      const lines = readLines(
        path.join(out, 'raw', 'drops', `${FIRST_ID}.jsonl.gz`)
      );
      const byId = new Map(lines.map((line) => [line.id, line]));
      for (const line of lines) {
        expect(typeof line.serial_no).toBe('number');
        expect(typeof line.created_at).toBe('number');
        for (const part of line.parts as Record<string, unknown>[]) {
          expect(typeof part.part_id).toBe('number');
        }
      }
      expect(byId.get(DROP(2))?.reply_to).toEqual({
        drop_id: DROP(1),
        part_id: 1
      });
      // The legacy view, as the public API shows it.
      expect(byId.get(DROP(3))?.drop_type).toBe('CHAT');
      expect(
        readLines(path.join(out, 'raw', 'drops', `${SECOND_ID}.jsonl.gz`)).map(
          (line) => line.id
        )
      ).toEqual([DROP(4)]);

      const tool = process.env.WAVES_SNAPSHOT_TOOL;
      if (!tool) return;
      const normalize = python(tool, [
        'normalize',
        '--out',
        out,
        '--freeze-ms',
        String(Date.now()),
        '--main-stage',
        'live'
      ]);
      expect({ step: 'normalize', ...normalize }).toMatchObject({
        status: 0
      });
      const build = python(tool, ['build', '--out', out]);
      expect({ step: 'build', ...build }).toMatchObject({ status: 0 });
      expect(fs.existsSync(path.join(out, 'waves-v1.bin'))).toBe(true);
    });
  }
);
