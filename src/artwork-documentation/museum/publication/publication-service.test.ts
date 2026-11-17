import { randomUUID } from 'node:crypto';
import { RequestContext } from '@/request.context';
import { artistCapabilities } from '../../artwork-documentation.access';
import { ArtworkDocumentationDb } from '../../artwork-documentation.db';
import { ArtworkDocumentationService } from '../../artwork-documentation.service';
import {
  AD_EVENTS,
  AD_MUSEUM_RECORDS,
  AD_PUBLICATIONS,
  AD_REVIEWS,
  AD_REVISIONS,
  AD_SOURCES
} from '../../artwork-documentation.tables';
import { ContextAccess, Mutation } from '../../artwork-documentation.types';
import {
  digest,
  fail,
  normalizeJson
} from '../../artwork-documentation.validation';
import { ARTWORK_ASSETS_TABLE } from '../../assets/artwork-assets.types';
import { ArtworkDossierService } from '../export/dossier.service';
import { corpusId } from '../fixtures/museum-corpus';
import { publicationFixture } from '../fixtures/publication-fixtures';
import {
  ArtworkPublicationService,
  PublicationRequest
} from './publication.service';
import { PublicationStore } from './publication.storage';

type Row = Record<string, unknown>;

function fixture(
  options: {
    confirmed?: boolean;
    storageKey?: string | null;
    storageError?: boolean;
  } = {}
) {
  const { input } = publicationFixture('still-image');
  const snapshot = input.snapshot;
  const context = snapshot.context;
  for (const asset of snapshot.assets) {
    asset.scan_status = 'NO_THREATS_FOUND';
    asset.object_version = '1';
  }
  const revisionSnapshot = normalizeJson({
    modules: context.modules,
    asset_links: context.asset_links,
    profile: context.profile,
    artist_record_revision_id: null,
    sources: []
  });
  const revision: Row = {
    id: randomUUID(),
    revision_number: 1,
    source_draft_version: options.confirmed === false ? 0 : 1,
    snapshot_json: JSON.stringify(revisionSnapshot),
    confirmation_json: JSON.stringify({ confirmed_at: 1 }),
    sha256: digest(revisionSnapshot),
    created_at: 1
  };
  context.latest_revision_id = revision.id as string;
  const access: ContextAccess = {
    context,
    actorProfileId: 'synthetic-corpus-owner',
    isArtist: true,
    capabilities: artistCapabilities()
  };
  const transaction: RequestContext = { connection: { connection: {} } };
  const publications: Row[] = [];
  const events: Row[] = [];
  const cache = new Map<string, { hash: string; result: Row }>();
  const db = {
    executeNativeQueriesInTransaction: jest.fn(
      async (run: (c: RequestContext['connection']) => Promise<unknown>) =>
        run(transaction.connection)
    ),
    query: jest.fn(async (sql: string, params: Row) => {
      if (sql.includes(`FROM ${ARTWORK_ASSETS_TABLE} `))
        return snapshot.assets.filter((asset) =>
          (params.assetIds as string[]).includes(asset.id)
        );
      if (sql.includes(`FROM ${AD_MUSEUM_RECORDS} `)) return [];
      if (sql.includes(`FROM ${AD_SOURCES} `)) return [];
      if (sql.includes(`FROM ${AD_REVIEWS} `)) return [];
      if (sql.includes(`FROM ${AD_REVISIONS} `)) return [revision];
      if (sql.startsWith(`UPDATE ${AD_PUBLICATIONS} SET state='withdrawn'`)) {
        const row = publications.find(
          (item) =>
            item.id === params.publicationId && item.state === 'published'
        );
        if (row)
          Object.assign(row, { state: 'withdrawn', withdrawn_at: params.now });
        return [];
      }
      if (sql.startsWith(`UPDATE ${AD_PUBLICATIONS} SET storage_key`)) {
        const row = publications.find((item) => item.id === params.id);
        if (row) row.storage_key = params.key;
        return [];
      }
      if (
        sql.includes(
          `FROM ${AD_PUBLICATIONS} WHERE context_id=:id ORDER BY version DESC`
        )
      )
        return publications
          .filter((item) => item.context_id === params.id)
          .sort((a, b) => Number(b.version) - Number(a.version));
      throw new Error(`Unexpected query ${sql}`);
    }),
    one: jest.fn(async (sql: string, params: Row): Promise<unknown> => {
      if (sql.includes('COUNT(*)')) return { count: 0 };
      if (sql.includes(' AS bytes ')) return { bytes: 0 };
      if (!sql.includes(`FROM ${AD_PUBLICATIONS}`))
        throw new Error(`Unexpected query ${sql}`);
      if (sql.includes('MAX(version)'))
        return {
          max:
            publications
              .filter((item) => item.context_id === params.id)
              .reduce((max, item) => Math.max(max, Number(item.version)), 0) ||
            null
        };
      if (sql.includes("state='published' ORDER BY version"))
        return (
          publications.find(
            (item) =>
              item.context_id === params.id &&
              item.source_sha256 === params.source &&
              item.input_digest === params.input &&
              item.state === 'published'
          ) ?? null
        );
      if (sql.includes('id=:publicationId'))
        return (
          publications.find(
            (item) =>
              item.context_id === params.id && item.id === params.publicationId
          ) ?? null
        );
      return publications.find((item) => item.id === params.id) ?? null;
    }),
    insert: jest.fn(async (table: string, row: Row) => {
      if (table === AD_PUBLICATIONS) publications.push({ ...row });
      if (table === AD_EVENTS) events.push(row);
    }),
    idempotent: jest.fn(
      async (
        id: string,
        hash: string,
        _ctx: RequestContext,
        run: (tx: RequestContext) => Promise<Row>
      ) => {
        const previous = cache.get(id);
        if (previous && previous.hash !== hash)
          fail(409, 'IDEMPOTENCY_MISMATCH');
        if (previous) return previous.result;
        const result = await run(transaction);
        cache.set(id, { hash, result });
        return result;
      }
    )
  };
  const core = new ArtworkDocumentationService(
    db as unknown as ArtworkDocumentationDb
  );
  jest.spyOn(core, 'authorizeContext').mockResolvedValue(access);
  const dossier = new ArtworkDossierService(core);
  const storage: PublicationStore = {
    store: jest.fn(async () => {
      if (options.storageError) throw new Error('bucket unavailable');
      return options.storageKey ?? null;
    })
  };
  const service = new ArtworkPublicationService(core, dossier, storage);
  const request = (): PublicationRequest => ({
    source_sha256: '',
    selection: input.selection,
    bindings: input.bindings,
    rights: input.rights,
    roles: input.roles
  });
  const mutation = (
    body: unknown,
    expectedVersion: number | undefined = 1,
    key: string = randomUUID()
  ): Mutation => ({
    key,
    route: `POST:/contexts/${context.id}/publications`,
    body,
    expectedVersion
  });
  return {
    input,
    context,
    dossier,
    service,
    storage,
    publications,
    events,
    request,
    mutation,
    db
  };
}

async function sourceHash(f: ReturnType<typeof fixture>) {
  return (await f.dossier.inspect(f.context.id, {})).source_sha256;
}

afterEach(() => jest.restoreAllMocks());

describe('Artwork publication service', () => {
  it('publishes a verified selection, serves it publicly, reuses identical input and withdraws', async () => {
    const f = fixture({ storageKey: 'museum/publications/x/y/manifest.json' });
    const body = { ...f.request(), source_sha256: await sourceHash(f) };
    const first = await f.service.publish(
      f.context.id,
      body,
      f.mutation(body),
      {}
    );
    expect(first).toMatchObject({
      context_id: f.context.id,
      revision_id: f.context.latest_revision_id,
      version: 1,
      state: 'published',
      source_sha256: body.source_sha256,
      manifest_url: `${f.input.bindings.base_url}/manifest`,
      manifest_api_path: `/api/museum/iiif/${first.id}/manifest`,
      withdrawn_at: null
    });
    expect(f.storage.store).toHaveBeenCalledWith(
      expect.objectContaining({
        id: first.id,
        manifest_sha256: first.manifest_sha256
      })
    );
    expect(f.publications[0].storage_key).toBe(
      'museum/publications/x/y/manifest.json'
    );
    const served = await f.service.publicManifest(first.id);
    expect(digest(served)).toBe(first.manifest_sha256);
    expect(served).toMatchObject({
      id: `${f.input.bindings.base_url}/manifest`,
      type: 'Manifest',
      rights: 'http://creativecommons.org/publicdomain/zero/1.0/'
    });
    expect(served.metadata).toContainEqual({
      label: { en: ['Source record digest'] },
      value: { en: [`sha256:${body.source_sha256}`] }
    });
    expect(JSON.parse(f.publications[0].input_json as string)).toEqual(body);
    expect(JSON.stringify(served)).not.toContain('private-test');
    const replay = await f.service.publish(
      f.context.id,
      body,
      f.mutation(body, 1, f.mutation(body).key),
      {}
    );
    expect(replay.id).toBe(first.id);
    const again = await f.service.publish(
      f.context.id,
      body,
      f.mutation(body),
      {}
    );
    expect(again.id).toBe(first.id);
    expect(f.publications).toHaveLength(1);
    expect(await f.service.list(f.context.id, {})).toEqual([first]);
    const withdrawn = await f.service.withdraw(
      f.context.id,
      first.id,
      f.mutation(null, undefined),
      {}
    );
    expect(withdrawn.state).toBe('withdrawn');
    expect(withdrawn.withdrawn_at).toEqual(expect.any(Number));
    await expect(f.service.publicManifest(first.id)).rejects.toMatchObject({
      code: 'PUBLICATION_WITHDRAWN'
    });
    const second = await f.service.publish(
      f.context.id,
      body,
      f.mutation(body),
      {}
    );
    expect(second.version).toBe(2);
    expect(second.id).not.toBe(first.id);
    expect(f.events.map((event) => event.kind)).toEqual([
      'artwork_publication_created',
      'artwork_publication_withdrawn',
      'artwork_publication_created'
    ]);
    await expect(f.service.publicManifest(randomUUID())).rejects.toMatchObject({
      message: 'Publication not found'
    });
    await expect(f.service.publicManifest('not-a-uuid')).rejects.toMatchObject({
      message: 'Publication not found'
    });
  });

  it('keeps serving from the row when the immutable copy fails', async () => {
    const f = fixture({ storageError: true });
    const body = { ...f.request(), source_sha256: await sourceHash(f) };
    const published = await f.service.publish(
      f.context.id,
      body,
      f.mutation(body),
      {}
    );
    expect(f.publications[0].storage_key).toBeNull();
    await expect(f.service.publicManifest(published.id)).resolves.toMatchObject(
      { type: 'Manifest' }
    );
  });

  it('requires a current confirmed revision and a matching source digest', async () => {
    const unconfirmed = fixture({ confirmed: false });
    const stale = {
      ...unconfirmed.request(),
      source_sha256: await sourceHash(unconfirmed)
    };
    await expect(
      unconfirmed.service.publish(
        unconfirmed.context.id,
        stale,
        unconfirmed.mutation(stale),
        {}
      )
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const f = fixture();
    const body = { ...f.request(), source_sha256: 'b'.repeat(64) };
    await expect(
      f.service.publish(f.context.id, body, f.mutation(body), {})
    ).rejects.toMatchObject({ code: 'DOSSIER_SOURCE_CHANGED' });
    const current = { ...f.request(), source_sha256: await sourceHash(f) };
    await expect(
      f.service.publish(f.context.id, current, f.mutation(current, 2), {})
    ).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
    expect(f.publications).toEqual([]);
  });

  it('maps compiler rejections and malformed bodies to 422 codes without writing', async () => {
    const f = fixture();
    const source_sha256 = await sourceHash(f);
    const base = f.request();
    const cases: [unknown, string][] = [
      [
        { ...base, source_sha256, roles: { [corpusId(100)]: 'museum_copy' } },
        'UNSUPPORTED_ROLE'
      ],
      [
        { ...base, source_sha256, bindings: { ...base.bindings, media: {} } },
        'MISSING_MEDIA_BINDING'
      ],
      [
        {
          ...base,
          source_sha256,
          bindings: { ...base.bindings, base_url: 'http://6529.io/iiif/x' }
        },
        'INVALID_BASE_URL'
      ],
      [
        {
          ...base,
          source_sha256,
          rights: { ...base.rights, rights_uri: 'https://example.org/l' }
        },
        'RIGHTS_URI_NOT_IN_REGISTRY'
      ],
      [
        { ...base, source_sha256, selection: { asset_ids: [randomUUID()] } },
        'UNKNOWN_ASSET'
      ],
      [{ ...base, source_sha256, extra: true }, 'INVALID_PUBLICATION_REQUEST'],
      [
        { ...base, source_sha256: 'G'.repeat(64) },
        'INVALID_PUBLICATION_REQUEST'
      ],
      [
        { ...base, source_sha256, selection: { asset_ids: ['not-a-uuid'] } },
        'INVALID_PUBLICATION_REQUEST'
      ],
      ['text', 'INVALID_PUBLICATION_REQUEST']
    ];
    for (const [body, code] of cases)
      await expect(
        f.service.publish(f.context.id, body, f.mutation(body), {})
      ).rejects.toMatchObject({ code });
    expect(f.publications).toEqual([]);
    expect(f.storage.store).not.toHaveBeenCalled();
  });

  it('refuses rights evidence even when it is linked as a public asset', async () => {
    const f = fixture();
    f.input.snapshot.assets[0].access_class = 'rights_evidence';
    const body = { ...f.request(), source_sha256: await sourceHash(f) };
    await expect(
      f.service.publish(f.context.id, body, f.mutation(body), {})
    ).rejects.toMatchObject({ code: 'RIGHTS_EVIDENCE_ASSET' });
  });

  it('answers 404 for a withdraw of an unknown or foreign publication', async () => {
    const f = fixture();
    await expect(
      f.service.withdraw(
        f.context.id,
        randomUUID(),
        f.mutation(null, undefined),
        {}
      )
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      f.service.withdraw(f.context.id, 'nope', f.mutation(null, undefined), {})
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
