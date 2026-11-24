import { DROPS_PARTS_TABLE, DROPS_TABLE } from '@/constants';
import { wavesLegacyRows } from '@/rebuild/steps/waves-legacy.steps';
import {
  FIXTURE_DROPS,
  FIXTURE_PARTS,
  FIXTURE_WAVES
} from '@/tests/fixtures/drop-archive.fixture';
import {
  buildDropArchives,
  BuiltDropArchives,
  DropPartRowForArchive,
  DropRowForArchive,
  wavesFileCommitting
} from '@/waves-import-files/drop-archive.build';
import {
  canonicalJson,
  dropArchiveRoot,
  keccak256Hex
} from '@/waves-import-files/drop-archive.format';
import {
  DropArchiveFiles,
  DropArchiveReport,
  importDropArchives,
  WRITE_BATCH
} from '@/waves-import-files/drop-archive.reader';
import {
  DropArchiveDropRow,
  DropArchivePartRow
} from '@/waves-import-files/drop-archive.rows';

interface World {
  /** Archive bytes by chain wave id. */
  readonly archives: Record<string, Uint8Array>;
  readonly written: {
    drops: DropArchiveDropRow[];
    parts: DropArchivePartRow[];
    writes: number;
  };
  /** The chain's imported file hash: the built file's unless replaced. */
  chainHash: string | null;
  readonly files: DropArchiveFiles;
  run(): Promise<DropArchiveReport>;
}

/** A chain, files and a writer over built archives, each part replaceable. */
function world(built: BuiltDropArchives): World {
  const wavesFile = wavesFileCommitting(built.dropArchiveRoot);
  const archives: Record<string, Uint8Array> = {};
  built.archives.forEach((archive) => {
    archives[archive.waveId] = archive.bytes;
  });
  const w: World = {
    archives,
    written: { drops: [], parts: [], writes: 0 },
    chainHash: keccak256Hex(wavesFile),
    files: {
      wavesFile: async () => wavesFile,
      archiveIndex: async () => built.index,
      archive: async (waveId) => archives[waveId] ?? null
    },
    run: () =>
      importDropArchives({
        chain: { importedFileHash: async () => w.chainHash },
        files: w.files,
        writer: {
          write: async (drops, parts) => {
            w.written.drops.push(...drops);
            w.written.parts.push(...parts);
            w.written.writes++;
          }
        }
      })
  };
  return w;
}

function worldOf(
  drops: readonly DropRowForArchive[],
  parts: readonly DropPartRowForArchive[]
): World {
  return world(buildDropArchives(drops, parts));
}

/** An index whose entries are replaced, keeping the tooling's layout. */
function indexWith(
  built: BuiltDropArchives,
  edit: (archives: Record<string, unknown>[]) => Record<string, unknown>[]
): Buffer {
  const index = JSON.parse(built.index.toString('utf8'));
  index.archives = edit(index.archives);
  return Buffer.from(JSON.stringify(index));
}

describe('importDropArchives', () => {
  it("recreates the legacy seed's drops and parts row for row", async () => {
    const seed = wavesLegacyRows();
    const seedDrops = seed[DROPS_TABLE] as unknown as DropRowForArchive[];
    const seedParts = seed[
      DROPS_PARTS_TABLE
    ] as unknown as DropPartRowForArchive[];
    const w = worldOf(seedDrops, seedParts);
    const report = await w.run();
    expect(report.refused).toEqual([]);
    expect(report).toMatchObject({
      archives: 3,
      written: 3,
      drops: 6,
      parts: 6
    });
    const byId = <T extends { id?: string; drop_id?: string }>(rows: T[]) =>
      [...rows].sort((a, b) =>
        String(a.id ?? a.drop_id).localeCompare(String(b.id ?? b.drop_id))
      );
    // The columns the seed leaves to their defaults come back as those.
    expect(byId(w.written.drops)).toEqual(
      byId(
        seed[DROPS_TABLE].map((row) => ({
          ...row,
          is_additional_action_promised: null,
          collapse_replies: false
        })) as unknown as DropArchiveDropRow[]
      )
    );
    expect(byId(w.written.parts)).toEqual(
      byId(seed[DROPS_PARTS_TABLE] as unknown as DropArchivePartRow[])
    );
  });

  it("writes the API's values: a native entry as PARTICIPATORY, a reply's missing part as 0", async () => {
    const w = worldOf(FIXTURE_DROPS, FIXTURE_PARTS);
    const report = await w.run();
    expect(report.refused).toEqual([]);
    const entry = w.written.drops.find((d) => d.id === FIXTURE_DROPS[2].id);
    expect(entry).toMatchObject({
      drop_type: 'PARTICIPATORY',
      reply_to_drop_id: FIXTURE_DROPS[0].id,
      reply_to_part_id: 0,
      serial_no: 8,
      created_at: FIXTURE_DROPS[2].created_at
    });
    const quote = w.written.parts.find(
      (p) => p.drop_id === FIXTURE_DROPS[1].id
    );
    expect(quote).toEqual({
      drop_id: FIXTURE_DROPS[1].id,
      drop_part_id: 1,
      content: null,
      quoted_drop_id: FIXTURE_DROPS[0].id,
      quoted_drop_part_id: 1,
      wave_id: FIXTURE_WAVES.a
    });
    const twoParts = w.written.parts.filter(
      (p) => p.drop_id === FIXTURE_DROPS[0].id
    );
    expect(twoParts.map((p) => p.content)).toEqual([
      FIXTURE_PARTS[1].content,
      FIXTURE_PARTS[0].content
    ]);
    expect(
      w.written.drops.find((d) => d.id === FIXTURE_DROPS[0].id)?.parts_count
    ).toBe(2);
  });

  it('refuses and counts a tampered archive, writes none of it, and writes the others', async () => {
    const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
    const w = world(built);
    const [a, b] = built.archives;
    const tampered = Buffer.from(a.bytes);
    tampered[tampered.indexOf('an entry')] = 'A'.charCodeAt(0);
    w.archives[a.waveId] = tampered;
    const report = await w.run();
    expect(report.refused).toEqual([
      {
        waveId: a.waveId,
        reason: `it hashes to ${keccak256Hex(tampered)}, the root commits ${a.hash}`
      }
    ]);
    expect(report.written).toBe(1);
    expect(w.written.drops.map((d) => d.wave_id)).toEqual([b.legacyWave]);
  });

  it('refuses everything when the Waves v1 file is not the one the chain imported', async () => {
    const w = worldOf(FIXTURE_DROPS, FIXTURE_PARTS);
    w.chainHash = `0x${'11'.repeat(32)}`;
    const report = await w.run();
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0].waveId).toBeNull();
    expect(report.refused[0].reason).toContain('the chain imported');
    expect(w.written.drops).toEqual([]);
  });

  it('refuses everything before the chain completed its waves import', async () => {
    const w = worldOf(FIXTURE_DROPS, FIXTURE_PARTS);
    w.chainHash = null;
    const report = await w.run();
    expect(report.refused).toEqual([
      { waveId: null, reason: 'the chain has no completed waves import' }
    ]);
    expect(w.written.drops).toEqual([]);
  });

  it('refuses everything when the index is not the committed list', async () => {
    const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
    const w = world(built);
    // The tampered archive with its index entry changed to match.
    const [a] = built.archives;
    const tampered = Buffer.from(a.bytes);
    tampered[tampered.indexOf('an entry')] = 'A'.charCodeAt(0);
    w.archives[a.waveId] = tampered;
    const index = indexWith(built, (entries) =>
      entries.map((entry, i) =>
        i === 0 ? { ...entry, hash: keccak256Hex(tampered).slice(2) } : entry
      )
    );
    w.files.archiveIndex = async () => index;
    const report = await w.run();
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0].reason).toContain('the Waves v1 file commits');
    expect(w.written.drops).toEqual([]);
  });

  it('refuses everything when an archive is left out of the index', async () => {
    const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
    const w = world(built);
    const index = indexWith(built, (entries) => entries.slice(1));
    w.files.archiveIndex = async () => index;
    const report = await w.run();
    expect(report.refused[0].reason).toContain('gives root');
    expect(w.written.drops).toEqual([]);
  });

  it('refuses an index out of order and a malformed one', async () => {
    const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
    const w = world(built);
    const reversed = indexWith(built, (entries) => [...entries].reverse());
    w.files.archiveIndex = async () => reversed;
    expect((await w.run()).refused).toEqual([
      { waveId: null, reason: 'the archive index is not ascending by wave id' }
    ]);
    w.files.archiveIndex = async () => Buffer.from('{"archives": [{}]}');
    expect((await w.run()).refused[0].reason).toContain('malformed');
    w.files.archiveIndex = async () => null;
    expect((await w.run()).refused[0].reason).toBe(
      'the archive index is missing'
    );
    expect(w.written.drops).toEqual([]);
  });

  it('refuses a missing archive and an archive named for another wave', async () => {
    const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
    const w = world(built);
    const [a, b] = built.archives;
    delete w.archives[a.waveId];
    // The index names wave b's archive for wave a's 6529.io id: the root
    // still holds (it covers wave ids and hashes), the derivation does not.
    const index = indexWith(built, (entries) =>
      entries.map((entry, i) =>
        i === 1 ? { ...entry, legacyWave: a.legacyWave } : entry
      )
    );
    w.files.archiveIndex = async () => index;
    const report = await w.run();
    expect(report.refused).toEqual([
      { waveId: a.waveId, reason: 'the archive is missing' },
      {
        waveId: b.waveId,
        reason: 'its wave id is not its 6529.io wave chain id'
      }
    ]);
    expect(w.written.drops).toEqual([]);
  });

  it('refuses a committed archive whose lines are not drops of its wave', async () => {
    const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);
    const [a, b] = built.archives;
    // Wave b's archive holds a line of wave a: committed, but not a drop
    // of its own wave.
    const line = JSON.parse(a.bytes.toString('utf8').split('\n')[0]);
    const bytes = Buffer.from(
      b.bytes.toString('utf8') + canonicalJson(line) + '\n',
      'utf8'
    );
    const rebuilt: BuiltDropArchives = {
      ...built,
      archives: [a, { ...b, bytes, hash: keccak256Hex(bytes) }]
    };
    const index = indexWith(built, (entries) =>
      entries.map((entry, i) =>
        i === 1 ? { ...entry, hash: keccak256Hex(bytes).slice(2) } : entry
      )
    );
    const w = world({
      ...rebuilt,
      index,
      dropArchiveRoot: dropArchiveRoot(rebuilt.archives)
    });
    const report = await w.run();
    expect(report.refused).toEqual([
      { waveId: b.waveId, reason: 'line 2: the drop is of another wave' }
    ]);
    expect(w.written.drops.map((d) => d.wave_id)).toEqual([
      a.legacyWave,
      a.legacyWave,
      a.legacyWave
    ]);
  });

  it('refuses a drop id that two archives hold', async () => {
    const drops = [
      FIXTURE_DROPS[0],
      { ...FIXTURE_DROPS[0], wave_id: FIXTURE_WAVES.b, serial_no: 30 }
    ];
    const built = buildDropArchives(drops, []);
    const w = world(built);
    const report = await w.run();
    expect(report.refused).toEqual([
      { waveId: built.archives[1].waveId, reason: 'a drop id appears twice' }
    ]);
    expect(w.written.drops).toHaveLength(1);
  });

  it('refuses a serial number that two archives hold', async () => {
    const drops = [
      FIXTURE_DROPS[0],
      { ...FIXTURE_DROPS[3], serial_no: FIXTURE_DROPS[0].serial_no }
    ];
    const built = buildDropArchives(drops, []);
    const w = world(built);
    const report = await w.run();
    expect(report.refused).toEqual([
      {
        waveId: built.archives[1].waveId,
        reason: 'a serial number appears twice'
      }
    ]);
    expect(w.written.drops).toHaveLength(1);
  });

  it('writes in batches', async () => {
    const drops: DropRowForArchive[] = Array.from(
      { length: WRITE_BATCH + 3 },
      (_, i) => ({
        ...FIXTURE_DROPS[0],
        id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
        serial_no: i + 1
      })
    );
    const w = worldOf(drops, []);
    const report = await w.run();
    expect(report).toMatchObject({ drops: WRITE_BATCH + 3, parts: 0 });
    expect(w.written.writes).toBe(2);
    expect(w.written.drops.map((d) => d.serial_no)).toEqual(
      drops.map((d) => d.serial_no)
    );
  });
});
