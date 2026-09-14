import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { emptyCapabilities } from '../artwork-documentation.access';
import { ArtworkDocumentationDb } from '../artwork-documentation.db';
import { ArtworkDocumentationService } from '../artwork-documentation.service';
import {
  AD_CONTEXTS,
  AD_DOSSIER_EXPORTS,
  AD_EVENTS,
  AD_GRANTS,
  AD_IDEMPOTENCY,
  AD_MUSEUM_RECORDS
} from '../artwork-documentation.tables';
import { ContextRecord, Mutation } from '../artwork-documentation.types';
import { dossierFixture } from '../museum/export/dossier-fixture';
import { MuseumRecordService } from './museum-record.service';
import { MuseumRecordInput } from './museum-record.validation';
import { ArtworkDossierService } from '../museum/export/dossier.service';
import {
  DOSSIER_ASSET_SELECTION,
  dossierSelectionBytes,
  dossierSelectionSql
} from '../museum/export/dossier-capacity';
import { anArtworkAsset } from '../assets/artwork-assets.test-support';
import { ARTWORK_ASSETS_TABLE } from '../assets/artwork-assets.types';

describe('museum journal SQL isolation and immutable transactions', () => {
  let db: ArtworkDocumentationDb;
  let core: ArtworkDocumentationService;
  let service: MuseumRecordService;
  let context: ContextRecord;
  let ctx: RequestContext;
  let grantId: string;
  let input: MuseumRecordInput;
  let mutation: Mutation;

  beforeEach(async () => {
    db = new ArtworkDocumentationDb(() => sqlExecutor);
    context = dossierFixture().snapshot.context;
    context.id = randomUUID();
    context.owner_profile_id = 'test-artist';
    const actor = `reviewer-${randomUUID()}`;
    ctx = { authenticationContext: AuthenticationContext.fromProfileId(actor) };
    core = new ArtworkDocumentationService(db, undefined, {
      enabled: () => true,
      selfServiceEnabled: () => true
    });
    service = new MuseumRecordService(core);
    await db.insert(
      AD_CONTEXTS,
      {
        id: context.id,
        work_id: context.work_id,
        owner_profile_id: context.owner_profile_id,
        program_id: null,
        profile_json: JSON.stringify(context.profile),
        draft_version: context.draft_version,
        artist_record_revision_id: null,
        latest_revision_id: null,
        lifecycle: 'active',
        modules_json: JSON.stringify(context.modules),
        asset_links_json: '[]',
        restricted_paths_json: '[]',
        created_at: Date.now(),
        updated_at: Date.now()
      },
      ctx
    );
    grantId = randomUUID();
    await db.insert(
      AD_GRANTS,
      {
        id: grantId,
        subject_profile_id: actor,
        context_id: context.id,
        program_id: null,
        capabilities_json: JSON.stringify({
          ...emptyCapabilities(),
          read_context: true,
          review_lanes: ['curatorial']
        }),
        grantor_profile_id: 'test-grantor',
        created_at: Date.now(),
        revoked_at: null
      },
      ctx
    );
    input = {
      kind: 'catalogue_note',
      title: 'Synthetic SQL test',
      event_status: 'completed',
      subject_ids: [context.work_id],
      evidence_asset_ids: [],
      details: { source: 'Test fixture', conclusion: 'Test conclusion' }
    };
    mutation = {
      key: randomUUID(),
      route: `/contexts/${context.id}/museum-records`,
      body: input,
      expectedVersion: context.draft_version
    };
  });

  afterEach(() => jest.restoreAllMocks());

  it('preflights escaped SQL row sizes and exports only referenced files with an idempotent durable snapshot', async () => {
    const asset = anArtworkAsset({
      context_id: context.id,
      state: 'ready',
      scan_status: 'NO_THREATS_FOUND',
      sha256: 'a'.repeat(64),
      object_version: 'immutable-1',
      referenced: 1,
      expires_at: 0,
      filename: 'Quote " and \n newline.png'
    });
    await db.insert(ARTWORK_ASSETS_TABLE, { ...asset }, ctx);
    const unused = anArtworkAsset({
      context_id: context.id,
      technical_metadata_json: JSON.stringify({
        warnings: ['"\\\n'.repeat(10000)]
      })
    });
    await db.insert(ARTWORK_ASSETS_TABLE, { ...unused }, ctx);
    context.asset_links[0] = {
      ...context.asset_links[0],
      asset_id: asset.id,
      manifest: { id: asset.id, sha256: asset.sha256 }
    };
    await db.saveContext(context, ctx);
    await db.query(
      `UPDATE ${AD_GRANTS} SET capabilities_json=:caps WHERE id=:id`,
      {
        id: grantId,
        caps: JSON.stringify({
          ...emptyCapabilities(),
          read_context: true,
          review_lanes: ['curatorial'],
          read_archival_files: true,
          read_rights_evidence: true,
          read_source_receipts: true
        })
      },
      ctx
    );
    await db.executeNativeQueriesInTransaction(async (connection) => {
      const transaction = { connection };
      const params = { id: context.id, assetIds: [asset.id] };
      const measured = await dossierSelectionBytes(
        db,
        DOSSIER_ASSET_SELECTION,
        params,
        transaction
      );
      const rows = await db.query(
        dossierSelectionSql(DOSSIER_ASSET_SELECTION),
        params,
        transaction
      );
      expect(measured).toBeGreaterThanOrEqual(
        Buffer.byteLength(JSON.stringify(rows))
      );
      expect(rows).toHaveLength(1);
    });
    const dossier = new ArtworkDossierService(core);
    const inspection = await dossier.inspect(context.id, ctx);
    const body = { source_sha256: inspection.source_sha256 };
    const request = {
      ...mutation,
      route: `/contexts/${context.id}/dossier`,
      body
    };
    const results = await Promise.all([
      dossier.create(context.id, body, request, ctx),
      dossier.create(context.id, body, request, ctx)
    ]);
    expect(results[0].id).toBe(results[1].id);
    const row = await db.one<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM ${AD_DOSSIER_EXPORTS} WHERE id=:id`,
      { id: results[0].id },
      ctx
    );
    const captured =
      typeof row?.snapshot_json === 'string'
        ? JSON.parse(row.snapshot_json)
        : row?.snapshot_json;
    expect(captured.assets.map((file: { id: string }) => file.id)).toEqual([
      asset.id
    ]);
    expect((await db.context(context.id, ctx))?.draft_version).toBe(
      context.draft_version
    );
  });

  it('serializes simultaneous identical requests into one journal record and audit event', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.append(context.id, input, mutation, ctx)
      )
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    const journal = await db.query(
      `SELECT id FROM ${AD_MUSEUM_RECORDS} WHERE context_id=:id`,
      { id: context.id },
      ctx
    );
    const audit = await db.query(
      `SELECT id FROM ${AD_EVENTS} WHERE context_id=:id`,
      { id: context.id },
      ctx
    );
    expect(journal).toHaveLength(1);
    expect(audit).toHaveLength(1);
    const stored = await db.context(context.id, ctx);
    expect(stored?.draft_version).toBe(context.draft_version);
    expect(stored?.latest_revision_id).toBeNull();
  });

  it('rolls journal and idempotency inserts back if the audit transaction fails', async () => {
    jest
      .spyOn(core, 'audit')
      .mockRejectedValueOnce(new Error('Synthetic audit failure'));
    await expect(
      service.append(context.id, input, mutation, ctx)
    ).rejects.toThrow('Synthetic audit failure');
    expect(
      await db.query(
        `SELECT id FROM ${AD_MUSEUM_RECORDS} WHERE context_id=:id`,
        { id: context.id },
        ctx
      )
    ).toEqual([]);
    const saved = await service.append(context.id, input, mutation, ctx);
    expect(saved.payload.title).toBe(input.title);
    expect(
      await db.query(
        `SELECT id FROM ${AD_EVENTS} WHERE context_id=:id`,
        { id: context.id },
        ctx
      )
    ).toHaveLength(1);
  });

  it('rechecks revoked grants after waiting for the context lock', async () => {
    let release!: () => void;
    let acquired!: () => void;
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const revoking = db.executeNativeQueriesInTransaction(
      async (connection) => {
        await db.context(context.id, { connection }, true);
        acquired();
        await proceed;
        await db.query(
          `UPDATE ${AD_GRANTS} SET revoked_at=:now WHERE id=:id`,
          { id: grantId, now: Date.now() },
          { connection }
        );
      }
    );
    await locked;
    const authorize = jest.spyOn(core, 'authorizeMutationContext');
    const append = service.append(context.id, input, mutation, ctx);
    const rejected = expect(append).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    });
    for (let wait = 0; wait < 100 && authorize.mock.calls.length === 0; wait++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await revoking;
    await rejected;
    expect(
      await db.query(
        `SELECT id FROM ${AD_MUSEUM_RECORDS} WHERE context_id=:id`,
        { id: context.id },
        ctx
      )
    ).toEqual([]);
  });

  it('does not expose an idempotent result after its actor loses context access', async () => {
    await service.append(context.id, input, mutation, ctx);
    await db.query(
      `UPDATE ${AD_GRANTS} SET revoked_at=:now WHERE id=:id`,
      { id: grantId, now: Date.now() },
      ctx
    );
    await expect(
      service.append(context.id, input, mutation, ctx)
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('allows only one concurrent successor and preserves the original row', async () => {
    const initial = await service.append(context.id, input, mutation, ctx);
    const changed = {
      ...input,
      title: 'Revised account',
      supersedes_id: initial.id
    };
    const successors = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        service.append(
          context.id,
          changed,
          { ...mutation, key: randomUUID(), body: changed },
          ctx
        )
      )
    );
    expect(
      successors.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    const original = await db.one<{ sha256: string }>(
      `SELECT sha256 FROM ${AD_MUSEUM_RECORDS} WHERE id=:id`,
      { id: initial.id },
      ctx
    );
    expect(original?.sha256).toBe(initial.sha256);
    expect(
      await db.query(
        `SELECT id FROM ${AD_MUSEUM_RECORDS} WHERE context_id=:id`,
        { id: context.id },
        ctx
      )
    ).toHaveLength(2);
    expect(
      await db.query(
        `SELECT id FROM ${AD_IDEMPOTENCY} WHERE result_reference_json IS NULL`,
        {},
        ctx
      )
    ).toEqual([]);
  });
});
