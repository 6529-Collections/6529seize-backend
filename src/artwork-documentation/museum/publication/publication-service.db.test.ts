import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import { ArtworkDocumentationDb } from '../../artwork-documentation.db';
import { ArtworkDocumentationService } from '../../artwork-documentation.service';
import {
  AD_CONTEXTS,
  AD_DOSSIER_EXPORTS,
  AD_PUBLICATIONS,
  AD_REVISIONS
} from '../../artwork-documentation.tables';
import { AssetGateway, Mutation } from '../../artwork-documentation.types';
import { digest, normalizeJson } from '../../artwork-documentation.validation';
import { anArtworkAsset } from '../../assets/artwork-assets.test-support';
import { ARTWORK_ASSETS_TABLE } from '../../assets/artwork-assets.types';
import { ArtworkDossierService } from '../export/dossier.service';
import { publicationFixture } from '../fixtures/publication-fixtures';
import { ArtworkPublicationService } from './publication.service';
import { PublicationStore } from './publication.storage';

/**
 * Real MySQL (Testcontainers) coverage of the authorized publish path, the
 * public read, withdrawal and the independence from export download expiry.
 */
describe('Artwork publication service with the real database', () => {
  const actor = 'synthetic-corpus-owner';
  const ctx: RequestContext = {
    authenticationContext: AuthenticationContext.fromProfileId(actor)
  };
  let db: ArtworkDocumentationDb;
  let dossier: ArtworkDossierService;
  let service: ArtworkPublicationService;
  let storage: PublicationStore & { store: jest.Mock };
  const mutation = (body: unknown, expectedVersion?: number): Mutation => ({
    key: randomUUID(),
    route: 'POST:/publications',
    body,
    expectedVersion
  });

  beforeEach(() => {
    process.env.ARTWORK_DOCUMENTATION_ENABLED = 'true';
    db = new ArtworkDocumentationDb(() => sqlExecutor);
    const assets: AssetGateway = {
      listAssets: jest.fn(async () => []),
      validateReadyAsset: jest.fn(async () => ({})),
      markReferenced: jest.fn(async () => undefined)
    };
    const core = new ArtworkDocumentationService(db, assets);
    dossier = new ArtworkDossierService(core);
    storage = { store: jest.fn(async () => null) };
    service = new ArtworkPublicationService(core, dossier, storage);
  });
  afterEach(async () => {
    delete process.env.ARTWORK_DOCUMENTATION_ENABLED;
    await resetTestDatabase();
  });

  async function seed() {
    const { input } = publicationFixture('still-image');
    const context = input.snapshot.context;
    context.id = randomUUID();
    context.work_id = randomUUID();
    const revisionSnapshot = normalizeJson({
      modules: context.modules,
      asset_links: context.asset_links,
      profile: context.profile,
      artist_record_revision_id: null,
      sources: []
    });
    const revisionId = randomUUID();
    context.latest_revision_id = revisionId;
    await db.insert(
      AD_CONTEXTS,
      {
        id: context.id,
        work_id: context.work_id,
        owner_profile_id: actor,
        program_id: null,
        profile_json: JSON.stringify(context.profile),
        draft_version: 1,
        artist_record_revision_id: null,
        latest_revision_id: revisionId,
        lifecycle: 'active',
        modules_json: JSON.stringify(context.modules),
        asset_links_json: JSON.stringify(context.asset_links),
        restricted_paths_json: '[]',
        created_at: context.created_at,
        updated_at: context.updated_at
      },
      ctx
    );
    await db.insert(
      AD_REVISIONS,
      {
        id: revisionId,
        context_id: context.id,
        revision_number: 1,
        source_draft_version: 1,
        sha256: digest(revisionSnapshot),
        snapshot_json: JSON.stringify(revisionSnapshot),
        confirmation_json: JSON.stringify({
          actor_profile_id: actor,
          confirmed_at: 1
        }),
        created_at: 1
      },
      ctx
    );
    for (const asset of input.snapshot.assets)
      await db.insert(
        ARTWORK_ASSETS_TABLE,
        {
          ...anArtworkAsset({
            id: asset.id,
            context_id: context.id,
            uploader_profile_id: actor,
            filename: asset.filename,
            declared_mime: asset.declared_mime,
            extension: asset.extension,
            role: asset.role,
            state: 'ready',
            size_bytes: asset.size_bytes,
            reserved_bytes: asset.size_bytes,
            object_version: '1',
            sha256: asset.sha256,
            detected_mime: asset.detected_mime,
            inspection_status: 'verified',
            scan_status: 'NO_THREATS_FOUND',
            width: asset.width,
            height: asset.height,
            referenced: 1
          }),
          technical_metadata_json: asset.technical_metadata_json ?? null,
          validation_report_key: null
        },
        ctx
      );
    return { input, context };
  }

  it('publishes, serves the manifest publicly, ignores export expiry and stops serving after withdrawal', async () => {
    const { input, context } = await seed();
    const inspected = await dossier.inspect(context.id, ctx);
    expect(inspected.confirmation).toBe('current');
    const body = {
      source_sha256: inspected.source_sha256,
      selection: input.selection,
      bindings: input.bindings,
      rights: input.rights,
      roles: input.roles
    };
    const published = await service.publish(
      context.id,
      body,
      mutation(body, 1),
      ctx
    );
    expect(published).toMatchObject({
      context_id: context.id,
      revision_id: context.latest_revision_id,
      version: 1,
      state: 'published',
      source_sha256: inspected.source_sha256,
      manifest_url: `${input.bindings.base_url}/manifest`
    });
    const stored = await db.one<{
      manifest_json: unknown;
      input_json: unknown;
    }>(
      `SELECT manifest_json,input_json FROM ${AD_PUBLICATIONS} WHERE id=:id`,
      { id: published.id },
      ctx
    );
    expect(stored).not.toBeNull();
    const manifest = await service.publicManifest(published.id);
    expect(manifest.id).toBe(`${input.bindings.base_url}/manifest`);
    expect(digest(manifest)).toBe(published.manifest_sha256);
    expect(JSON.stringify(manifest)).toContain(
      input.bindings.media[input.selection.asset_ids[0]]
    );
    await db.insert(
      AD_DOSSIER_EXPORTS,
      {
        id: randomUUID(),
        context_id: context.id,
        actor_profile_id: actor,
        source_sha256: inspected.source_sha256,
        state: 'ready',
        snapshot_json: '{}',
        object_version: '1',
        sha256: 'c'.repeat(64),
        size_bytes: 1,
        failure_code: null,
        created_at: 1,
        expires_at: 2,
        lease_until: 0,
        attempts: 1
      },
      ctx
    );
    await expect(service.publicManifest(published.id)).resolves.toEqual(
      manifest
    );
    const reused = await service.publish(
      context.id,
      body,
      mutation(body, 1),
      ctx
    );
    expect(reused.id).toBe(published.id);
    expect(await service.list(context.id, ctx)).toHaveLength(1);
    const withdrawn = await service.withdraw(
      context.id,
      published.id,
      mutation(null),
      ctx
    );
    expect(withdrawn.state).toBe('withdrawn');
    await expect(service.publicManifest(published.id)).rejects.toMatchObject({
      code: 'PUBLICATION_WITHDRAWN'
    });
    const next = await service.publish(
      context.id,
      body,
      mutation(body, 1),
      ctx
    );
    expect(next.version).toBe(2);
    await expect(service.publicManifest(next.id)).resolves.toEqual(manifest);
    expect(
      (await service.list(context.id, ctx)).map((item) => item.version)
    ).toEqual([2, 1]);
  });

  it('refuses to publish for an actor without the export gate and answers 404 publicly for unknown ids', async () => {
    const { input, context } = await seed();
    const stranger: RequestContext = {
      authenticationContext: AuthenticationContext.fromProfileId(randomUUID())
    };
    const body = {
      source_sha256: 'a'.repeat(64),
      selection: input.selection,
      bindings: input.bindings,
      rights: input.rights,
      roles: input.roles
    };
    await expect(
      service.publish(context.id, body, mutation(body, 1), stranger)
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    });
    await expect(
      service.publish(context.id, body, mutation(body, 1), ctx)
    ).rejects.toMatchObject({
      code: 'DOSSIER_SOURCE_CHANGED'
    });
    await expect(service.publicManifest(randomUUID())).rejects.toMatchObject({
      message: 'Publication not found'
    });
  });
});
