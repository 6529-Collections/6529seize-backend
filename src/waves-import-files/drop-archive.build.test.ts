import {
  FIXTURE_DROPS,
  FIXTURE_EXPECTED,
  FIXTURE_PARTS
} from '@/tests/fixtures/drop-archive.fixture';
import { buildDropArchives } from '@/waves-import-files/drop-archive.build';

describe('drop archives built from rows', () => {
  const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);

  it('are byte for byte what the snapshot tooling writes', () => {
    expect(
      built.archives.map((archive) => ({
        legacyWave: archive.legacyWave,
        waveId: archive.waveId,
        hash: archive.hash,
        bytes: archive.bytes.length
      }))
    ).toEqual(FIXTURE_EXPECTED.archives);
    expect(built.dropArchiveRoot).toBe(FIXTURE_EXPECTED.dropArchiveRoot);
  });

  it('hold one line a drop, ascending by serial, parts by part id', () => {
    const [a] = built.archives;
    const lines = a.bytes.toString('utf8').split('\n');
    expect(lines.pop()).toBe('');
    const rows = lines.map((line) => JSON.parse(line));
    expect(rows.map((row) => row.serial_no)).toEqual([7, 8, 9]);
    expect(
      rows[0].parts.map((part: { part_id: number }) => part.part_id)
    ).toEqual([1, 2]);
    expect(rows[0].author_principal).toBe(FIXTURE_EXPECTED.firstPrincipal);
  });

  it("write the API's view: a native entry as PARTICIPATORY, a reply's missing part as 0", () => {
    const rows = built.archives[0].bytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows[1]).toMatchObject({
      drop_type: 'PARTICIPATORY',
      reply_to: { drop_id: FIXTURE_DROPS[0].id, part_id: 0 }
    });
  });

  it('list each archive in an index the reader takes', () => {
    const index = JSON.parse(built.index.toString('utf8'));
    expect(index.dropArchiveRoot).toBe(
      FIXTURE_EXPECTED.dropArchiveRoot.slice(2)
    );
    expect(index.archives.map((a: { hash: string }) => a.hash)).toEqual(
      FIXTURE_EXPECTED.archives.map((a) => a.hash.slice(2))
    );
    expect(index.drops).toBe(4);
  });
});
