import 'reflect-metadata';
import { RequestContext } from '@/request.context';
import {
  artistCapabilities,
  emptyCapabilities
} from '../artwork-documentation.access';
import {
  applyOperations,
  emptyModules,
  getProfile
} from '../artwork-documentation.catalogue';
import { ArtworkDocumentationDb } from '../artwork-documentation.db';
import { ArtworkDocumentationReviewService } from '../artwork-documentation.review';
import {
  ArtworkDocumentationService,
  confirmationStatus
} from '../artwork-documentation.service';
import { ContextAccess, Json, Operation } from '../artwork-documentation.types';
import { dossierFixture } from './export/dossier-fixture';
import { bindMuseumProgram, MUSEUM_CC0_URI } from './museum-catalogue';

function fixture() {
  const context = dossierFixture().snapshot.context;
  context.modules = emptyModules();
  context.asset_links = [];
  context.profile = getProfile('keys_and_gates_v1', 2);
  context.program_id = '6529NM-AP-01';
  context.draft_version = 7;
  context.latest_revision_id = '10000000-0000-4000-8000-000000000050';
  context.modules.artwork.title = {
    status: 'provided',
    intended_visibility: 'public_record',
    value: 'The artist’s existing work'
  };
  const access: ContextAccess = {
    context,
    isArtist: true,
    actorProfileId: context.owner_profile_id,
    capabilities: artistCapabilities()
  };
  const db = Object.create(
    ArtworkDocumentationDb.prototype
  ) as ArtworkDocumentationDb;
  db.idempotent = jest.fn(async (_id, _hash, ctx, run) => run(ctx));
  db.query = jest.fn().mockResolvedValue([]);
  db.saveContext = jest.fn();
  db.insert = jest.fn();
  const core = new ArtworkDocumentationService(db);
  core.actor = jest.fn(() => access.actorProfileId);
  core.authorizeContext = jest.fn(async () => access);
  core.authorizeMutationContext = jest.fn(async () => access);
  core.audit = jest.fn();
  core.getContext = jest.fn().mockResolvedValue(context);
  const review = new ArtworkDocumentationReviewService(core);
  const request = {} as RequestContext;
  const mutation = {
    key: 'owner-museum-upgrade',
    route: 'profile_upgrade',
    body: { profile_id: 'stream_artwork_basic_v1', version: 3 },
    expectedVersion: 7
  };
  return { context, access, db, core, review, request, mutation };
}

describe('Artist-owned museum profile upgrade', () => {
  it.each([null, 'another-program'])(
    'retains legacy program terms and refuses to upgrade inconsistent program binding %s',
    async (program) => {
      const { context, core, db, review, request, mutation } = fixture();
      context.program_id = program;
      const original = JSON.stringify(context);
      expect(core.issues(context)).toContainEqual(
        expect.objectContaining({ code: 'PROGRAM_CC0_REQUIRED' })
      );
      await expect(
        review.upgradePreview(context.id, 'stream_artwork_basic_v1', 3, request)
      ).rejects.toMatchObject({ code: 'PROGRAM_CHANGE_NOT_ALLOWED' });
      await expect(
        review.upgrade(
          context.id,
          'stream_artwork_basic_v1',
          3,
          mutation,
          request
        )
      ).rejects.toMatchObject({ code: 'PROGRAM_CHANGE_NOT_ALLOWED' });
      expect(JSON.stringify(context)).toBe(original);
      expect(db.saveContext).not.toHaveBeenCalled();
    }
  );

  it('upgrades the owner’s legacy program record using trusted terms and preserves the historical confirmation', async () => {
    const { context, access, db, review, request, mutation } = fixture();
    const originalProfile = JSON.stringify(context.profile);
    const originalModules = JSON.stringify(context.modules);
    const confirmedRevision = context.latest_revision_id;
    const preview = await review.upgradePreview(
      context.id,
      'stream_artwork_basic_v1',
      3,
      request
    );
    expect(preview.blocking_fields).toEqual([]);
    expect(preview.retained_fields).toContain('artwork.title');
    expect(JSON.stringify(context.profile)).toBe(originalProfile);
    await review.upgrade(
      context.id,
      'stream_artwork_basic_v1',
      3,
      mutation,
      request
    );
    expect(context.profile.profile_id).toBe('stream_artwork_basic_v1');
    expect(context.profile.version).toBe(3);
    expect(context.program_id).toBe('6529NM-AP-01');
    expect(context.profile.program_rules).toEqual(
      expect.objectContaining({
        fixed_artwork_license: expect.objectContaining({ uri: MUSEUM_CC0_URI }),
        default_media_profiles: []
      })
    );
    expect(context.profile.limits).toEqual(
      expect.objectContaining({
        asset_bytes: 8589934592,
        context_stored_and_reserved_bytes: 137438953472,
        assets_per_context: 1000
      })
    );
    expect(JSON.stringify(context.modules)).toBe(originalModules);
    expect(context.latest_revision_id).toBe(confirmedRevision);
    expect(context.draft_version).toBe(8);
    expect(confirmationStatus(context.draft_version, 7)).toBe('newer_draft');
    expect(access.capabilities.review_lanes).toEqual([]);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.saveContext).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy program upgrade restrictions and the draft-version conflict check', async () => {
    const { context, db, review, request, mutation } = fixture();
    await expect(
      review.upgrade(context.id, 'keys_and_gates_v1', 1, mutation, request)
    ).rejects.toThrow('COORDINATOR_REQUIRED');
    await expect(
      review.upgrade(
        context.id,
        'stream_artwork_basic_v1',
        3,
        { ...mutation, expectedVersion: 6 },
        request
      )
    ).rejects.toThrow('DRAFT_CONFLICT');
    expect(context.profile.version).toBe(2);
    expect(db.saveContext).not.toHaveBeenCalled();
  });

  it('does not grant upgrade rights to a program viewer or a manager impersonating artist status', async () => {
    const { context, access, db, review, request, mutation } = fixture();
    access.isArtist = false;
    access.actorProfileId = 'another-program-viewer';
    access.capabilities = { ...emptyCapabilities(), read_context: true };
    await expect(
      review.upgradePreview(context.id, 'stream_artwork_basic_v1', 3, request)
    ).rejects.toThrow('MANAGE_CONTEXT_REQUIRED');
    await expect(
      review.upgrade(
        context.id,
        'stream_artwork_basic_v1',
        3,
        mutation,
        request
      )
    ).rejects.toThrow('EDIT_NOT_ALLOWED');
    access.isArtist = true;
    access.capabilities = artistCapabilities();
    await expect(
      review.upgrade(
        context.id,
        'stream_artwork_basic_v1',
        3,
        mutation,
        request
      )
    ).rejects.toThrow('COORDINATOR_REQUIRED');
    expect(db.saveContext).not.toHaveBeenCalled();
  });

  it('blocks nonpublication answers and old restricted upload bytes rather than reclassifying them', async () => {
    const first = fixture();
    first.context.modules.artwork.title.intended_visibility = 'restricted';
    await expect(
      first.review.upgrade(
        first.context.id,
        'stream_artwork_basic_v1',
        3,
        first.mutation,
        first.request
      )
    ).rejects.toThrow('PROFILE_UPGRADE_REQUIRES_REVIEW');
    expect(first.db.saveContext).not.toHaveBeenCalled();
    const second = fixture();
    (second.db.query as jest.Mock).mockResolvedValue([
      {
        id: '10000000-0000-4000-8000-000000000096',
        filename: 'Old restricted permission.pdf',
        role: 'rights_instrument',
        intended_visibility: 'restricted',
        access_class: 'rights_evidence'
      }
    ]);
    await expect(
      second.review.upgrade(
        second.context.id,
        'stream_artwork_basic_v1',
        3,
        second.mutation,
        second.request
      )
    ).rejects.toThrow();
    expect(second.db.saveContext).not.toHaveBeenCalled();
    expect(second.db.insert).not.toHaveBeenCalled();
  });

  it('does not waive program binding or v3 downgrade rules', async () => {
    const { context, db, review, request, mutation } = fixture();
    context.program_id = 'client-invented-program';
    context.profile = { ...context.profile, program_id: context.program_id };
    await expect(
      review.upgrade(
        context.id,
        'stream_artwork_basic_v1',
        3,
        mutation,
        request
      )
    ).rejects.toThrow('UNSUPPORTED_PROGRAM');
    context.program_id = '6529NM-AP-01';
    context.profile = bindMuseumProgram(
      getProfile('stream_artwork_basic_v1', 3),
      context.program_id
    );
    await expect(
      review.upgradePreview(context.id, 'keys_and_gates_v1', 2, request)
    ).rejects.toThrow('PROFILE_DOWNGRADE_NOT_ALLOWED');
    expect(db.saveContext).not.toHaveBeenCalled();
  });

  it('shows readable unlinked restricted uploads before an upgrade and keeps their stored restrictions intact', async () => {
    const { context, db, review, request, mutation } = fixture();
    const row = {
      id: '10000000-0000-4000-8000-000000000099',
      uploader_profile_id: context.owner_profile_id,
      role: 'rights_instrument',
      intended_visibility: 'restricted',
      access_class: 'rights_evidence',
      filename: 'Earlier permission.pdf',
      referenced: false
    };
    const before = JSON.stringify(row);
    (db.query as jest.Mock).mockResolvedValue([row]);
    const preview = await review.upgradePreview(
      context.id,
      'stream_artwork_basic_v1',
      3,
      request
    );
    expect(context.asset_links).toEqual([]);
    expect(preview.blocking_fields).toContain(`asset:${row.id}`);
    expect(preview.notices).toContain(
      'Earlier upload "Earlier permission.pdf" is restricted. Its existing restrictions will be preserved.'
    );
    expect(
      preview.notices.some((notice) => notice.includes('unlinked uploads'))
    ).toBe(true);
    await expect(
      review.upgrade(
        context.id,
        'stream_artwork_basic_v1',
        3,
        mutation,
        request
      )
    ).rejects.toThrow('PROFILE_UPGRADE_REQUIRES_REVIEW');
    expect(JSON.stringify(row)).toBe(before);
    expect(context.profile.version).toBe(2);
    expect(db.saveContext).not.toHaveBeenCalled();
  });

  it('explains a restricted-upload blocker without exposing a file the manager cannot read', async () => {
    const { context, access, db, review, request } = fixture();
    access.isArtist = false;
    access.actorProfileId = 'context-manager';
    access.capabilities = {
      ...emptyCapabilities(),
      read_context: true,
      manage_context: true
    };
    const id = '10000000-0000-4000-8000-000000000098';
    (db.query as jest.Mock).mockResolvedValue([
      {
        id,
        uploader_profile_id: context.owner_profile_id,
        role: 'rights_instrument',
        intended_visibility: 'restricted',
        access_class: 'rights_evidence',
        filename: 'Restricted legacy evidence.pdf',
        referenced: false
      }
    ]);
    const preview = await review.upgradePreview(
      context.id,
      'stream_artwork_basic_v1',
      3,
      request
    );
    expect(preview.blocking_fields).toEqual(['files.restricted_uploads']);
    expect(JSON.stringify(preview)).not.toContain(id);
    expect(JSON.stringify(preview)).not.toContain(
      'Restricted legacy evidence.pdf'
    );
  });

  it('does not block an unlinked public supporting file that satisfies the v3 publication rules', async () => {
    const { context, db, review, request } = fixture();
    (db.query as jest.Mock).mockResolvedValue([
      {
        id: '10000000-0000-4000-8000-000000000097',
        uploader_profile_id: context.owner_profile_id,
        role: 'publication',
        intended_visibility: 'public_record',
        access_class: 'artwork',
        referenced: false
      }
    ]);
    const preview = await review.upgradePreview(
      context.id,
      'stream_artwork_basic_v1',
      3,
      request
    );
    expect(preview.blocking_fields).toEqual([]);
  });

  it.each([
    { state: 'cancelled', reserved_bytes: 0 },
    { state: 'expired', reserved_bytes: 0 },
    { state: 'cancelled', reserved_bytes: '0' },
    { state: 'expired', reserved_bytes: '0' }
  ])(
    'ignores only fully released, unreferenced %j upload receipts in preview and execution',
    async ({ state, reserved_bytes }) => {
      const { context, core, db, review, request, mutation } = fixture();
      const row = {
        id: '10000000-0000-4000-8000-000000000093',
        filename: 'Cancelled evidence.pdf',
        role: 'rights_instrument',
        intended_visibility: 'restricted',
        access_class: 'rights_evidence',
        state,
        referenced: 0,
        reserved_bytes
      };
      const original = JSON.stringify(row);
      (db.query as jest.Mock).mockResolvedValue([row]);
      const preview = await review.upgradePreview(
        context.id,
        'stream_artwork_basic_v1',
        3,
        request
      );
      expect(preview.blocking_fields).toEqual([]);
      await expect(
        core.validatePublicationUpgrade(
          { ...context, profile: preview.proposed_profile },
          request
        )
      ).resolves.toBeUndefined();
      await review.upgrade(
        context.id,
        'stream_artwork_basic_v1',
        3,
        mutation,
        request
      );
      expect(context.profile.version).toBe(3);
      expect(JSON.stringify(row)).toBe(original);
    }
  );

  it.each([
    { state: 'cancelled', referenced: 0, reserved_bytes: 1 },
    { state: 'expired', referenced: 1, reserved_bytes: 0 },
    { state: 'ready', referenced: 0, reserved_bytes: 0 },
    { state: 'processing', referenced: 0, reserved_bytes: 0 },
    { state: 'failed', referenced: 0, reserved_bytes: 0 },
    { state: 'cancelled', reserved_bytes: 0 }
  ])(
    'continues to block retained, active, referenced or uncertain upload state %j',
    async (lifecycle) => {
      const { context, core, db, review, request } = fixture();
      const row = {
        id: '10000000-0000-4000-8000-000000000094',
        filename: 'Retained evidence.pdf',
        role: 'rights_instrument',
        intended_visibility: 'restricted',
        access_class: 'rights_evidence',
        ...lifecycle
      };
      (db.query as jest.Mock).mockResolvedValue([row]);
      const preview = await review.upgradePreview(
        context.id,
        'stream_artwork_basic_v1',
        3,
        request
      );
      expect(preview.blocking_fields).toContain(`asset:${row.id}`);
      const proposed = bindMuseumProgram(
        getProfile('stream_artwork_basic_v1', 3),
        context.program_id
      );
      await expect(
        core.validatePublicationUpgrade(
          { ...context, profile: proposed },
          request
        )
      ).rejects.toThrow(
        expect.objectContaining({ code: 'PUBLICATION_VISIBILITY_REQUIRED' })
      );
    }
  );

  it('accepts an 800KB v3 text work and keeps the older profile write cap effective', async () => {
    const specimen = 'A'.repeat(400000);
    const operations: Operation[] = [
      {
        op: 'set',
        field: 'text',
        answer: {
          status: 'provided',
          intended_visibility: 'public_record',
          value: {
            authoritative_text: specimen,
            accessible_text: specimen,
            languages: ['en'],
            typography: 'Original letterforms.',
            layout: 'Single continuous field.',
            reading_order: 'Top to bottom.',
            presentation: 'fixed'
          }
        }
      }
    ];
    const legacy = fixture();
    const legacyRun = jest.fn(async () => ({ context_id: legacy.context.id }));
    await expect(
      legacy.core.mutate(
        legacy.context.id,
        {
          ...legacy.mutation,
          body: { operations }
        },
        legacy.request,
        legacyRun
      )
    ).rejects.toThrow('WRITE_REQUEST_LIMIT');
    expect(legacyRun).not.toHaveBeenCalled();
    expect(legacy.db.idempotent).not.toHaveBeenCalled();

    const modern = fixture();
    modern.context.program_id = null;
    modern.context.profile = getProfile('stream_artwork_basic_v1', 3);
    await modern.core.mutate(
      modern.context.id,
      { ...modern.mutation, body: { operations } },
      modern.request,
      async (access) => {
        access.context.modules.process = applyOperations(
          'process',
          access.context.modules.process,
          operations,
          access.context.profile
        );
        return { context_id: modern.context.id };
      }
    );
    expect(
      (modern.context.modules.process.text.value as Record<string, Json>)
        .authoritative_text
    ).toBe(specimen);
    expect(modern.db.saveContext).toHaveBeenCalledTimes(1);
  });

  it('retains the depth guard and checks the profile limit again under the mutation lock', async () => {
    const first = fixture();
    let nested: Json = 'text';
    for (let index = 0; index < 32; index++) nested = { nested };
    const run = jest.fn(async () => ({ context_id: first.context.id }));
    await expect(
      first.core.mutate(
        first.context.id,
        { ...first.mutation, body: nested },
        first.request,
        run
      )
    ).rejects.toThrow('INVALID_VALUE');
    expect(run).not.toHaveBeenCalled();
    const second = fixture();
    const initial = {
      ...second.access,
      context: {
        ...second.context,
        profile: getProfile('stream_artwork_basic_v1', 3)
      }
    };
    second.core.authorizeContext = jest.fn(async () => initial);
    await expect(
      second.core.mutate(
        second.context.id,
        { ...second.mutation, body: { text: 'é'.repeat(300000) } },
        second.request,
        run
      )
    ).rejects.toThrow('WRITE_REQUEST_LIMIT');
    expect(second.db.idempotent).toHaveBeenCalledTimes(1);
    expect(second.db.saveContext).not.toHaveBeenCalled();
  });
});
