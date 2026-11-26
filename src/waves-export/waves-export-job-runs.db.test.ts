import 'reflect-metadata';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { DROPS_PARTS_TABLE, DROPS_TABLE } from '@/constants';
import {
  parseWavesExportEvent,
  stageCommand
} from '@/dbDumpsDaily/waves-export.handler';
import { DropType } from '@/entities/IDrop';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { runExport } from './cli';
import { withApiSqlExecutor } from './waves-export.db';
import { WAVES_EXPORT_STAGES, WavesExportRun } from './waves-export.service';

/**
 * The export as the waves export job runs it, on made-up rows: one run per
 * stage, every one in this process, with the job's own command for the
 * stage and its keepDbScope, through the real DB scope (the export's pool
 * and executor, which the DB services keep). A scope that refused a run
 * after the first would fail the second stage here. One test in this file:
 * the scope runs once per process.
 */
const AUTHOR = anIdentity(
  {},
  {
    consolidation_key: 'job-runs-author-wallet',
    profile_id: 'e0000000-0000-4000-8000-000000000011',
    primary_address: '0x00000000000000000000000000000000000e2e11',
    handle: 'jobrunsauthor'
  }
);
const WAVE_ID = 'e1000000-0000-4000-8000-000000000011';
const DROP_ID = 'e2000000-0000-4000-8000-000000000011';
const WAVE = aWave(
  { created_by: AUTHOR.profile_id!, description_drop_id: DROP_ID },
  { id: WAVE_ID, name: 'Job runs', serial_no: 11 }
);
const DROP = {
  id: DROP_ID,
  serial_no: 11,
  wave_id: WAVE_ID,
  author_id: AUTHOR.profile_id!,
  created_at: 1_700_000_000_011,
  updated_at: null,
  title: null,
  parts_count: 1,
  reply_to_drop_id: null,
  reply_to_part_id: null,
  drop_type: DropType.CHAT,
  signature: null,
  hide_link_preview: false
};

describeWithSeed(
  'waves:export run once per stage in one process, as the job runs it',
  [
    withIdentities([AUTHOR]),
    withWaves([WAVE]),
    { table: DROPS_TABLE, rows: [DROP] },
    {
      table: DROPS_PARTS_TABLE,
      rows: [
        {
          drop_id: DROP_ID,
          drop_part_id: 1,
          content: 'made-up text',
          quoted_drop_id: null,
          quoted_drop_part_id: null,
          wave_id: WAVE_ID
        }
      ]
    }
  ],
  () => {
    let out: string;
    beforeEach(() => {
      out = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-export-job-runs-'));
    });
    afterEach(() => {
      fs.rmSync(out, { recursive: true, force: true });
    });

    it('runs every stage on the one kept scope, then ends it', async () => {
      const event = parseWavesExportEvent({
        job: 'wavesExport',
        rehearsal: true,
        run: 'r1',
        waves: [WAVE_ID],
        recordsWaveId: 'none'
      })!;
      const testExecutor = sqlExecutor;
      try {
        for (const stage of WAVES_EXPORT_STAGES) {
          const summary = await runExport(
            stageCommand(event, out, 'ab'.repeat(20), stage),
            { keepDbScope: true }
          );
          expect({ stage, failed: summary.failed_waves }).toEqual({
            stage,
            failed: []
          });
        }
        // The last run that doesn't keep the scope ends it; the process's
        // one scope is then used up, as the command line's.
        await withApiSqlExecutor(async () => undefined);
        await expect(withApiSqlExecutor(async () => undefined)).rejects.toThrow(
          'once per process'
        );
      } finally {
        setSqlExecutor(testExecutor);
      }
      const raw = (name: string) =>
        JSON.parse(fs.readFileSync(path.join(out, 'raw', name), 'utf8'));
      const runs = raw('export_runs.json') as WavesExportRun[];
      expect(runs.map((run) => run.stages)).toEqual(
        WAVES_EXPORT_STAGES.map((stage) => [stage])
      );
      expect(Object.keys(raw('waves_v3.json'))).toEqual([WAVE_ID]);
      const drops = zlib
        .gunzipSync(
          fs.readFileSync(path.join(out, 'raw', 'drops', `${WAVE_ID}.jsonl.gz`))
        )
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length)
        .map((line) => JSON.parse(line));
      expect(drops.map((drop) => drop.id)).toEqual([DROP_ID]);
      expect(typeof drops[0].serial_no).toBe('number');
    });
  }
);
