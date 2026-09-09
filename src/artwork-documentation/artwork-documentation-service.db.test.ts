import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { AuthenticationContext } from '@/auth-context';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { DROPS_TABLE } from '@/constants';
import { ArtworkDocumentationDb } from './artwork-documentation.db';
import { ArtworkDocumentationService } from './artwork-documentation.service';
import { ArtworkDocumentationReviewService } from './artwork-documentation.review';
import {
  AD_CONTEXTS,
  AD_DROP_LINKS,
  AD_GRANTS,
  AD_REVISIONS,
  AD_REVIEWS
} from './artwork-documentation.tables';
import {
  Answer,
  AssetGateway,
  Capabilities,
  ContextRecord,
  Mutation
} from './artwork-documentation.types';
import {
  CONFIRMATION_COPY_VERSION,
  getProfile
} from './artwork-documentation.catalogue';
import { emptyCapabilities } from './artwork-documentation.access';

const makeContext = (actor: string): RequestContext => ({
  authenticationContext: AuthenticationContext.fromProfileId(actor)
});
const mutation = (
  route: string,
  body: unknown,
  expectedVersion?: number,
  key = randomUUID()
): Mutation => ({ route, body, expectedVersion, key });
const answer = (
  value: Answer['value'],
  intended_visibility: Answer['intended_visibility'] = 'public_record'
): Answer => ({ status: 'provided', value, intended_visibility });

describe('artwork documentation transactional persistence', () => {
  it('resolves a preseeded program source for its artist while new creation is disabled', async () => {
    const record = await readyContext();
    const dropId = randomUUID();
    const waveId = '4ff022b3-aa17-4a0a-ba78-58f64ff1d427';
    record.program_id = '6529NM-AP-01';
    record.profile = getProfile('keys_and_gates_v1', 1);
    await db.saveContext(record, ctx);
    await db.query(
      `UPDATE ${AD_CONTEXTS} SET program_id=:program WHERE id=:id`,
      { id: record.id, program: record.program_id },
      ctx
    );
    await db.insert(
      DROPS_TABLE,
      {
        id: dropId,
        wave_id: waveId,
        author_id: actor,
        created_at: Date.now(),
        parts_count: 1,
        drop_type: 'PARTICIPATORY'
      },
      ctx
    );
    await db.insert(
      AD_DROP_LINKS,
      {
        drop_id: dropId,
        context_id: record.id,
        work_id: record.work_id,
        author_profile_id: actor,
        wave_id: waveId,
        source_receipt_id: randomUUID()
      },
      ctx
    );
    process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED = 'false';
    const input = {
      profile_id: 'keys_and_gates_v1',
      profile_version: 1,
      program_id: record.program_id,
      source_drop_id: dropId,
      start_mode: 'after_submission'
    };
    expect(
      (await service.createWork(input, mutation('source-recovery', input), ctx))
        .id
    ).toBe(record.id);
  });
  it('starts a reused work context empty and does not copy private data or grants', async () => {
    const record = await readyContext();
    record.modules.identity.private_contact = answer(
      'Do not copy me',
      'restricted'
    );
    await db.saveContext(record, ctx);
    const input = {
      profile_id: 'stream_artwork_basic_v1',
      profile_version: 1,
      acknowledge_empty_context: true
    };
    const fresh = await service.createContextForWork(
      record.work_id,
      input,
      mutation('reuse-work', input),
      ctx
    );
    expect(fresh.work_id).toBe(record.work_id);
    expect(fresh.id).not.toBe(record.id);
    expect(fresh.asset_links).toEqual([]);
    expect(fresh.source_links).toEqual([]);
    expect(fresh.artist_record_revision_id).toBeNull();
    expect(JSON.stringify(fresh.modules)).not.toContain('Do not copy me');
    expect(
      Object.values(fresh.modules).every(
        (module) => Object.keys(module.answers).length === 0
      )
    ).toBe(true);
    await expect(
      service.createContextForWork(
        record.work_id,
        input,
        mutation('reuse-work', input),
        makeContext(randomUUID())
      )
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('removes restricted answers and original digests from the entire public preview payload', async () => {
    const record = await readyContext();
    record.modules.identity.private_contact = answer(
      'secret-contact-value',
      'restricted'
    );
    record.modules.rights.people_depicted = answer(
      'includes_minors',
      'restricted'
    );
    record.modules.context.making_context = answer(
      'secret-context-value',
      'restricted'
    );
    await db.saveContext(record, ctx);
    const serialized = JSON.stringify(
      await service.publicPreview(record.id, ctx)
    );
    for (const secret of [
      'secret-contact-value',
      'secret-context-value',
      'includes_minors',
      'a'.repeat(64)
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain('Image');
  });
  let db: ArtworkDocumentationDb;
  let service: ArtworkDocumentationService;
  let reviews: ArtworkDocumentationReviewService;
  let actor: string;
  let ctx: RequestContext;
  let assets: AssetGateway;
  beforeEach(() => {
    process.env.ARTWORK_DOCUMENTATION_ENABLED = 'true';
    process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED = 'true';
    actor = randomUUID();
    ctx = makeContext(actor);
    db = new ArtworkDocumentationDb(() => sqlExecutor);
    assets = {
      listAssets: jest.fn(async () => []),
      validateReadyAsset: jest.fn(async (_contextId, assetId) => ({
        id: assetId,
        state: 'ready',
        sha256: 'a'.repeat(64),
        size_bytes: 123
      })),
      markReferenced: jest.fn(async () => undefined)
    };
    service = new ArtworkDocumentationService(db, assets);
    reviews = new ArtworkDocumentationReviewService(service);
  });
  afterEach(() => {
    delete process.env.ARTWORK_DOCUMENTATION_ENABLED;
    delete process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED;
  });
  async function create() {
    const body = {
      profile_id: 'stream_artwork_basic_v1',
      profile_version: 1,
      start_mode: 'standalone'
    };
    return service.createWork(body, mutation('/works', body), ctx);
  }
  async function assign(
    record: ContextRecord,
    subject: string,
    capabilities: Partial<Capabilities>
  ) {
    await db.insert(
      AD_GRANTS,
      {
        id: randomUUID(),
        context_id: record.id,
        program_id: null,
        subject_profile_id: subject,
        capabilities_json: JSON.stringify({
          ...emptyCapabilities(),
          read_context: true,
          ...capabilities
        }),
        grantor_profile_id: actor,
        created_at: Date.now(),
        revoked_at: null
      },
      ctx
    );
  }
  it('narrows historical answers and field threads when pinning a restricted artist record', async () => {
    const record = await readyContext();
    const viewer = makeContext(randomUUID());
    await assign(
      record,
      viewer.authenticationContext!.authenticatedProfileId!,
      {}
    );
    const confirmBody = {
      accepted: true,
      confirmation_copy_version: CONFIRMATION_COPY_VERSION
    };
    const confirmed = await service.confirm(
      record.id,
      confirmBody,
      mutation('confirm', confirmBody, 1),
      ctx
    );
    const threadBody = {
      field_path: 'identity.display_name',
      audience: 'artist_and_reviewers',
      restricted_class: 'ordinary',
      text: 'Historical public name discussed here'
    };
    await reviews.createThread(
      record.id,
      threadBody,
      mutation('thread', threadBody, 1),
      ctx
    );
    expect((await reviews.listThreads(record.id, viewer)).data).toHaveLength(1);
    const other = await create();
    const patch = {
      schema_version: 1,
      expected_artist_record_version: 0,
      operations: [
        {
          op: 'set' as const,
          field: 'display_name',
          answer: answer('Restricted name', 'restricted')
        }
      ]
    };
    const saved = await service.patchModule(
      other.id,
      'identity',
      patch,
      mutation('identity', patch, 1),
      ctx
    );
    await service.pinArtist(
      record.id,
      saved.artist_record_revision_id!,
      mutation('pin', { revision_id: saved.artist_record_revision_id }, 1),
      ctx
    );
    expect(
      (await service.getContext(record.id, viewer)).modules.identity.answers
        .display_name
    ).toEqual({ redacted: true });
    expect(
      (await service.getRevision(record.id, confirmed.id, viewer)).snapshot
        .modules.identity.answers.display_name
    ).toEqual({ redacted: true });
    expect((await reviews.listThreads(record.id, viewer)).data).toHaveLength(0);
  });
  it('allows coordinators to assign bounded evidence reviewers without gaining evidence access', async () => {
    const record = await readyContext();
    const coordinatorId = randomUUID();
    await assign(record, coordinatorId, {
      manage_assignments: true,
      manage_context: true
    });
    const coordinator = makeContext(coordinatorId);
    for (const [lane, capability] of [
      ['rights', 'read_rights_evidence'],
      ['technical', 'read_archival_files']
    ] as const) {
      const grant = { review_lanes: [lane], [capability]: true };
      await reviews.grant(
        record.id,
        randomUUID(),
        grant,
        mutation(`grant-${lane}`, grant, 1),
        coordinator
      );
      await expect(
        reviews.grant(
          record.id,
          coordinatorId,
          grant,
          mutation(`self-grant-${lane}`, grant, 1),
          coordinator
        )
      ).rejects.toMatchObject({ code: 'GRANT_NOT_ALLOWED' });
    }
    const access = await service.authorizeContext(record.id, coordinator);
    expect(access.capabilities.read_archival_files).toBe(false);
    expect(access.capabilities.read_rights_evidence).toBe(false);
  });
  it('preserves inaccessible existing evidence while refusing newly introduced hidden references', async () => {
    const record = await readyContext();
    const evidenceId = randomUUID();
    record.asset_links.push({
      ...record.asset_links[0],
      id: randomUUID(),
      asset_id: evidenceId,
      role: 'consent_instrument',
      intended_visibility: 'restricted'
    });
    record.modules.rights.consent_asset_ids = answer(
      [evidenceId],
      'restricted'
    );
    await db.saveContext(record, ctx);
    const editorId = randomUUID();
    await assign(record, editorId, { edit_modules: ['context', 'process'] });
    const editor = makeContext(editorId);
    const patch = {
      schema_version: 1,
      operations: [
        {
          op: 'set' as const,
          field: 'making_context',
          answer: answer('An ordinary context update')
        }
      ]
    };
    await expect(
      service.patchModule(
        record.id,
        'context',
        patch,
        mutation('context', patch, 1),
        editor
      )
    ).resolves.toMatchObject({ draft_version: 2 });
    const hiddenRef = {
      schema_version: 1,
      operations: [
        {
          op: 'set' as const,
          field: 'ingredients',
          answer: answer({
            kind: 'entries_supplied',
            entries: [
              {
                asset_id: evidenceId,
                creator: 'Artist',
                role: 'source',
                rights_note: 'supplied'
              }
            ]
          })
        }
      ]
    };
    await expect(
      service.patchModule(
        record.id,
        'process',
        hiddenRef,
        mutation('process', hiddenRef, 2),
        editor
      )
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  async function readyContext(): Promise<ContextRecord> {
    const created = await create();
    const record = (await db.context(created.id, ctx))!;
    const assetId = randomUUID();
    record.modules.identity = {
      display_name: answer('Artist'),
      preferred_credit: answer('Artist'),
      record_language: answer('en')
    };
    record.modules.artwork = {
      title: answer('Image'),
      title_language: answer('en'),
      medium: answer({ kind: 'digital_photograph' }),
      canonical_asset_id: answer(assetId)
    };
    record.modules.context = {
      caption: answer({
        primary_language: 'en',
        versions: [
          {
            language: 'en',
            text: 'The image has a history.',
            authorship: 'original',
            approved_by_artist: true
          }
        ]
      })
    };
    record.modules.rights = {
      rights_basis: answer({ kind: 'artist_owned' }),
      intended_license: answer({
        uri: 'https://creativecommons.org/publicdomain/zero/1.0/',
        label: 'CC0'
      }),
      rights_declaration: answer('Proposed artwork dedication.'),
      declaration_effect: answer('proposed')
    };
    record.asset_links = [
      {
        id: randomUUID(),
        asset_id: assetId,
        role: 'artwork_final',
        label: 'Final',
        description: '',
        intended_visibility: 'public_record',
        source_of_asset: 'self',
        source_credit: '',
        derived_from_asset_ids: [],
        deposit_note: '',
        intended_terms: { kind: 'unspecified' },
        manifest: { id: assetId, sha256: 'a'.repeat(64), state: 'ready' }
      }
    ];
    await db.saveContext(record, ctx);
    return record;
  }
  it('creates idempotently and rejects use of the same key with a changed request', async () => {
    const body = {
      profile_id: 'stream_artwork_basic_v1',
      profile_version: 1,
      start_mode: 'standalone'
    };
    const write = mutation('/works', body);
    const [left, right] = await Promise.all([
      service.createWork(body, write, ctx),
      service.createWork(body, write, ctx)
    ]);
    expect(left.id).toBe(right.id);
    await expect(
      service.createWork(
        { ...body, start_mode: 'after_submission' },
        write,
        ctx
      )
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });
  it('denies reads, writes and history to a different profile', async () => {
    const work = await create();
    const stranger = makeContext(randomUUID());
    await expect(service.getContext(work.id, stranger)).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    });
    await expect(
      reviews.listRevisions(work.id, stranger, {})
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('serializes simultaneous edits and retains the winner when the other tab is stale', async () => {
    const work = await create();
    const patch = (title: string) => ({
      schema_version: 1,
      operations: [
        { op: 'set' as const, field: 'title', answer: answer(title) }
      ]
    });
    const left = patch('Left');
    const right = patch('Right');
    const result = await Promise.allSettled([
      service.patchModule(
        work.id,
        'artwork',
        left,
        mutation('patch', left, 1),
        ctx
      ),
      service.patchModule(
        work.id,
        'artwork',
        right,
        mutation('patch', right, 1),
        ctx
      )
    ]);
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1
    );
    expect(result.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect((await service.getContext(work.id, ctx)).draft_version).toBe(2);
  });
  it('rolls back malformed patches without consuming the draft version', async () => {
    const work = await create();
    const patch = {
      schema_version: 1,
      operations: [{ op: 'set' as const, field: 'title', answer: answer(123) }]
    };
    await expect(
      service.patchModule(
        work.id,
        'artwork',
        patch,
        mutation('patch', patch, 1),
        ctx
      )
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    expect((await service.getContext(work.id, ctx)).draft_version).toBe(1);
  });
  it('confirms atomically, retains immutable earlier answers and initializes review lanes', async () => {
    const record = await readyContext();
    const body = {
      accepted: true,
      confirmation_copy_version: CONFIRMATION_COPY_VERSION
    };
    const write = mutation('confirm', body, 1);
    const confirmed = await service.confirm(record.id, body, write, ctx);
    expect(confirmed.reviews).toHaveLength(2);
    expect(
      confirmed.reviews.every((review) => review.status === 'pending')
    ).toBe(true);
    expect(confirmed.hash_algorithm).toBe('sha256');
    expect((await service.confirm(record.id, body, write, ctx)).id).toBe(
      confirmed.id
    );
    const patch = {
      schema_version: 1,
      operations: [
        { op: 'set' as const, field: 'title', answer: answer('New title') }
      ]
    };
    await service.patchModule(
      record.id,
      'artwork',
      patch,
      mutation('patch', patch, 1),
      ctx
    );
    const historical = await service.getRevision(record.id, confirmed.id, ctx);
    expect(
      (historical.snapshot.modules.artwork.answers.title as Answer).value
    ).toBe('Image');
    expect((await service.getContext(record.id, ctx)).confirmation_status).toBe(
      'newer_draft'
    );
  });
  it('does not confirm an incomplete draft or files whose server verification failed', async () => {
    const incomplete = await create();
    const body = {
      accepted: true,
      confirmation_copy_version: CONFIRMATION_COPY_VERSION
    };
    await expect(
      service.confirm(incomplete.id, body, mutation('confirm', body, 1), ctx)
    ).rejects.toMatchObject({ code: 'REQUIRED_ANSWERS_MISSING' });
    const record = await readyContext();
    (assets.validateReadyAsset as jest.Mock).mockRejectedValue(
      new Error('not ready')
    );
    await expect(
      service.confirm(record.id, body, mutation('confirm', body, 1), ctx)
    ).rejects.toThrow();
    expect(
      await db.query(
        `SELECT id FROM ${AD_REVISIONS} WHERE context_id=:id`,
        { id: record.id },
        ctx
      )
    ).toHaveLength(0);
  });
  it('does not inherit artist authority from proxy login', async () => {
    const record = await readyContext();
    const proxy = {
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: '0x1',
        authenticatedProfileId: randomUUID(),
        roleProfileId: actor,
        activeProxyActions: []
      })
    };
    const body = {
      accepted: true,
      confirmation_copy_version: CONFIRMATION_COPY_VERSION
    };
    await expect(
      service.confirm(record.id, body, mutation('confirm', body, 1), proxy)
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('redacts locked evidence in drafts and historical revisions and honors grant revocation', async () => {
    const record = await readyContext();
    record.modules.rights.people_depicted = answer('none', 'restricted');
    record.modules.identity.private_contact = answer(
      'Private contact',
      'restricted'
    );
    await db.saveContext(record, ctx);
    const reviewer = randomUUID();
    const grantId = randomUUID();
    await db.insert(
      AD_GRANTS,
      {
        id: grantId,
        context_id: record.id,
        program_id: null,
        subject_profile_id: reviewer,
        capabilities_json: JSON.stringify({
          ...emptyCapabilities(),
          read_context: true,
          review_lanes: ['curatorial']
        }),
        grantor_profile_id: actor,
        created_at: Date.now(),
        revoked_at: null
      },
      ctx
    );
    const reviewerCtx = makeContext(reviewer);
    const view = await service.getContext(record.id, reviewerCtx);
    expect(view.modules.rights.answers.people_depicted).toEqual({
      redacted: true
    });
    expect(view.modules.identity.answers.private_contact).toEqual({
      redacted: true
    });
    expect(JSON.stringify(view)).not.toContain('Private contact');
    await db.query(
      `UPDATE ${AD_GRANTS} SET revoked_at=:now WHERE id=:id`,
      { id: grantId, now: Date.now() },
      ctx
    );
    await expect(
      service.getContext(record.id, reviewerCtx)
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('pins shared identity revisions independently and compares the shared record version', async () => {
    const first = await create();
    const second = await create();
    const patch = {
      schema_version: 1,
      expected_artist_record_version: 0,
      operations: [
        {
          op: 'set' as const,
          field: 'display_name',
          answer: answer('First name')
        }
      ]
    };
    const saved = await service.patchModule(
      first.id,
      'identity',
      patch,
      mutation('identity', patch, 1),
      ctx
    );
    await expect(
      service.patchModule(
        second.id,
        'identity',
        patch,
        mutation('identity', patch, 1),
        ctx
      )
    ).rejects.toMatchObject({ code: 'ARTIST_RECORD_CONFLICT' });
    expect(
      (await service.getContext(second.id, ctx)).artist_record_revision_id
    ).toBeNull();
    const pinned = await service.pinArtist(
      second.id,
      saved.artist_record_revision_id!,
      mutation('pin', { revision_id: saved.artist_record_revision_id }, 1),
      ctx
    );
    expect((pinned.modules.identity.answers.display_name as Answer).value).toBe(
      'First name'
    );
  });
  it('archives reversibly and keeps pending reviews separate from lifecycle', async () => {
    const record = await readyContext();
    await reviews.lifecycle(
      record.id,
      'archived',
      mutation('lifecycle', { lifecycle: 'archived' }, 1),
      ctx
    );
    const stored = (await db.one<{
      lifecycle: string;
      latest_revision_id: string | null;
    }>(
      `SELECT lifecycle,latest_revision_id FROM ${AD_CONTEXTS} WHERE id=:id`,
      { id: record.id },
      ctx
    ))!;
    expect(stored.lifecycle).toBe('archived');
    expect(stored.latest_revision_id).toBeNull();
    expect(
      (
        await reviews.lifecycle(
          record.id,
          'active',
          mutation('lifecycle', { lifecycle: 'active' }, 2),
          ctx
        )
      ).lifecycle
    ).toBe('active');
  });
  it('filters queues before pagination and returns only generic review summaries', async () => {
    const current = await readyContext();
    const newer = await readyContext();
    const unconfirmed = await create();
    const confirmBody = {
      accepted: true,
      confirmation_copy_version: CONFIRMATION_COPY_VERSION
    };
    const confirmed = await service.confirm(
      current.id,
      confirmBody,
      mutation(`confirm-${current.id}`, confirmBody, 1),
      ctx
    );
    await service.confirm(
      newer.id,
      confirmBody,
      mutation(`confirm-${newer.id}`, confirmBody, 1),
      ctx
    );
    const patch = {
      schema_version: 1,
      operations: [
        { op: 'set' as const, field: 'title', answer: answer('New draft') }
      ]
    };
    await service.patchModule(
      newer.id,
      'artwork',
      patch,
      mutation('title', patch, 1),
      ctx
    );
    expect(
      (
        await reviews.listContexts(ctx, {
          confirmation_status: 'current',
          limit: 1
        })
      ).data.map((row) => row.id)
    ).toEqual([current.id]);
    expect(
      (
        await reviews.listContexts(ctx, { confirmation_status: 'newer_draft' })
      ).data.map((row) => row.id)
    ).toEqual([newer.id]);
    expect(
      (
        await reviews.listContexts(ctx, { confirmation_status: 'unconfirmed' })
      ).data.map((row) => row.id)
    ).toEqual([unconfirmed.id]);
    expect(
      (
        await reviews.listContexts(ctx, {
          outstanding_action: 'artist_confirmation'
        })
      ).data
    ).toHaveLength(2);
    expect(
      (
        await reviews.listContexts(ctx, {
          outstanding_action: 'review',
          review_lane: 'rights',
          profile_id: 'stream_artwork_basic_v1',
          profile_version: 1
        })
      ).data.map((row) => row.id)
    ).toEqual([current.id]);
    await db.query(
      `UPDATE ${AD_REVIEWS} SET status='changes_requested',reason=:reason WHERE revision_id=:id AND lane='rights'`,
      { id: confirmed.id, reason: 'Private evidence concern' },
      ctx
    );
    const queue = await reviews.listContexts(ctx, {
      outstanding_action: 'changes_requested',
      review_lane: 'rights'
    });
    expect(queue.data.map((row) => row.id)).toEqual([current.id]);
    expect(JSON.stringify(queue)).not.toContain('Private evidence concern');
    expect(
      (await reviews.listContexts(ctx, { profile_version: 2 })).data
    ).toEqual([]);
    await expect(
      reviews.listContexts(ctx, { review_lane: 'invented' })
    ).rejects.toMatchObject({ code: 'INVALID_FILTER' });
    expect(
      confirmed.snapshot.profile.interview_instrument.prompts
    ).toHaveLength(8);
    expect(confirmed.snapshot.profile.interview_instrument.prompts[0]).toEqual({
      id: 'q1',
      text: 'What first drew you to make this work?'
    });
  });
  it('requires explicit interview metadata and future disclosure permission for recording references', async () => {
    const record = await readyContext();
    const recordingId = randomUUID();
    record.asset_links.push({
      ...record.asset_links[0],
      id: randomUUID(),
      asset_id: recordingId,
      role: 'interview_recording'
    });
    await db.saveContext(record, ctx);
    const reference = {
      op: 'set' as const,
      field: 'recording_asset_id',
      answer: answer(recordingId)
    };
    const missing = { schema_version: 1, operations: [reference] };
    await expect(
      service.patchModule(
        record.id,
        'interview',
        missing,
        mutation('interview', missing, 1),
        ctx
      )
    ).rejects.toMatchObject({ code: 'INTERVIEW_PERMISSION_REQUIRED' });
    const operations = [
      reference,
      {
        op: 'set' as const,
        field: 'date',
        answer: answer({
          precision: 'day',
          start: '2026-09-09',
          approximate: false
        })
      },
      {
        op: 'set' as const,
        field: 'participants',
        answer: answer([{ name: 'Artist', role: 'artist' }])
      },
      {
        op: 'set' as const,
        field: 'recording_permission',
        answer: answer('private_review')
      }
    ];
    const restricted = { schema_version: 1, operations };
    await expect(
      service.patchModule(
        record.id,
        'interview',
        restricted,
        mutation('interview', restricted, 1),
        ctx
      )
    ).rejects.toMatchObject({ code: 'INTERVIEW_DISCLOSURE_MISMATCH' });
    const allowed = {
      schema_version: 1,
      operations: operations.map((operation) =>
        operation.field === 'recording_permission'
          ? { ...operation, answer: answer('intended_public_record') }
          : operation
      )
    };
    await expect(
      service.patchModule(
        record.id,
        'interview',
        allowed,
        mutation('interview', allowed, 1),
        ctx
      )
    ).resolves.toMatchObject({ draft_version: 2 });
  });
  it('retains attributable review decision history without exposing private reasons to general readers', async () => {
    const record = await readyContext();
    const confirmBody = {
      accepted: true,
      confirmation_copy_version: CONFIRMATION_COPY_VERSION
    };
    const confirmed = await service.confirm(
      record.id,
      confirmBody,
      mutation('confirm', confirmBody, 1),
      ctx
    );
    const reviewerId = randomUUID();
    const viewerId = randomUUID();
    await assign(record, reviewerId, {
      review_lanes: ['rights'],
      read_rights_evidence: true
    });
    await assign(record, viewerId, {});
    const reviewer = makeContext(reviewerId);
    const statuses = ['changes_requested', 'pending'];
    for (let index = 0; index < statuses.length; index++) {
      const body = {
        expected_review_version: index + 1,
        status: statuses[index],
        reason: `Private rights reason ${index}`
      };
      await reviews.review(
        record.id,
        confirmed.id,
        'rights',
        body,
        mutation('rights-review', body, 1),
        reviewer
      );
    }
    const row = await db.one<{ decision_history_json: unknown }>(
      `SELECT decision_history_json FROM ${AD_REVIEWS} WHERE revision_id=:id AND lane='rights'`,
      { id: confirmed.id },
      ctx
    );
    const history =
      typeof row!.decision_history_json === 'string'
        ? JSON.parse(row!.decision_history_json)
        : row!.decision_history_json;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      reviewer_profile_id: reviewerId,
      reason: 'Private rights reason 0',
      review_version: 2
    });
    const visible = JSON.stringify(
      await service.getRevision(record.id, confirmed.id, makeContext(viewerId))
    );
    expect(visible).not.toContain('Private rights reason');
    expect(visible).not.toContain('decision_history_json');
  });
});
