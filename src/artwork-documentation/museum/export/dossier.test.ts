import { createHash } from 'node:crypto';
import { compileDossier, dossierSourceHash } from './dossier';
import { dossierFixture } from './dossier-fixture';
import { verifiedTar, tarHeader } from './tar';
import { wrapDossierInOcfl, OCFL_BAG_PREFIX } from './ocfl';
import { reconstructDossier } from './reconstruct';

async function collect(source: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('Portable artwork dossier', () => {
  it('covers every payload with a reproducible digest and retains original writing', () => {
    const { snapshot } = dossierFixture();
    const compiled = compileDossier(snapshot);
    const record = JSON.parse(
      compiled.files
        .find((file) => file.path === 'data/record.json')!
        .bytes.toString()
    );
    expect(record.modules.context.documents.value[0].text).toBe(
      'The image contains <a gate> & water.\nA second paragraph.'
    );
    expect(record.assets[0]).not.toHaveProperty('bucket');
    expect(record.assets[0]).not.toHaveProperty('object_key');
    for (const file of compiled.files.filter((file) =>
      file.path.startsWith('data/')
    )) {
      expect(
        compiled.manifest.find((entry) => entry.path === file.path)?.sha256
      ).toBe(createHash('sha256').update(file.bytes).digest('hex'));
    }
    expect(
      compiled.files
        .find((file) => file.path === 'manifest-sha256.txt')!
        .bytes.toString()
    ).toContain(snapshot.assets[0].sha256);
    expect(compileDossier(snapshot).files.map((file) => file.sha256)).toEqual(
      compiled.files.map((file) => file.sha256)
    );
    expect(dossierSourceHash(snapshot)).toHaveLength(64);
  });
  it('never includes restricted historical confirmation content in a publication bag', () => {
    const { snapshot } = dossierFixture();
    snapshot.confirmed_revision = {
      id: 'old',
      sha256: 'old-digest',
      source_draft_version: 1,
      snapshot_json: JSON.stringify({
        secret: { intended_visibility: 'restricted', value: 'DO NOT EXPORT' }
      }),
      confirmation_json: '{}'
    };
    const compiled = compileDossier(snapshot);
    expect(
      compiled.files
        .find((file) => file.path === 'data/record.json')!
        .bytes.toString()
    ).not.toContain('DO NOT EXPORT');
    expect(
      compiled.issues.some(
        (issue) => issue.code === 'HISTORICAL_CONFIRMATION_RETAINED_BY_HASH'
      )
    ).toBe(true);
  });
  it('packages exact original bytes and rejects corrupt originals before completing the tar', async () => {
    const { snapshot, original } = dossierFixture();
    const entry = {
      path: 'data/original.bin',
      size_bytes: original.length,
      sha256: snapshot.assets[0].sha256!,
      source: [original]
    };
    const tar = await collect(verifiedTar([entry]));
    expect(tar.subarray(512, 512 + original.length)).toEqual(original);
    expect(tar.length % 512).toBe(0);
    await expect(
      collect(
        verifiedTar([{ ...entry, source: [Buffer.alloc(original.length)] }])
      )
    ).rejects.toThrow('fixity');
    await expect(collect(verifiedTar([entry, entry]))).rejects.toThrow(
      'Duplicate'
    );
    expect(() => tarHeader('../outside', 5)).toThrow();
    expect(() => tarHeader('data//empty', 5)).toThrow();
  });
  it('reconstructs the complete artwork and museum records from OCFL and BagIt without a database', async () => {
    const { snapshot, original } = dossierFixture();
    const compiled = compileDossier(snapshot);
    const ocfl = wrapDossierInOcfl(snapshot, compiled);
    const files = new Map(ocfl.files.map((file) => [file.path, file.bytes]));
    files.set(
      OCFL_BAG_PREFIX +
        compiled.manifest.find((entry) => 'asset_id' in entry)!.path,
      original
    );
    const reader = {
      async *read(path: string) {
        const bytes = files.get(path);
        if (!bytes) throw new Error('Missing package file');
        yield bytes;
      }
    };
    const restored = await reconstructDossier(reader);
    expect(restored.record.modules).toEqual(snapshot.context.modules);
    expect(restored.record.work_id).toBe(snapshot.context.work_id);
    expect(restored.museum_records).toEqual([]);
    expect(restored.permissions_restored).toBe(false);
    const originalPath = Array.from(files.keys()).find((path) =>
      path.includes('/originals/')
    )!;
    files.set(originalPath, Buffer.from('Changed bytes'));
    await expect(reconstructDossier(reader)).rejects.toThrow('fixity');
  });
  it('uses a POSIX size record for an 8 GiB original instead of truncating the USTAR size field', async () => {
    const iterator = verifiedTar([
      {
        path: 'v1/content/bag/data/originals/master.tiff',
        size_bytes: 8 * 1024 ** 3,
        sha256: 'a'.repeat(64),
        source: []
      }
    ]);
    const header = (await iterator.next()).value!;
    expect(header.toString('ascii', 156, 157)).toBe('x');
    const pax = (await iterator.next()).value!.toString('ascii');
    expect(pax.endsWith(' size=8589934592\n')).toBe(true);
    expect(Number(pax.split(' ')[0])).toBe(Buffer.byteLength(pax));
    await iterator.return(undefined);
    await expect(
      collect(
        verifiedTar([
          {
            path: 'data/original',
            size_bytes: Number.POSITIVE_INFINITY,
            sha256: 'a'.repeat(64),
            source: []
          }
        ])
      )
    ).rejects.toThrow('Invalid archive entry');
  });
});
