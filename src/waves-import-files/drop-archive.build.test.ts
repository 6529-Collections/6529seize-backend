import {
  FIXTURE_DROPS,
  FIXTURE_EXPECTED,
  FIXTURE_PARTS
} from '@/tests/fixtures/drop-archive.fixture';
import {
  ArchiveExporter,
  buildDropArchives
} from '@/waves-import-files/drop-archive.build';

describe('drop archives built from rows', () => {
  const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);

  it.each(['site', 'public'] as ArchiveExporter[])(
    'are byte for byte what the snapshot tooling writes from the %s export',
    (exporter) => {
      const archives = buildDropArchives(
        FIXTURE_DROPS,
        FIXTURE_PARTS,
        exporter
      );
      expect(
        archives.archives.map((archive) => ({
          legacyWave: archive.legacyWave,
          waveId: archive.waveId,
          hash: archive.hash,
          bytes: archive.bytes.length
        }))
      ).toEqual(FIXTURE_EXPECTED[exporter].archives);
      expect(archives.dropArchiveRoot).toBe(
        FIXTURE_EXPECTED[exporter].dropArchiveRoot
      );
    }
  );

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

  it("write the API's view, and the table's own values from 6529.io's export", () => {
    const lines = (exporter: ArchiveExporter) =>
      buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS, exporter)
        .archives[0].bytes.toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    // The native entry: PARTICIPATORY and a reply's part 0 as the API shows
    // it; COMPETITION and the null part in the table.
    expect(lines('site')[1]).toMatchObject({
      drop_type: 'PARTICIPATORY',
      reply_to: { drop_id: FIXTURE_DROPS[0].id, part_id: 0 },
      table: {
        signature: null,
        is_additional_action_promised: null,
        hide_link_preview: false,
        collapse_replies: false,
        drop_type: 'COMPETITION',
        reply_to_part_id: null
      }
    });
    expect(lines('public')[1].table).toBeNull();
  });

  it('list each archive in an index the reader takes', () => {
    const index = JSON.parse(built.index.toString('utf8'));
    expect(index.dropArchiveRoot).toBe(
      FIXTURE_EXPECTED.site.dropArchiveRoot.slice(2)
    );
    expect(index.archives.map((a: { hash: string }) => a.hash)).toEqual(
      FIXTURE_EXPECTED.site.archives.map((a) => a.hash.slice(2))
    );
    expect(index.drops).toBe(4);
  });
});
