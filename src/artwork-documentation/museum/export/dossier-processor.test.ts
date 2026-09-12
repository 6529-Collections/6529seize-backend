import { Readable } from 'node:stream';
import { RequestContext } from '@/request.context';
import { ArtworkDocumentationDb } from '../../artwork-documentation.db';
import { artworkAssetStorage } from '../../assets/artwork-assets.storage';
import { dossierSourceHash } from './dossier';
import { dossierFixture } from './dossier-fixture';
import { DossierProcessor } from './dossier.processor';
import { DossierStorage } from './dossier.storage';
import { DossierExportRow } from './dossier.types';

function fixture() {
  const { snapshot, original } = dossierFixture();
  const row: DossierExportRow = {
    id: 'export-1',
    context_id: snapshot.context.id,
    actor_profile_id: 'test-reviewer',
    source_sha256: dossierSourceHash(snapshot),
    state: 'queued',
    snapshot_json: JSON.stringify(snapshot),
    object_version: null,
    sha256: null,
    size_bytes: null,
    failure_code: null,
    created_at: Date.now(),
    expires_at: Date.now() + 60000,
    lease_until: 0,
    attempts: 0
  };
  const connection: RequestContext['connection'] = { connection: {} };
  const db = {
    executeNativeQueriesInTransaction: jest.fn(
      async (run: (tx: RequestContext['connection']) => Promise<unknown>) =>
        run(connection)
    ),
    query: jest.fn(async () => []),
    one: jest.fn(async (): Promise<DossierExportRow | null> => row)
  };
  const chunks: Buffer[] = [];
  const storage = {
    upload: jest.fn(async (_id: string, source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) chunks.push(chunk);
      return {
        object_version: 'immutable-1',
        sha256: 'a'.repeat(64),
        size_bytes: Buffer.concat(chunks).length
      };
    }),
    readReport: jest.fn()
  };
  const originalStream = Readable.from([original]);
  const read = jest
    .spyOn(artworkAssetStorage, 'read')
    .mockResolvedValue(originalStream);
  const service = new DossierProcessor(
    db as unknown as ArtworkDocumentationDb,
    storage as unknown as DossierStorage
  );
  return {
    snapshot,
    original,
    row,
    db,
    storage,
    service,
    chunks,
    read,
    originalStream,
    connection
  };
}

afterEach(() => jest.restoreAllMocks());

it('claims transactionally, verifies original bytes and fences publication by the claimed lease', async () => {
  const f = fixture();
  expect(await f.service.tick()).toBe(true);
  expect(f.db.one).toHaveBeenCalledWith(
    expect.stringContaining('FOR UPDATE SKIP LOCKED'),
    expect.any(Object),
    { connection: f.connection }
  );
  expect(f.read).toHaveBeenCalledWith(
    expect.objectContaining({
      id: f.snapshot.assets[0].id,
      object_version: '1'
    }),
    expect.any(AbortSignal)
  );
  const queries = f.db.query.mock.calls as unknown[][];
  const ready = queries.find((call) =>
    String(call[0]).includes("SET state='ready'")
  );
  expect(ready?.[0]).toContain('AND lease_until=:lease');
  expect(ready?.[1]).toMatchObject({
    id: f.row.id,
    object_version: 'immutable-1'
  });
  expect(Buffer.concat(f.chunks).includes(f.original)).toBe(true);
  expect(f.originalStream.destroyed).toBe(true);
});

it.each(['snapshot', 'original'])(
  'fails closed on a changed %s and never publishes a ready export',
  async (changed) => {
    const f = fixture();
    if (changed === 'snapshot') f.row.source_sha256 = 'f'.repeat(64);
    else
      f.read.mockResolvedValue(
        Readable.from([Buffer.alloc(f.original.length)])
      );
    expect(await f.service.tick()).toBe(true);
    const queries = f.db.query.mock.calls as unknown[][];
    expect(
      queries.some((call) => String(call[0]).includes("SET state='ready'"))
    ).toBe(false);
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.stringContaining('failure_code=:code'),
          expect.objectContaining({ code: 'DOSSIER_EXPORT_FAILED' })
        ])
      ])
    );
    if (changed === 'snapshot') expect(f.storage.upload).not.toHaveBeenCalled();
  }
);

it('does not start storage work when no eligible lease exists', async () => {
  const f = fixture();
  f.db.one.mockResolvedValue(null);
  expect(await f.service.tick()).toBe(false);
  expect(f.storage.upload).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});
