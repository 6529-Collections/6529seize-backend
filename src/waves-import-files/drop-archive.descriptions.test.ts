import {
  FIXTURE_DROPS,
  FIXTURE_PARTS,
  FIXTURE_WAVES
} from '@/tests/fixtures/drop-archive.fixture';
import {
  buildDropArchives,
  BuiltDropArchives,
  DropRowForArchive,
  rawCidOf,
  wavesFileCommitting
} from '@/waves-import-files/drop-archive.build';
import {
  descriptionParts,
  resolveDescription,
  waveDescriptionOf
} from '@/waves-import-files/drop-archive.descriptions';
import {
  keccak256Hex,
  readWavesFileWaves
} from '@/waves-import-files/drop-archive.format';
import { importDropArchives } from '@/waves-import-files/drop-archive.reader';

/** A wave document as the snapshot tooling writes one (the fields read here). */
function waveDocument(
  legacyWave: string,
  description: { content: string | null; media: object[] }[],
  extra: Record<string, unknown> = {}
): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kind: 'wave',
      legacy_id: legacyWave,
      name: 'A made-up wave',
      description,
      ...extra
    }),
    'utf8'
  );
}

/** Wave A's description is drop 1's two parts; wave B's is drop 4's part. */
const DESCRIPTION_A = [
  { content: FIXTURE_PARTS[1].content, media: [] },
  { content: FIXTURE_PARTS[0].content, media: [] }
];
const DESCRIPTION_B = [{ content: FIXTURE_PARTS[4].content, media: [] }];

function run(
  built: BuiltDropArchives,
  documents: Record<string, Buffer | null>,
  withDocuments = true
) {
  const waves = Object.keys(documents).map((legacyWave) => ({
    legacyWave,
    documentCid: rawCidOf(documents[legacyWave] ?? Buffer.from(legacyWave))
  }));
  const wavesFile = wavesFileCommitting(
    built.dropArchiveRoot,
    undefined,
    waves
  );
  const byCid: Record<string, Buffer | null> = {};
  waves.forEach((w) => {
    byCid[w.documentCid] = documents[w.legacyWave];
  });
  const archives: Record<string, Uint8Array> = {};
  built.archives.forEach((a) => {
    archives[a.waveId] = a.bytes;
  });
  return importDropArchives({
    chain: { importedFileHash: async () => keccak256Hex(wavesFile) },
    files: {
      wavesFile: async () => wavesFile,
      archiveIndex: async () => built.index,
      archive: async (waveId) => archives[waveId] ?? null,
      ...(withDocuments
        ? { document: async (cid: string) => byCid[cid] ?? null }
        : {})
    },
    writer: { write: async () => undefined }
  });
}

describe('wave documents', () => {
  it('give their description as the archive lines hold parts', () => {
    const doc = waveDescriptionOf(
      waveDocument(FIXTURE_WAVES.a, [
        { content: 'a', media: [{ url: 'u', mime_type: 'image/png' }] }
      ])
    );
    expect(doc).toEqual({
      dropId: null,
      parts: descriptionParts([
        {
          part_id: 1,
          content: 'a',
          attachments: [],
          quoted_drop: null,
          media: [{ mime_type: 'image/png', url: 'u' }]
        }
      ])
    });
  });

  it('name the description drop when they carry its id', () => {
    const id = FIXTURE_DROPS[2].id;
    expect(
      waveDescriptionOf(
        waveDocument(FIXTURE_WAVES.a, [], { description_drop_id: id })
      ).dropId
    ).toBe(id);
    expect(() =>
      waveDescriptionOf(
        waveDocument(FIXTURE_WAVES.a, [], { description_drop_id: 7 })
      )
    ).toThrow('names its description drop wrongly');
  });

  it('are refused when they are not wave documents', () => {
    expect(() => waveDescriptionOf(Buffer.from('{'))).toThrow('not JSON');
    expect(() =>
      waveDescriptionOf(Buffer.from(JSON.stringify({ kind: 'group' })))
    ).toThrow('not a wave document');
    expect(() =>
      waveDescriptionOf(Buffer.from(JSON.stringify({ kind: 'wave' })))
    ).toThrow('has no description');
  });

  it('resolve only one match or the drop they name', () => {
    const plain = { dropId: null, parts: '[]' };
    expect(resolveDescription(plain, ['x'], false)).toEqual({ dropId: 'x' });
    expect(resolveDescription(plain, ['x', 'y'], false)).toEqual({
      reason: '2 drops match its description'
    });
    expect(resolveDescription(plain, [], false)).toEqual({
      reason: 'no drop matches its description'
    });
    const named = { dropId: 'z', parts: '[]' };
    expect(resolveDescription(named, ['x'], true)).toEqual({ dropId: 'z' });
    expect(resolveDescription(named, ['x'], false)).toEqual({
      reason: 'its archive does not hold the drop its document names'
    });
  });
});

describe("the reader's description drops", () => {
  const built = buildDropArchives(FIXTURE_DROPS, FIXTURE_PARTS);

  it("read the file's wave rows", () => {
    const file = wavesFileCommitting(built.dropArchiveRoot, undefined, [
      { legacyWave: FIXTURE_WAVES.a, documentCid: rawCidOf(Buffer.from('a')) }
    ]);
    expect(readWavesFileWaves(file)).toEqual([
      { legacyWave: FIXTURE_WAVES.a, metadataCid: rawCidOf(Buffer.from('a')) }
    ]);
  });

  it('are the one drop matching each wave document', async () => {
    const report = await run(built, {
      [FIXTURE_WAVES.a]: waveDocument(FIXTURE_WAVES.a, DESCRIPTION_A),
      [FIXTURE_WAVES.b]: waveDocument(FIXTURE_WAVES.b, DESCRIPTION_B)
    });
    expect(report.refused).toEqual([]);
    expect(Array.from(report.descriptionDropIds.entries())).toEqual([
      [FIXTURE_WAVES.a, FIXTURE_DROPS[0].id],
      [FIXTURE_WAVES.b, FIXTURE_DROPS[3].id]
    ]);
    expect(report.descriptionsUnresolved).toEqual([]);
  });

  it('leave out a wave whose description two drops match', async () => {
    const twice: DropRowForArchive[] = [
      ...FIXTURE_DROPS,
      {
        ...FIXTURE_DROPS[3],
        id: '11111111-1111-4111-8111-000000000005',
        serial_no: 21
      }
    ];
    const report = await run(
      buildDropArchives(twice, [
        ...FIXTURE_PARTS,
        { ...FIXTURE_PARTS[4], drop_id: twice[4].id }
      ]),
      {
        [FIXTURE_WAVES.a]: waveDocument(FIXTURE_WAVES.a, DESCRIPTION_A),
        [FIXTURE_WAVES.b]: waveDocument(FIXTURE_WAVES.b, DESCRIPTION_B)
      }
    );
    expect(report.descriptionDropIds.has(FIXTURE_WAVES.b)).toBe(false);
    expect(report.descriptionsUnresolved).toEqual([
      {
        legacyWave: FIXTURE_WAVES.b,
        reason: '2 drops match its description'
      }
    ]);
  });

  it('take the drop a document names, and report one its archive lacks', async () => {
    const report = await run(built, {
      [FIXTURE_WAVES.a]: waveDocument(FIXTURE_WAVES.a, DESCRIPTION_A, {
        description_drop_id: FIXTURE_DROPS[2].id
      }),
      [FIXTURE_WAVES.b]: waveDocument(FIXTURE_WAVES.b, DESCRIPTION_B, {
        description_drop_id: FIXTURE_DROPS[0].id
      })
    });
    expect(Array.from(report.descriptionDropIds.entries())).toEqual([
      [FIXTURE_WAVES.a, FIXTURE_DROPS[2].id]
    ]);
    expect(report.descriptionsUnresolved).toEqual([
      {
        legacyWave: FIXTURE_WAVES.b,
        reason: 'its archive does not hold the drop its document names'
      }
    ]);
  });

  it('refuse a wave whose document is missing, and report waves with no archive written', async () => {
    const wave = '22222222-2222-4222-8222-000000000009';
    const report = await run(built, {
      [FIXTURE_WAVES.a]: null,
      [FIXTURE_WAVES.b]: waveDocument(FIXTURE_WAVES.b, DESCRIPTION_B),
      [wave]: waveDocument(wave, [])
    });
    expect(report.refused).toEqual([
      {
        waveId: built.archives[0].waveId,
        reason: `its wave document ${rawCidOf(Buffer.from(FIXTURE_WAVES.a))} is missing`
      }
    ]);
    expect(report.descriptionsUnresolved).toEqual([
      {
        legacyWave: FIXTURE_WAVES.a,
        reason: 'no archive of the wave was written'
      },
      { legacyWave: wave, reason: 'no archive of the wave was written' }
    ]);
  });

  it('leave a wave unresolved whose document is not a wave document', async () => {
    const report = await run(built, {
      [FIXTURE_WAVES.a]: waveDocument(FIXTURE_WAVES.a, DESCRIPTION_A),
      [FIXTURE_WAVES.b]: Buffer.from(JSON.stringify({ kind: 'group' }))
    });
    expect(report.refused).toEqual([]);
    expect(report.descriptionsUnresolved).toEqual([
      {
        legacyWave: FIXTURE_WAVES.b,
        reason: 'the document is not a wave document'
      }
    ]);
  });

  it('are not looked for without a document source', async () => {
    const report = await run(
      built,
      { [FIXTURE_WAVES.a]: waveDocument(FIXTURE_WAVES.a, DESCRIPTION_A) },
      false
    );
    expect(report.descriptionDropIds.size).toBe(0);
    expect(report.descriptionsUnresolved).toEqual([]);
  });
});
