import { randomUUID } from 'node:crypto';
import { RequestContext } from '@/request.context';
import { artistCapabilities } from '../../artwork-documentation.access';
import { ArtworkDocumentationDb } from '../../artwork-documentation.db';
import { ArtworkDocumentationService } from '../../artwork-documentation.service';
import {
  AD_DOSSIER_EXPORTS,
  AD_MUSEUM_RECORDS,
  AD_REVISIONS,
  AD_REVIEWS,
  AD_SOURCES
} from '../../artwork-documentation.tables';
import { ContextAccess, Mutation } from '../../artwork-documentation.types';
import { digest, fail } from '../../artwork-documentation.validation';
import { ARTWORK_ASSETS_TABLE } from '../../assets/artwork-assets.types';
import { dossierFixture } from './dossier-fixture';
import { ArtworkDossierService } from './dossier.service';
import { dossierStorage } from './dossier.storage';
import { DossierExportRow, DossierSnapshot } from './dossier.types';

function fixture() {
  const { snapshot } = dossierFixture();
  const context = snapshot.context;
  const access: ContextAccess = {
    context,
    actorProfileId: 'test-reviewer',
    isArtist: false,
    capabilities: artistCapabilities()
  };
  const transaction: RequestContext = { connection: { connection: {} } };
  const exports: DossierExportRow[] = [];
  const cache = new Map<
    string,
    { hash: string; result: Record<string, unknown> }
  >();
  const db = {
    executeNativeQueriesInTransaction: jest.fn(
      async (
        run: (connection: RequestContext['connection']) => Promise<unknown>
      ) => run(transaction.connection)
    ),
    query: jest.fn(async (sql: string, params: Record<string, unknown>) => {
      if (sql.includes(`FROM ${ARTWORK_ASSETS_TABLE} `))
        return snapshot.assets.filter((asset) =>
          (params.assetIds as string[]).includes(asset.id)
        );
      if (sql.includes(`FROM ${AD_MUSEUM_RECORDS} `))
        return snapshot.museum_records;
      if (sql.includes(`FROM ${AD_SOURCES} `)) return snapshot.source_receipts;
      if (sql.includes(`FROM ${AD_REVIEWS} `))
        return snapshot.review_history ?? [];
      if (sql.includes(`FROM ${AD_REVISIONS} `))
        return snapshot.artist_revisions ?? [];
      throw new Error('Unexpected snapshot query');
    }),
    one: jest.fn(
      async (
        sql: string,
        params: Record<string, unknown>
      ): Promise<unknown> => {
        if (sql.includes('COUNT(*)')) return { count: exports.length };
        if (sql.includes(' AS bytes ')) return { bytes: 0 };
        return (
          exports.find(
            (row) => row.context_id === params.id && row.id === params.exportId
          ) ?? null
        );
      }
    ),
    insert: jest.fn(async (table: string, row: Record<string, unknown>) => {
      if (table === AD_DOSSIER_EXPORTS)
        exports.push(row as unknown as DossierExportRow);
    }),
    idempotent: jest.fn(
      async (
        id: string,
        hash: string,
        _ctx: RequestContext,
        run: (tx: RequestContext) => Promise<Record<string, unknown>>
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
  const authorize = jest
    .spyOn(core, 'authorizeContext')
    .mockResolvedValue(access);
  const service = new ArtworkDossierService(core);
  const sign = jest
    .spyOn(dossierStorage, 'download')
    .mockResolvedValue('https://private.example/immutable-export');
  const mutation = (body: unknown): Mutation => ({
    key: 'test-request',
    route: `/contexts/${context.id}/dossier`,
    body,
    expectedVersion: context.draft_version
  });
  return {
    snapshot,
    context,
    access,
    transaction,
    db,
    core,
    authorize,
    service,
    sign,
    mutation,
    exports
  };
}

afterEach(() => jest.restoreAllMocks());

it.each(['g'.repeat(64), 'A'.repeat(64), `${'a'.repeat(63)} `])(
  'rejects a noncanonical source digest before queueing an export: %s',
  async (source_sha256) => {
    const f = fixture();
    const body = { source_sha256 };
    await expect(
      f.service.create(f.context.id, body, f.mutation(body), {})
    ).rejects.toThrow('INVALID_DOSSIER_REQUEST');
    expect(f.exports).toEqual([]);
    expect(f.db.idempotent).not.toHaveBeenCalled();
  }
);

it('blocks inspection readiness and export queueing for an uncleared interview, then accepts an exact file-scoped public grant', async () => {
  const f = fixture();
  const assetId = f.snapshot.assets[0].id;
  f.context.asset_links[0].role = 'interview_recording';
  f.context.asset_links[0].manifest.role = 'interview_recording';
  f.snapshot.assets[0].role = 'interview_recording';
  const denied = await f.service.inspect(f.context.id, {});
  expect(denied.can_export).toBe(false);
  expect(denied.issues).toContainEqual(
    expect.objectContaining({
      code: 'INTERVIEW_PUBLICATION_PERMISSION_REQUIRED',
      path: `asset:${assetId}`,
      severity: 'error'
    })
  );
  const rejectedBody = { source_sha256: denied.source_sha256 };
  await expect(
    f.service.create(f.context.id, rejectedBody, f.mutation(rejectedBody), {})
  ).rejects.toThrow('DOSSIER_VALIDATION_FAILED');
  expect(f.exports).toEqual([]);
  f.context.modules.rights.material_rights = {
    status: 'provided',
    intended_visibility: 'public_record',
    value: [
      {
        id: randomUUID(),
        subject_ids: [assetId],
        basis: 'license',
        account:
          'The participant permits publication of this exact interview recording.',
        uses: [{ use: 'publication', status: 'granted' }]
      }
    ]
  };
  const cleared = await f.service.inspect(f.context.id, {});
  expect(cleared.can_export).toBe(true);
  expect(
    cleared.issues.some(
      (issue) => issue.code === 'INTERVIEW_PUBLICATION_PERMISSION_REQUIRED'
    )
  ).toBe(false);
  const body = { source_sha256: cleared.source_sha256 };
  await expect(
    f.service.create(f.context.id, body, f.mutation(body), {})
  ).resolves.toMatchObject({ state: 'queued' });
  expect(f.exports).toHaveLength(1);
});

it('checks interview originals retained by historical revisions even after their current asset links are removed', async () => {
  const f = fixture();
  const historicalAsset = {
    ...f.snapshot.assets[0],
    id: randomUUID(),
    role: 'interview_recording' as const
  };
  f.snapshot.assets.push(historicalAsset);
  const historicalSource = {
    asset_links: [
      { asset_id: historicalAsset.id, intended_visibility: 'public_record' }
    ]
  };
  f.snapshot.artist_revisions = [
    {
      id: randomUUID(),
      sha256: digest(historicalSource),
      snapshot_json: JSON.stringify(historicalSource),
      confirmation_json: '{}',
      source_draft_version: 1
    }
  ];
  const before = JSON.stringify(f.snapshot.artist_revisions);
  const inspected = await f.service.inspect(f.context.id, {});
  expect(
    f.context.asset_links.some((link) => link.asset_id === historicalAsset.id)
  ).toBe(false);
  expect(inspected.can_export).toBe(false);
  expect(inspected.issues).toContainEqual(
    expect.objectContaining({
      code: 'INTERVIEW_PUBLICATION_PERMISSION_REQUIRED',
      path: `asset:${historicalAsset.id}`,
      severity: 'error'
    })
  );
  const body = { source_sha256: inspected.source_sha256 };
  await expect(
    f.service.create(f.context.id, body, f.mutation(body), {})
  ).rejects.toThrow('DOSSIER_VALIDATION_FAILED');
  expect(f.exports).toEqual([]);
  expect(JSON.stringify(f.snapshot.artist_revisions)).toBe(before);
});

it.each(['count', 'bytes'])(
  'rejects oversized history %s before fetching any raw history or file payloads',
  async (kind) => {
    const f = fixture();
    f.db.one.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*)')
        ? { count: kind === 'count' ? 10001 : 1 }
        : { bytes: 33 * 1024 ** 2 }
    );
    await expect(f.service.inspect(f.context.id, {})).rejects.toMatchObject({
      code: 'DOSSIER_RECORD_LIMIT'
    });
    expect(f.db.query).not.toHaveBeenCalled();
    expect(f.db.insert).not.toHaveBeenCalled();
  }
);

it('preflights only referenced asset rows and rejects their large metadata before loading it', async () => {
  const f = fixture();
  f.snapshot.assets.push({
    ...f.snapshot.assets[0],
    id: randomUUID(),
    technical_metadata_json: 'unreferenced-large-payload'
  });
  f.db.one.mockImplementation(
    async (sql: string, params: Record<string, unknown>) => {
      if (sql.includes('COUNT(*)')) return { count: 1 };
      if (sql.includes(`FROM ${ARTWORK_ASSETS_TABLE} `)) {
        expect(sql).toContain('id IN (:assetIds)');
        expect(params.assetIds).toEqual([f.snapshot.assets[0].id]);
        return { bytes: 33 * 1024 ** 2 };
      }
      return { bytes: 0 };
    }
  );
  await expect(f.service.inspect(f.context.id, {})).rejects.toMatchObject({
    code: 'DOSSIER_RECORD_LIMIT'
  });
  expect(
    f.db.query.mock.calls.some(([sql]) =>
      sql.includes(`FROM ${ARTWORK_ASSETS_TABLE} `)
    )
  ).toBe(false);
});

it('queues an immutable snapshot and returns the same export on a lost-response retry', async () => {
  const f = fixture();
  const before = JSON.stringify(f.context);
  const inspection = await f.service.inspect(f.context.id, {});
  const body = { source_sha256: inspection.source_sha256 };
  const first = await f.service.create(
    f.context.id,
    body,
    f.mutation(body),
    {}
  );
  const retry = await f.service.create(
    f.context.id,
    body,
    f.mutation(body),
    {}
  );
  expect(retry).toEqual(first);
  expect(f.exports).toHaveLength(1);
  expect(first).toMatchObject({ state: 'queued', download_url: null });
  expect(JSON.stringify(f.context)).toBe(before);
  expect(f.authorize).toHaveBeenCalledWith(f.context.id, f.transaction, true);
  const captured = JSON.parse(
    f.exports[0].snapshot_json as string
  ) as DossierSnapshot;
  f.context.modules.artwork.title.value = 'Later artist writing';
  expect(captured.context.modules.artwork.title.value).toBe(
    'A test & a record'
  );
  expect(f.sign).not.toHaveBeenCalled();
});

it('retains removed confirmed files, journal evidence and review history in the export snapshot', async () => {
  const f = fixture();
  const historical = { ...f.snapshot.assets[0], id: randomUUID() };
  const evidence = { ...historical, id: randomUUID() };
  f.snapshot.assets.push(historical, evidence);
  const confirmed = {
    asset_links: [
      { asset_id: historical.id, intended_visibility: 'public_record' }
    ],
    modules: {}
  };
  f.snapshot.artist_revisions = [
    {
      id: randomUUID(),
      revision_number: 1,
      source_draft_version: 1,
      snapshot_json: JSON.stringify(confirmed),
      confirmation_json: '{}',
      sha256: digest(confirmed),
      created_at: 1
    }
  ];
  f.context.latest_revision_id = String(f.snapshot.artist_revisions[0].id);
  f.snapshot.review_history = [
    {
      revision_id: f.context.latest_revision_id,
      lane: 'curatorial',
      review_version: 1,
      status: 'accepted',
      reason: 'Historical review',
      decision_history_json: '[]',
      updated_at: 1
    }
  ];
  f.snapshot.museum_records.push({
    id: randomUUID(),
    payload_json: JSON.stringify({
      evidence: [{ asset_id: evidence.id, sha256: evidence.sha256 }]
    })
  });
  const inspection = await f.service.inspect(f.context.id, {});
  const body = { source_sha256: inspection.source_sha256 };
  await f.service.create(f.context.id, body, f.mutation(body), {});
  const captured = JSON.parse(
    f.exports[0].snapshot_json as string
  ) as DossierSnapshot;
  expect(captured.assets.map((asset) => asset.id)).toEqual(
    expect.arrayContaining([historical.id, evidence.id])
  );
  expect(captured.artist_revisions).toEqual(f.snapshot.artist_revisions);
  expect(captured.review_history).toEqual(f.snapshot.review_history);
});

it.each(['draft', 'source', 'permissions'])(
  'rejects changed %s after obtaining the transaction lock',
  async (changed) => {
    const f = fixture();
    const inspection = await f.service.inspect(f.context.id, {});
    const body = { source_sha256: inspection.source_sha256 };
    const mutation = f.mutation(body);
    const fresh = JSON.parse(JSON.stringify(f.access)) as ContextAccess;
    if (changed === 'draft') fresh.context.draft_version++;
    if (changed === 'source')
      fresh.context.modules.artwork.title.value = 'Changed';
    if (changed === 'permissions')
      fresh.capabilities.read_archival_files = false;
    f.authorize.mockResolvedValueOnce(f.access).mockResolvedValueOnce(fresh);
    await expect(
      f.service.create(f.context.id, body, mutation, {})
    ).rejects.toMatchObject({
      code: {
        draft: 'DRAFT_CONFLICT',
        source: 'DOSSIER_SOURCE_CHANGED',
        permissions: 'DOSSIER_EXPORT_NOT_ALLOWED'
      }[changed]
    });
    expect(f.db.insert).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
  }
);

it('does not sign a ready export after role revocation or an expired export', async () => {
  const f = fixture();
  const body = {
    source_sha256: (await f.service.inspect(f.context.id, {})).source_sha256
  };
  const created = await f.service.create(
    f.context.id,
    body,
    f.mutation(body),
    {}
  );
  f.exports[0].state = 'ready';
  f.exports[0].object_version = 'immutable-v1';
  f.access.capabilities.read_source_receipts = false;
  await expect(
    f.service.get(f.context.id, created.id, {})
  ).rejects.toMatchObject({ code: 'DOSSIER_EXPORT_NOT_ALLOWED' });
  await expect(
    f.service.create(f.context.id, body, f.mutation(body), {})
  ).rejects.toMatchObject({ code: 'DOSSIER_EXPORT_NOT_ALLOWED' });
  expect(f.sign).not.toHaveBeenCalled();
  f.access.capabilities.read_source_receipts = true;
  f.exports[0].expires_at = Date.now() - 1;
  expect(await f.service.get(f.context.id, created.id, {})).toMatchObject({
    state: 'expired',
    download_url: null
  });
  expect(f.sign).not.toHaveBeenCalled();
});

it('does not return a foreign-context export or queue missing historical originals', async () => {
  const f = fixture();
  await expect(
    f.service.get(f.context.id, randomUUID(), {})
  ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  const confirmed = {
    asset_links: [
      { asset_id: randomUUID(), intended_visibility: 'public_record' }
    ]
  };
  f.snapshot.artist_revisions = [
    {
      id: randomUUID(),
      snapshot_json: JSON.stringify(confirmed),
      sha256: digest(confirmed),
      confirmation_json: '{}'
    }
  ];
  await expect(f.service.inspect(f.context.id, {})).rejects.toMatchObject({
    code: 'DOSSIER_FILES_NOT_READY'
  });
  expect(f.db.insert).not.toHaveBeenCalled();
});

it('refuses a public export while legacy restricted material remains in the current record', async () => {
  const f = fixture();
  f.context.restricted_paths.push('rights.legacy_instrument');
  await expect(f.service.inspect(f.context.id, {})).rejects.toMatchObject({
    code: 'PUBLICATION_REVIEW_REQUIRED'
  });
  expect(f.db.query).not.toHaveBeenCalled();
});
