import { DROPS_PARTS_TABLE, DROPS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  FIXTURE_DROPS,
  FIXTURE_PARTS,
  FIXTURE_WAVES
} from '@/tests/fixtures/drop-archive.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  buildDropArchives,
  BuiltDropArchives,
  rawCidOf,
  wavesFileCommitting
} from '@/waves-import-files/drop-archive.build';
import {
  dropArchiveRoot,
  keccak256Hex
} from '@/waves-import-files/drop-archive.format';
import { importDropArchives } from '@/waves-import-files/drop-archive.reader';
import { dbDropArchiveWriter } from '@/waves-import-files/drop-archive.sources';

/**
 * Waves that stay on 6529.io (members-only waves, and waves naming a hidden
 * or private group) are not in the Waves v1 file. Their rows are 6529.io's
 * own: the reader writes only the file's waves and never touches them, even
 * when a staying wave's archive or drop shows up. Wave A stays here, wave B
 * moves; all ids and rows made up.
 */
const STAYING = FIXTURE_WAVES.a;
const MOVED = FIXTURE_WAVES.b;
const CREATOR = '33333333-3333-4333-8333-000000000001';
const STAYING_DROP = (n: number) => `44444444-4444-4444-8444-00000000000${n}`;

const membersGroup = aUserGroup(
  { is_private: true, is_direct_message: false, created_by: CREATOR },
  { id: 'staying-members', name: 'Staying members' }
);

/** The staying wave's own rows on 6529.io, which no import may change. */
const stayingDrops = [1, 2].map((n) => ({
  id: STAYING_DROP(n),
  serial_no: 100 + n,
  wave_id: STAYING,
  author_id: CREATOR,
  created_at: 1_700_000_100_000 + n,
  updated_at: null,
  title: `staying ${n}`,
  parts_count: 1,
  reply_to_drop_id: null,
  reply_to_part_id: null,
  drop_type: 'CHAT',
  signature: null,
  is_additional_action_promised: null,
  hide_link_preview: false,
  collapse_replies: false
}));
const stayingParts = stayingDrops.map((drop) => ({
  drop_id: drop.id,
  drop_part_id: 1,
  content: `the staying wave's text ${drop.serial_no}`,
  quoted_drop_id: null,
  quoted_drop_part_id: null,
  wave_id: STAYING
}));

/** A file holding the moved wave only, committing `built`'s archives. */
function movedOnlyFile(built: Pick<BuiltDropArchives, 'dropArchiveRoot'>) {
  return wavesFileCommitting(built.dropArchiveRoot, undefined, [
    { legacyWave: MOVED, documentCid: rawCidOf(Buffer.from(MOVED)) }
  ]);
}

function importWith(
  wavesFile: Buffer,
  index: Uint8Array,
  archives: Record<string, Uint8Array>
) {
  return importDropArchives({
    chain: { importedFileHash: async () => keccak256Hex(wavesFile) },
    files: {
      wavesFile: async () => wavesFile,
      archiveIndex: async () => index,
      archive: async (waveId) => archives[waveId] ?? null
    },
    writer: dbDropArchiveWriter(sqlExecutor)
  });
}

/** Archives and an index for `archives` (wave id, 6529.io id, bytes). */
function committed(
  archives: { waveId: string; legacyWave: string; bytes: Buffer }[]
) {
  const sorted = [...archives].sort((a, b) => (a.waveId < b.waveId ? -1 : 1));
  const leaves = sorted.map((a) => ({
    waveId: a.waveId,
    hash: keccak256Hex(a.bytes)
  }));
  const root = dropArchiveRoot(leaves);
  const index = Buffer.from(
    JSON.stringify({
      dropArchiveRoot: root.slice(2),
      archives: sorted.map((a, i) => ({
        waveId: a.waveId.slice(2),
        legacyWave: a.legacyWave,
        file: `${a.waveId.slice(2)}.jsonl`,
        drops: a.bytes.toString('utf8').split('\n').filter(Boolean).length,
        bytes: a.bytes.length,
        hash: leaves[i].hash.slice(2)
      }))
    }),
    'utf8'
  );
  const files: Record<string, Uint8Array> = {};
  sorted.forEach((a) => {
    files[a.waveId] = a.bytes;
  });
  return { dropArchiveRoot: root, index, files };
}

async function rowsOf(waveId: string) {
  const drops = await sqlExecutor.execute<Record<string, unknown>>(
    `select id, serial_no, title, drop_type from ${DROPS_TABLE}
     where wave_id = :waveId order by id`,
    { waveId }
  );
  const parts = await sqlExecutor.execute<Record<string, unknown>>(
    `select drop_id, drop_part_id, content from ${DROPS_PARTS_TABLE}
     where wave_id = :waveId order by drop_id, drop_part_id`,
    { waveId }
  );
  return { drops, parts };
}

describeWithSeed(
  "the drop archive reader and a staying wave's rows",
  [
    withUserGroups([membersGroup]),
    withWaves([
      aWave(
        {
          created_by: CREATOR,
          visibility_group_id: membersGroup.id,
          chat_group_id: membersGroup.id
        },
        { id: STAYING, name: 'Staying wave', serial_no: 1 }
      ),
      aWave(
        { created_by: CREATOR },
        { id: MOVED, name: 'Moved wave', serial_no: 2 }
      )
    ]),
    { table: DROPS_TABLE, rows: stayingDrops },
    { table: DROPS_PARTS_TABLE, rows: stayingParts }
  ],
  () => {
    const movedDrops = FIXTURE_DROPS.filter((d) => d.wave_id === MOVED);

    it("skips a staying wave's archive and writes only the file's waves", async () => {
      const before = await rowsOf(STAYING);
      // Both waves' archives under the root, the file naming the moved one.
      const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
      const files: Record<string, Uint8Array> = {};
      built.archives.forEach((a) => {
        files[a.waveId] = a.bytes;
      });
      const report = await importWith(movedOnlyFile(built), built.index, files);
      expect(report.refused).toEqual([]);
      expect(report.skipped.map((s) => s.legacyWave)).toEqual([STAYING]);
      expect(report).toMatchObject({ written: 1, drops: movedDrops.length });
      expect(await rowsOf(STAYING)).toEqual(before);
      expect((await rowsOf(MOVED)).drops.map((d) => d.id)).toEqual(
        movedDrops.map((d) => d.id).sort()
      );
    });

    it("refuses a moved wave's archive holding a staying wave's drop, and writes none of it", async () => {
      const before = await rowsOf(STAYING);
      const [stayingArchive] = buildDropArchives(
        FIXTURE_DROPS.filter((d) => d.wave_id === STAYING),
        FIXTURE_PARTS
      ).archives;
      const [movedArchive] = buildDropArchives(
        movedDrops,
        FIXTURE_PARTS
      ).archives;
      const mixed = committed([
        {
          ...movedArchive,
          bytes: Buffer.concat([
            movedArchive.bytes,
            Buffer.from(
              stayingArchive.bytes.toString('utf8').split('\n')[0] + '\n',
              'utf8'
            )
          ])
        }
      ]);
      const report = await importWith(
        movedOnlyFile(mixed),
        mixed.index,
        mixed.files
      );
      expect(report.refused).toEqual([
        {
          waveId: movedArchive.waveId,
          reason: expect.stringContaining('the drop is of another wave')
        }
      ]);
      expect(report.written).toBe(0);
      expect(await rowsOf(STAYING)).toEqual(before);
      expect((await rowsOf(MOVED)).drops).toEqual([]);
    });

    it("never overwrites a staying wave's row a moved wave's drop shares an id with", async () => {
      const before = await rowsOf(STAYING);
      const clash = buildDropArchives(
        movedDrops.map((d, i) => (i === 0 ? { ...d, id: STAYING_DROP(1) } : d)),
        FIXTURE_PARTS.map((p) =>
          p.drop_id === movedDrops[0].id
            ? { ...p, drop_id: STAYING_DROP(1) }
            : p
        )
      );
      const files: Record<string, Uint8Array> = {};
      clash.archives.forEach((a) => {
        files[a.waveId] = a.bytes;
      });
      await expect(
        importWith(movedOnlyFile(clash), clash.index, files)
      ).rejects.toThrow('ER_DUP_ENTRY');
      expect(await rowsOf(STAYING)).toEqual(before);
    });
  }
);
