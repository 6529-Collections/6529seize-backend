import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { main } from './cli';
import { compareCodePoints } from './waves-export.json';

/**
 * The export as the CLI runs it, on made-up rows: `main` with its own DB
 * context, so every read goes through the export's DB layer and not the
 * test executor. The raw drop lines must hold numbers as numbers and the
 * API's legacy view of a drop's type (the public API's view).
 *
 * With WAVES_SNAPSHOT_TOOL set to the snapshot tooling's directory
 * (validator repository, tools/legacy-snapshot) and WAVES_SNAPSHOT_REVISION
 * to that tooling's 40-hex commit, the export then goes through the
 * tooling as the export run does: normalize, table-check and build (each
 * given the records wave setting the export ran with, as its export.json
 * records it; build its revision too) must exit 0 and write a Waves v1
 * file and the import set, which check-set reads back. The world holds a
 * published decision with a native active entry that has votes, so the
 * tooling's check that such an entry has a vote log runs too.
 * WAVES_E2E_OUT keeps the output, and each step's output, there.
 */
// The identity fixture's default sub_classification is random per process:
// pinned, so two runs of this world export the same bytes.
const AUTHOR = anIdentity(
  { sub_classification: 'made-up-sub-classification' },
  {
    consolidation_key: 'e2e-author-wallet',
    profile_id: 'e0000000-0000-4000-8000-000000000001',
    primary_address: '0x00000000000000000000000000000000000e2e01',
    handle: 'e2eauthor'
  }
);
const FIRST_ID = 'e1000000-0000-4000-8000-000000000001';
const SECOND_ID = 'e1000000-0000-4000-8000-000000000002';
const STAYING_ID = 'e1000000-0000-4000-8000-000000000003';
const RECORDS_ID = 'e1000000-0000-4000-8000-000000000004';
const DROP = (n: number) => `e2000000-0000-4000-8000-00000000000${n}`;
const FIRST_WAVE = aWave(
  { created_by: AUTHOR.profile_id!, description_drop_id: DROP(1) },
  { id: FIRST_ID, name: 'First', serial_no: 1 }
);
const SECOND_WAVE = aWave(
  { created_by: AUTHOR.profile_id!, description_drop_id: DROP(4) },
  { id: SECOND_ID, name: 'Second', serial_no: 2 }
);
// A members-only wave: it stays on 6529.io, and the export leaves it out.
const STAYING_WAVE = aWave(
  {
    created_by: AUTHOR.profile_id!,
    description_drop_id: DROP(5),
    visibility_group_id: 'e3000000-made-up-read-group'
  },
  { id: STAYING_ID, name: 'Staying', serial_no: 3 }
);
// The signed records wave: it stays by its id.
const RECORDS_WAVE = aWave(
  { created_by: AUTHOR.profile_id!, description_drop_id: DROP(6) },
  { id: RECORDS_ID, name: 'Records', serial_no: 4 }
);
// A published decision with a native active entry that holds votes: the
// tooling refuses such an entry when its vote log is empty.
const DECISION_ID = 'e1000000-0000-4000-8000-000000000005';
const DECISION_WAVE = aWave(
  {
    type: WaveType.RANK,
    created_by: AUTHOR.profile_id!,
    description_drop_id: DROP(8)
  },
  { id: DECISION_ID, name: 'Decision', serial_no: 5 }
);
const COMPETITION_ID = legacyCompetitionId(DECISION_ID);
const ENTRY_ID = legacyCompetitionEntryId(COMPETITION_ID, DROP(7));
const VOTER = anIdentity(
  { sub_classification: 'made-up-sub-classification' },
  {
    consolidation_key: 'e2e-voter-wallet',
    profile_id: 'e0000000-0000-4000-8000-000000000002',
    primary_address: '0x00000000000000000000000000000000000e2e02',
    handle: 'e2evoter'
  }
);
/** The entry's votes now, and how they got there, oldest first. */
const ENTRY_VOTES = [
  { voter: AUTHOR.profile_id!, value: 8 },
  { voter: VOTER.profile_id!, value: 3 }
];
const ENTRY_HISTORY = [
  { voter: AUTHOR.profile_id!, previous: 0, value: 5, aggregate: 5, at: 2_000 },
  { voter: VOTER.profile_id!, previous: 0, value: 3, aggregate: 8, at: 3_000 },
  { voter: AUTHOR.profile_id!, previous: 5, value: 8, aggregate: 11, at: 4_000 }
];

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
  // With the table values the API doesn't show, and a reply with no part id.
  {
    ...dropRow(FIRST_ID, DROP(3), 3),
    drop_type: DropType.COMPETITION,
    signature: 'made-up-signature',
    is_additional_action_promised: true,
    hide_link_preview: true,
    collapse_replies: true,
    reply_to_drop_id: DROP(2),
    reply_to_part_id: null
  },
  dropRow(SECOND_ID, DROP(4), 4),
  dropRow(STAYING_ID, DROP(5), 5),
  dropRow(RECORDS_ID, DROP(6), 6),
  // The decision's entry, stored as a native entry's drop, and the
  // decision wave's description.
  { ...dropRow(DECISION_ID, DROP(7), 7), drop_type: DropType.COMPETITION },
  dropRow(DECISION_ID, DROP(8), 8),
  // A drop that mentions a moving wave: the API nests that wave in it.
  dropRow(FIRST_ID, DROP(9), 9)
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
    withIdentities([AUTHOR, VOTER]),
    withWaves([
      FIRST_WAVE,
      SECOND_WAVE,
      STAYING_WAVE,
      RECORDS_WAVE,
      DECISION_WAVE
    ]),
    { table: DROPS_TABLE, rows: DROPS },
    {
      table: DROPS_PARTS_TABLE,
      rows: DROPS.map((drop) => partRow(drop.wave_id, drop.id))
    },
    {
      table: DROP_MENTIONED_WAVES_TABLE,
      rows: [
        {
          drop_id: DROP(9),
          wave_name_in_content: 'Second',
          wave_id: SECOND_ID
        }
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: ENTRY_ID,
          competition_id: COMPETITION_ID,
          wave_id: DECISION_ID,
          drop_id: DROP(7),
          submitter_id: AUTHOR.profile_id!,
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 1_500
        }
      ]
    },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: ENTRY_VOTES.map((vote, i) => ({
        id: `e3000000-0000-4000-8000-00000000000${i + 1}`,
        competition_id: COMPETITION_ID,
        entry_id: ENTRY_ID,
        voter_profile_id: vote.voter,
        value: vote.value,
        credit_spent: vote.value,
        created_at: 2_000,
        updated_at: 4_000
      }))
    },
    {
      table: COMPETITION_VOTE_HISTORY_TABLE,
      rows: ENTRY_HISTORY.map((change, i) => ({
        sequence: i + 1,
        competition_id: COMPETITION_ID,
        entry_id: ENTRY_ID,
        drop_id: DROP(7),
        submitter_id: AUTHOR.profile_id!,
        voter_profile_id: change.voter,
        value: change.value,
        previous_value: change.previous,
        aggregate_value: change.aggregate,
        credit_delta: change.value - change.previous,
        occurred_at: change.at
      }))
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
      // The decision, published, as the primary decision of its wave.
      await seedNativeOriginalPrimaryFixture(DECISION_WAVE);
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
          '--records-wave-id',
          RECORDS_ID,
          '--waves',
          `${FIRST_ID},${SECOND_ID},${STAYING_ID},${RECORDS_ID},${DECISION_ID}`
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
      // The legacy view, as the public API shows it, and the table's own
      // values beside it.
      expect(byId.get(DROP(3))?.drop_type).toBe('CHAT');
      expect(byId.get(DROP(3))?.table).toEqual({
        signature: 'made-up-signature',
        is_additional_action_promised: true,
        hide_link_preview: true,
        collapse_replies: true,
        drop_type: 'COMPETITION',
        reply_to_part_id: null
      });
      expect(byId.get(DROP(2))?.table).toMatchObject({
        drop_type: 'CHAT',
        reply_to_part_id: 1
      });
      expect(
        readLines(path.join(out, 'raw', 'drops', `${SECOND_ID}.jsonl.gz`)).map(
          (line) => line.id
        )
      ).toEqual([DROP(4)]);
      // The members-only wave and the records wave stay on 6529.io: left
      // out whole, and counted.
      const raw = (name: string) =>
        JSON.parse(fs.readFileSync(path.join(out, 'raw', name), 'utf8'));
      expect(Object.keys(raw('waves_v3.json')).sort(compareCodePoints)).toEqual(
        [FIRST_ID, SECOND_ID, DECISION_ID].sort(compareCodePoints)
      );
      for (const id of [STAYING_ID, RECORDS_ID]) {
        expect(
          fs.existsSync(path.join(out, 'raw', 'drops', `${id}.jsonl.gz`))
        ).toBe(false);
      }
      expect(raw('waves_v3.json')[FIRST_ID].configuration.stays_on_site).toBe(
        false
      );
      expect(raw('curations.json')).toEqual({
        [FIRST_ID]: [],
        [SECOND_ID]: [],
        [DECISION_ID]: []
      });
      // The native entry's vote log is its stored history, newest first,
      // and adds up to its votes.
      const log = raw('entry_logs.json')[DROP(7)] as Record<string, number>[];
      expect(
        log.map((row) => [row.voter_profile_id, row.old_vote, row.new_vote])
      ).toEqual(
        [...ENTRY_HISTORY]
          .reverse()
          .map((change) => [change.voter, change.previous, change.value])
      );
      const total = ENTRY_VOTES.reduce((sum, vote) => sum + vote.value, 0);
      expect(
        log.reduce((sum, row) => sum + row.new_vote - row.old_vote, 0)
      ).toBe(total);
      expect(Object.keys(raw('entry_votes.json'))).toEqual([ENTRY_ID]);
      // stays_on_site appears once per exported wave, on its configuration
      // in waves_v3.json, and nowhere else: none of the API's copies, nested
      // or not, reaches a file.
      const mentioning = readLines(
        path.join(out, 'raw', 'drops', `${FIRST_ID}.jsonl.gz`)
      ).find((line) => line.id === DROP(9));
      // Compaction keeps only the mention's wave id, so the API's nested
      // wave never reaches a drop file. The nested copy a file could carry
      // is a description drop's wave, in waves_v3.json.
      expect(mentioning?.mentioned_waves).toMatchObject([
        { wave_id: SECOND_ID }
      ]);
      const counts: Record<string, number> = {};
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(file);
            continue;
          }
          const text = file.endsWith('.gz')
            ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
            : fs.readFileSync(file, 'utf8');
          const found = text.split('"stays_on_site"').length - 1;
          if (found)
            counts[path.relative(out, file).split(path.sep).join('/')] = found;
        }
      };
      walk(path.join(out, 'raw'));
      expect(counts).toEqual({
        'raw/waves_v3.json': Object.keys(raw('waves_v3.json')).length
      });
      expect(raw('export.json')).toMatchObject({
        records_wave_id: RECORDS_ID,
        left_out: {
          waves: {
            total: 2,
            members_only: 1,
            records_wave: 1,
            direct_message: 0,
            hidden_or_private_group: 0
          }
        }
      });

      const tool = process.env.WAVES_SNAPSHOT_TOOL;
      if (!tool) return;
      // The tooling's own commit, which its build records.
      const toolRevision = process.env.WAVES_SNAPSHOT_REVISION ?? '';
      expect(toolRevision).toMatch(/^[0-9a-f]{40}$/);
      // The records wave setting the export ran with, as export.json
      // records it: its id, or none when null. The tooling refuses one that
      // disagrees.
      const recordsWave = String(raw('export.json').records_wave_id ?? 'none');
      expect(recordsWave).toBe(RECORDS_ID);
      // With WAVES_E2E_OUT, each step's output is kept beside the export.
      const keep = (step: string, run: { output: string }) => {
        if (process.env.WAVES_E2E_OUT) {
          fs.writeFileSync(path.join(out, `tool-${step}.log`), run.output);
        }
      };
      const normalize = python(tool, [
        'normalize',
        '--out',
        out,
        '--freeze-ms',
        String(Date.now()),
        '--main-stage',
        'live',
        '--records-wave',
        recordsWave
      ]);
      keep('normalize', normalize);
      expect({ step: 'normalize', ...normalize }).toMatchObject({
        status: 0
      });
      // The gate on the drops table's values before the build.
      const tableCheck = python(tool, ['table-check', '--out', out]);
      keep('table-check', tableCheck);
      expect({ step: 'table-check', ...tableCheck }).toMatchObject({
        status: 0
      });
      const build = python(tool, [
        'build',
        '--out',
        out,
        '--records-wave',
        recordsWave,
        '--revision',
        toolRevision
      ]);
      keep('build', build);
      expect({ step: 'build', ...build }).toMatchObject({ status: 0 });
      expect(fs.existsSync(path.join(out, 'waves-v1.bin'))).toBe(true);
      // The published set: the file, its docs and the archives, read back
      // as before its upload.
      expect(fs.existsSync(path.join(out, 'import-set.tar'))).toBe(true);
      const checkSet = python(tool, ['check-set', '--out', out]);
      keep('check-set', checkSet);
      expect({ step: 'check-set', ...checkSet }).toMatchObject({ status: 0 });
    });
  }
);
