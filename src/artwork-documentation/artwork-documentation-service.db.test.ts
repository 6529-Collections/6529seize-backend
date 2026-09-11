import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { AuthenticationContext } from '@/auth-context';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import {
  DROPS_TABLE,
  PROFILES_TABLE,
  USER_GROUPS_TABLE,
  IDENTITIES_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { ArtworkDocumentationDb, parseJson } from './artwork-documentation.db';
import { ArtworkDocumentationService } from './artwork-documentation.service';
import { ArtworkDocumentationReviewService } from './artwork-documentation.review';
import {
  AD_CONTEXTS,
  AD_ARTISTS,
  AD_DROP_LINKS,
  AD_GRANTS,
  AD_REVISIONS,
  AD_REVIEWS
} from './artwork-documentation.tables';
import {
  AD_EVENTS,
  AD_IDEMPOTENCY,
  AD_SOURCES
} from './artwork-documentation.tables';
import {
  COORDINATOR_READ_FLAGS,
  setKeysAndGatesCoordinatorReadAccess
} from './artwork-documentation-coordinator-access';
import { upgradeEmptyKeysAndGatesPublication } from './artwork-documentation-publication-upgrade';
import {
  Answer,
  AssetGateway,
  Capabilities,
  ContextRecord,
  Mutation
} from './artwork-documentation.types';
import {
  CONFIRMATION_COPY_VERSION,
  PUBLICATION_CONFIRMATION_COPY_VERSION,
  getProfile
} from './artwork-documentation.catalogue';
import { emptyCapabilities } from './artwork-documentation.access';
import { ArtworkAssetsDb } from './assets/artwork-assets.db';
import { anArtworkAsset } from './assets/artwork-assets.test-support';
import { digest } from './artwork-documentation.validation';
import { AD_PROGRAM_VIEWERS } from './artwork-documentation.tables';
import { programViewerCapabilities } from './artwork-documentation.program-viewers';
import {
  ProgramViewersEvent,
  setProgramViewers
} from './artwork-documentation-program-viewer-operator';
import { toAssetAccess } from './artwork-documentation.asset-links';
import { requireAssetWrite } from './assets/artwork-assets.policy';

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
  async function programViewer(
    subject: string,
    type: 'profile' | 'group' = 'profile'
  ) {
    const id = randomUUID();
    await db.insert(
      AD_PROGRAM_VIEWERS,
      {
        id,
        program_id: '6529NM-AP-01',
        subject_type: type,
        subject_id: subject,
        grantor_profile_id: actor,
        revoked_at: null,
        created_at: Date.now()
      },
      ctx
    );
    return id;
  }
  describe('program viewers', () => {
    afterEach(async () => {
      await db.query(
        `DELETE FROM ${AD_PROGRAM_VIEWERS} WHERE grantor_profile_id=:actor`,
        { actor },
        ctx
      );
    });
    it('reads the program queue, draft, files, confirmed revision and team questions without mutation authority', async () => {
      const record = await readyContext();
      const revision = await service.confirm(
        record.id,
        {
          accepted: true,
          confirmation_copy_version: CONFIRMATION_COPY_VERSION
        },
        mutation('confirm', {}, 1),
        ctx
      );
      record.latest_revision_id = revision.id;
      await setProgram(record);
      const thread = await reviews.createThread(
        record.id,
        {
          audience: 'artist_and_reviewers',
          restricted_class: 'ordinary',
          text: 'Question for the team'
        },
        mutation('thread', {}),
        ctx
      );
      const viewer = makeContext(randomUUID());
      await programViewer(
        viewer.authenticationContext!.authenticatedProfileId!
      );
      const projected = await service.getContext(record.id, viewer);
      expect(projected.capabilities).toEqual(programViewerCapabilities());
      expect(projected.modules.artwork.answers.title).toMatchObject({
        value: 'Image'
      });
      expect(projected.asset_links).toHaveLength(1);
      expect(JSON.stringify(projected)).not.toContain('subject_type');
      expect(
        (await reviews.listContexts(viewer, {}, '6529NM-AP-01')).data.map(
          (item) => item.id
        )
      ).toContain(record.id);
      expect(
        (await reviews.listContexts(viewer, {})).data.map((item) => item.id)
      ).toContain(record.id);
      expect(
        (await service.getRevision(record.id, revision.id, viewer)).id
      ).toBe(revision.id);
      expect(
        (await reviews.listThreads(record.id, viewer)).data.map(
          (item) => item.id
        )
      ).toContain(thread.id);
      await expect(reviews.listGrants(record.id, viewer)).rejects.toMatchObject(
        { code: 'ASSIGNMENT_ACCESS_REQUIRED' }
      );
    });
    it('evaluates only granted group IDs and loses access on the next read after membership removal', async () => {
      const record = await readyContext();
      await setProgram(record);
      const member = randomUUID();
      const group = 'group-' + randomUUID();
      await programViewer(group, 'group');
      let eligible = true;
      const matcher = jest.fn(
        async (profile: string, ids: readonly string[]) =>
          eligible && profile === member ? ids.filter((id) => id === group) : []
      );
      const grouped = new ArtworkDocumentationService(db, assets, undefined, {
        getGroupsUserIsEligibleForByIds: matcher
      });
      const groupedReviews = new ArtworkDocumentationReviewService(grouped);
      const viewer = makeContext(member);
      expect(
        (await grouped.getContext(record.id, viewer)).capabilities
      ).toEqual(programViewerCapabilities());
      expect(matcher).toHaveBeenCalledWith(member, [group], undefined);
      await expect(
        grouped.getContext(record.id, makeContext(randomUUID()))
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      const proxy = {
        authenticationContext: new AuthenticationContext({
          authenticatedWallet: null,
          authenticatedProfileId: randomUUID(),
          roleProfileId: member,
          activeProxyActions: []
        })
      };
      await expect(grouped.getContext(record.id, proxy)).rejects.toMatchObject({
        code: 'UNAVAILABLE'
      });
      const unrelated = await readyContext();
      await expect(
        grouped.getContext(unrelated.id, viewer)
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      eligible = false;
      await expect(grouped.getContext(record.id, viewer)).rejects.toMatchObject(
        { code: 'UNAVAILABLE' }
      );
      await expect(
        groupedReviews.listContexts(viewer, {}, '6529NM-AP-01')
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect((await groupedReviews.listContexts(viewer, {})).data).toEqual([]);
      await db.query(
        `UPDATE ${AD_PROGRAM_VIEWERS} SET revoked_at=:now WHERE subject_id=:group`,
        { now: Date.now(), group },
        ctx
      );
      eligible = true;
      await expect(grouped.getContext(record.id, viewer)).rejects.toMatchObject(
        { code: 'UNAVAILABLE' }
      );
    });
    it('uses primary reads for the real identity and reputation group criteria and sees both removal paths', async () => {
      const record = await readyContext();
      await setProgram(record);
      const member = randomUUID();
      const group = 'dynamic-' + randomUUID();
      const identityGroup = randomUUID();
      await db.insert(
        IDENTITIES_TABLE,
        {
          consolidation_key: member,
          profile_id: member,
          primary_address: '0x' + member.replace(/-/g, '').padEnd(40, '0'),
          tdh: 0,
          rep: 0,
          cic: 0,
          level_raw: 0
        },
        ctx
      );
      await db.insert(
        USER_GROUPS_TABLE,
        {
          id: group,
          name: 'Dynamic group test',
          created_by: actor,
          created_at: new Date(),
          visible: true,
          is_private: true,
          profile_group_id: identityGroup,
          rep_min: 1,
          rep_user: actor,
          rep_category: 'Documentation team',
          rep_direction: 'RECEIVED',
          owns_meme: false,
          owns_gradient: false,
          owns_nextgen: false,
          owns_lab: false
        },
        ctx
      );
      await db.insert(
        PROFILE_GROUPS_TABLE,
        { profile_group_id: identityGroup, profile_id: member },
        ctx
      );
      await db.insert(
        RATINGS_TABLE,
        {
          rater_profile_id: actor,
          matter_target_id: member,
          matter: 'REP',
          matter_category: 'Documentation team',
          rating: 1,
          last_modified: new Date()
        },
        ctx
      );
      await programViewer(group, 'group');
      const viewer = makeContext(member);
      const execute = jest.spyOn(sqlExecutor, 'execute');
      try {
        await db.executeNativeQueriesInTransaction(async (connection) => {
          execute.mockClear();
          expect(
            (await service.getContext(record.id, { ...viewer, connection }))
              .capabilities
          ).toEqual(programViewerCapabilities());
          const eligibilityReads = execute.mock.calls.filter(([sql]) =>
            [
              USER_GROUPS_TABLE,
              PROFILE_GROUPS_TABLE,
              IDENTITIES_TABLE,
              RATINGS_TABLE
            ].some((table) => sql.includes(table))
          );
          expect(eligibilityReads.length).toBeGreaterThanOrEqual(5);
          for (const call of eligibilityReads)
            expect(call[2]).toMatchObject({
              forcePool: DbPoolName.WRITE,
              wrappedConnection: connection
            });
        });
      } finally {
        execute.mockRestore();
      }
      await db.query(
        `DELETE FROM ${PROFILE_GROUPS_TABLE} WHERE profile_group_id=:group AND profile_id=:member`,
        { group: identityGroup, member },
        ctx
      );
      expect(
        (await service.authorizeContext(record.id, viewer)).capabilities
          .read_context
      ).toBe(true);
      await db.query(
        `DELETE FROM ${RATINGS_TABLE} WHERE rater_profile_id=:actor AND matter_target_id=:member AND matter_category=:category`,
        { actor, member, category: 'Documentation team' },
        ctx
      );
      await expect(
        service.authorizeContext(record.id, viewer)
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });
    it('denies every context write including discussions, uploads and new program contexts to pure viewers', async () => {
      const record = await readyContext();
      await setProgram(record);
      const viewer = makeContext(randomUUID());
      await programViewer(
        viewer.authenticationContext!.authenticatedProfileId!
      );
      const write = () => mutation(randomUUID(), {}, 1);
      const actions = [
        () =>
          service.patchModule(
            record.id,
            'artwork',
            {
              schema_version: 1,
              operations: [
                {
                  op: 'set' as const,
                  field: 'title',
                  answer: answer('Changed')
                }
              ]
            },
            write(),
            viewer
          ),
        () =>
          service.confirm(
            record.id,
            {
              accepted: true,
              confirmation_copy_version: CONFIRMATION_COPY_VERSION
            },
            write(),
            viewer
          ),
        () => service.pinArtist(record.id, randomUUID(), write(), viewer),
        () =>
          service.importSource(
            record.id,
            { source_receipt_id: randomUUID(), fields: [] },
            write(),
            viewer
          ),
        () => reviews.lifecycle(record.id, 'archived', write(), viewer),
        () =>
          reviews.grant(
            record.id,
            randomUUID(),
            { read_context: true },
            write(),
            viewer
          ),
        () => reviews.revoke(record.id, randomUUID(), write(), viewer),
        () =>
          reviews.review(
            record.id,
            randomUUID(),
            'curatorial',
            { expected_review_version: 0, status: 'accepted' },
            write(),
            viewer
          ),
        () =>
          reviews.createThread(
            record.id,
            {
              audience: 'artist_and_reviewers',
              restricted_class: 'ordinary',
              text: 'A write'
            },
            write(),
            viewer
          ),
        () =>
          reviews.comment(record.id, randomUUID(), 'A reply', write(), viewer),
        () =>
          reviews.patchThread(
            record.id,
            randomUUID(),
            { expected_thread_version: 1, resolved: true },
            write(),
            viewer
          )
      ];
      for (const action of actions)
        await expect(action()).rejects.toMatchObject({
          code: 'EDIT_NOT_ALLOWED'
        });
      const access = toAssetAccess(
        await service.authorizeContext(record.id, viewer)
      );
      expect(access.canEdit).toBe(false);
      expect(() => requireAssetWrite(access, 'artwork_final')).toThrow();
      const own = await service.createWork(
        {
          profile_id: 'stream_artwork_basic_v1',
          profile_version: 1,
          start_mode: 'standalone'
        },
        write(),
        viewer
      );
      await expect(
        service.createContextForWork(
          own.work_id,
          {
            profile_id: 'keys_and_gates_v1',
            profile_version: 1,
            program_id: '6529NM-AP-01',
            acknowledge_empty_context: true
          },
          write(),
          viewer
        )
      ).rejects.toMatchObject({ code: 'PROGRAM_INVITATION_REQUIRED' });
      expect((await db.context(record.id, ctx))!.draft_version).toBe(1);
    });
    it('preserves artist, editor, reviewer and coordinator capabilities when viewer access is also present', async () => {
      const record = await readyContext();
      await setProgram(record);
      const editor = randomUUID();
      const reviewer = randomUUID();
      const coordinator = await programCoordinator();
      await assign(record, editor, { edit_modules: ['artwork'] });
      await assign(record, reviewer, { review_lanes: ['curatorial'] });
      for (const profile of [actor, editor, reviewer, coordinator.id])
        await programViewer(profile);
      expect(
        (await service.authorizeContext(record.id, ctx)).capabilities
          .confirm_as_artist
      ).toBe(true);
      expect(
        (await service.authorizeContext(record.id, makeContext(editor)))
          .capabilities.edit_modules
      ).toEqual(['artwork']);
      expect(
        (await service.authorizeContext(record.id, makeContext(reviewer)))
          .capabilities.review_lanes
      ).toEqual(['curatorial']);
      const coordinatorCaps = (
        await service.authorizeContext(record.id, makeContext(coordinator.id))
      ).capabilities;
      expect(coordinatorCaps).toMatchObject({
        manage_context: true,
        manage_assignments: true,
        confirm_as_artist: false
      });
      for (const profile of [actor, editor, reviewer, coordinator.id]) {
        await expect(
          reviews.createThread(
            record.id,
            {
              audience: 'artist_and_reviewers',
              restricted_class: 'ordinary',
              text: 'Collaborator question'
            },
            mutation(randomUUID(), {}),
            makeContext(profile)
          )
        ).resolves.toHaveProperty('id');
      }
    });
    it('inventories before applying viewer configuration and preserves coordinator grants through replay and replacement', async () => {
      const coordinator = await programCoordinator();
      const target = await programCoordinator();
      await db.query(
        `UPDATE ${AD_GRANTS} SET revoked_at=1 WHERE id=:id`,
        { id: target.grantId },
        ctx
      );
      const group = 'viewer-group-' + randomUUID();
      await db.insert(
        USER_GROUPS_TABLE,
        {
          id: group,
          name: 'Viewer test group',
          created_by: coordinator.id,
          created_at: new Date(),
          visible: true,
          is_private: true,
          owns_meme: false,
          owns_gradient: false,
          owns_nextgen: false,
          owns_lab: false
        },
        ctx
      );
      const event: ProgramViewersEvent = {
        operator_action: 'set_program_viewers_v1',
        correlation_id: randomUUID(),
        coordinator_profile_id: coordinator.id,
        program_id: '6529NM-AP-01',
        viewers: { profiles: [target.id], groups: [group] },
        apply: false
      };
      const before = await db.query(
        `SELECT * FROM ${AD_GRANTS} WHERE id IN (:ids) ORDER BY id`,
        { ids: [coordinator.grantId, target.grantId] },
        ctx
      );
      const dry = await setProgramViewers(event, service);
      expect(dry.mode).toBe('dry_run');
      expect(
        await db.query(
          `SELECT * FROM ${AD_PROGRAM_VIEWERS} WHERE subject_id=:id`,
          { id: target.id },
          ctx
        )
      ).toEqual([]);
      const input = {
        ...event,
        apply: true,
        expected_inventory_sha256: (
          dry.inventory as { inventory_sha256: string }
        ).inventory_sha256
      };
      const applied = await setProgramViewers(input, service);
      expect(applied.mode).toBe('applied');
      expect(applied.profile_verification).toEqual([
        {
          profile_id: target.id,
          effective_capabilities: programViewerCapabilities()
        }
      ]);
      expect(
        await db.query(
          `SELECT subject_type,subject_id FROM ${AD_PROGRAM_VIEWERS} WHERE subject_id=:group AND revoked_at IS NULL`,
          { group },
          ctx
        )
      ).toEqual([{ subject_type: 'group', subject_id: group }]);
      expect(await setProgramViewers(input, service)).toEqual(applied);
      await db.query(
        `DELETE FROM ${AD_IDEMPOTENCY} WHERE id=:id`,
        { id: digest(['set_program_viewers_v1', event.correlation_id]) },
        ctx
      );
      expect(await setProgramViewers(input, service)).toEqual(applied);
      await expect(
        setProgramViewers(
          { ...input, viewers: { profiles: [coordinator.id], groups: [] } },
          service
        )
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
      expect(
        await db.query(
          `SELECT * FROM ${AD_GRANTS} WHERE id IN (:ids) ORDER BY id`,
          { ids: [coordinator.grantId, target.grantId] },
          ctx
        )
      ).toEqual(before);
      const remove = {
        ...event,
        correlation_id: randomUUID(),
        viewers: { profiles: [], groups: [] }
      };
      const removalDry = await setProgramViewers(remove, service);
      await setProgramViewers(
        {
          ...remove,
          apply: true,
          expected_inventory_sha256: (
            removalDry.inventory as { inventory_sha256: string }
          ).inventory_sha256
        },
        service
      );
      expect(
        (await db.one<{ revoked_at: number | null }>(
          `SELECT revoked_at FROM ${AD_PROGRAM_VIEWERS} WHERE subject_id=:id`,
          { id: target.id },
          ctx
        ))!.revoked_at
      ).not.toBeNull();
      expect(
        await db.query(
          `SELECT * FROM ${AD_GRANTS} WHERE id IN (:ids) ORDER BY id`,
          { ids: [coordinator.grantId, target.grantId] },
          ctx
        )
      ).toEqual(before);
    });
    it('rejects stale inventory and nonexistent viewer profiles without changing grants', async () => {
      const coordinator = await programCoordinator();
      const event: ProgramViewersEvent = {
        operator_action: 'set_program_viewers_v1',
        correlation_id: randomUUID(),
        coordinator_profile_id: coordinator.id,
        program_id: '6529NM-AP-01',
        viewers: { profiles: [coordinator.id], groups: [] },
        apply: true,
        expected_inventory_sha256: '0'.repeat(64)
      };
      await expect(setProgramViewers(event, service)).rejects.toMatchObject({
        code: 'PROGRAM_ACCESS_CHANGED'
      });
      await expect(
        setProgramViewers(
          {
            ...event,
            apply: false,
            viewers: { profiles: [randomUUID()], groups: [] }
          },
          service
        )
      ).rejects.toMatchObject({ code: 'VIEWER_PROFILE_NOT_FOUND' });
      expect(
        await db.query(
          `SELECT * FROM ${AD_PROGRAM_VIEWERS} WHERE subject_id=:id`,
          { id: coordinator.id },
          ctx
        )
      ).toEqual([]);
    });
  });
  async function programCoordinator() {
    const id = randomUUID();
    await db.insert(
      PROFILES_TABLE,
      {
        external_id: id,
        normalised_handle: id,
        handle: id,
        primary_wallet: '0x0000000000000000000000000000000000000001',
        created_by_wallet: '0x0000000000000000000000000000000000000001',
        created_at: new Date()
      },
      ctx
    );
    const grantId = randomUUID();
    await db.insert(
      AD_GRANTS,
      {
        id: grantId,
        context_id: null,
        program_id: '6529NM-AP-01',
        subject_profile_id: id,
        capabilities_json: JSON.stringify({
          ...emptyCapabilities(),
          read_context: true,
          manage_context: true,
          manage_assignments: true,
          retained_unknown_key: 'preserve'
        }),
        grantor_profile_id: actor,
        revoked_at: null,
        created_at: Date.now()
      },
      ctx
    );
    return {
      id,
      grantId,
      event: {
        correlation_id: randomUUID(),
        coordinator_profile_id: id,
        apply: false
      }
    };
  }
  async function setProgram(record: ContextRecord) {
    record.program_id = '6529NM-AP-01';
    await db.query(
      `UPDATE ${AD_CONTEXTS} SET program_id=:program WHERE id=:id`,
      { program: record.program_id, id: record.id },
      ctx
    );
    await db.saveContext(record, ctx);
  }
  it('changes only the existing coordinator read flags and applies them to draft, history, sources and discussions', async () => {
    const record = await readyContext();
    const confirmed = await service.confirm(
      record.id,
      { accepted: true, confirmation_copy_version: CONFIRMATION_COPY_VERSION },
      mutation('confirm', {}, 1),
      ctx
    );
    record.latest_revision_id = confirmed.id;
    record.modules.artwork.title = answer('Unpublished title', 'restricted');
    record.modules.identity.private_contact = answer(
      'Private contact',
      'restricted'
    );
    record.modules.rights.sensitive_context_note = answer(
      'Private rights note',
      'restricted'
    );
    record.restricted_paths = [
      'artwork.title',
      'identity.private_contact',
      'rights.sensitive_context_note'
    ];
    await setProgram(record);
    const thread = {
      field_path: 'artwork.title',
      audience: 'artist_and_reviewers',
      restricted_class: 'ordinary',
      text: 'Drafting discussion'
    };
    await reviews.createThread(
      record.id,
      thread,
      mutation('thread', thread, 1),
      ctx
    );
    const sourceId = randomUUID();
    await db.insert(
      AD_SOURCES,
      {
        id: sourceId,
        context_id: record.id,
        drop_id: randomUUID(),
        receipt_text: JSON.stringify({
          title: 'Source title',
          parts: [],
          metadata: []
        }),
        sha256: 'b'.repeat(64),
        is_excerpt: false,
        importer_profile_id: actor,
        created_at: Date.now()
      },
      ctx
    );
    const coordinator = await programCoordinator();
    const viewer = makeContext(coordinator.id);
    const before = (await db.context(record.id, ctx))!;
    expect(
      (await service.getContext(record.id, viewer)).modules.artwork.answers
        .title
    ).toEqual({ redacted: true });
    expect((await reviews.listThreads(record.id, viewer)).data).toHaveLength(0);
    const dry = await setKeysAndGatesCoordinatorReadAccess(
      coordinator.event,
      service
    );
    expect(dry.mode).toBe('dry_run');
    expect(dry.changed_read_flags).toEqual([...COORDINATOR_READ_FLAGS]);
    expect(dry.redacted_field_count).toBeGreaterThan(0);
    const apply = { ...coordinator.event, apply: true };
    const result = await setKeysAndGatesCoordinatorReadAccess(apply, service);
    expect(result.redacted_field_count).toBe(0);
    expect(result.effective_capabilities).toMatchObject({
      read_restricted_fields: true,
      read_contact: true,
      read_rights_evidence: true,
      read_archival_files: true,
      read_source_receipts: true,
      confirm_as_artist: false,
      edit_modules: [],
      review_lanes: []
    });
    expect(
      (await service.getContext(record.id, viewer)).modules.artwork.answers
        .title
    ).toEqual(record.modules.artwork.title);
    expect(
      (await service.getRevision(record.id, confirmed.id, viewer)).snapshot
        .modules.artwork.answers.title
    ).toEqual(answer('Image'));
    expect((await reviews.listThreads(record.id, viewer)).data).toHaveLength(1);
    expect(
      (await service.sourcePreview(record.id, sourceId, viewer)).receipt_text
    ).toContain('Source title');
    expect(
      JSON.stringify(await service.publicPreview(record.id, viewer))
    ).not.toMatch(
      /Unpublished title|Private contact|Private rights note|Drafting discussion/
    );
    await expect(
      service.getContext(record.id, makeContext(randomUUID()))
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      service.confirm(
        record.id,
        {
          accepted: true,
          confirmation_copy_version: CONFIRMATION_COPY_VERSION
        },
        mutation('confirm-coordinator', {}, 1),
        viewer
      )
    ).rejects.toMatchObject({ code: 'DIRECT_ARTIST_REQUIRED' });
    await expect(
      reviews.grant(
        record.id,
        coordinator.id,
        { read_restricted_fields: true },
        mutation('self-grant', {}, 1),
        viewer
      )
    ).rejects.toMatchObject({ code: 'GRANT_NOT_ALLOWED' });
    expect(await db.context(record.id, ctx)).toEqual(before);
    const saved = await db.one<{ capabilities_json: string }>(
      `SELECT capabilities_json FROM ${AD_GRANTS} WHERE id=:id`,
      { id: coordinator.grantId },
      ctx
    );
    expect(JSON.stringify(saved)).toContain('retained_unknown_key');
    expect(await setKeysAndGatesCoordinatorReadAccess(apply, service)).toEqual(
      result
    );
    await db.query(
      `DELETE FROM ${AD_IDEMPOTENCY} WHERE id=:id`,
      {
        id: (await import('./artwork-documentation.validation')).digest([
          'set_keys_and_gates_coordinator_read_access_v1',
          apply.correlation_id
        ])
      },
      ctx
    );
    expect(await setKeysAndGatesCoordinatorReadAccess(apply, service)).toEqual(
      result
    );
    expect(
      await db.query(
        `SELECT id FROM ${AD_EVENTS} WHERE id=:id`,
        { id: apply.correlation_id },
        ctx
      )
    ).toHaveLength(1);
    const other = await programCoordinator();
    await expect(
      setKeysAndGatesCoordinatorReadAccess(
        { ...apply, coordinator_profile_id: other.id },
        service
      )
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });
  it('reports current narrowed access on replay without reapplying an expired audited grant change', async () => {
    const record = await readyContext();
    record.modules.artwork.title = answer('Unpublished title', 'restricted');
    record.restricted_paths = ['artwork.title'];
    await setProgram(record);
    const coordinator = await programCoordinator();
    const apply = { ...coordinator.event, apply: true };
    const result = await setKeysAndGatesCoordinatorReadAccess(apply, service);
    expect(result.redacted_field_count).toBe(0);
    const narrowed = {
      ...result.effective_capabilities,
      read_restricted_fields: false,
      retained_unknown_key: 'preserve'
    };
    await db.query(
      `UPDATE ${AD_GRANTS} SET capabilities_json=:caps WHERE id=:id`,
      { id: coordinator.grantId, caps: JSON.stringify(narrowed) },
      ctx
    );
    const idempotencyId = digest([
      'set_keys_and_gates_coordinator_read_access_v1',
      apply.correlation_id
    ]);
    await db.query(
      `DELETE FROM ${AD_IDEMPOTENCY} WHERE id=:id`,
      { id: idempotencyId },
      ctx
    );
    const replay = await setKeysAndGatesCoordinatorReadAccess(apply, service);
    expect(replay.changed_read_flags).toEqual(result.changed_read_flags);
    expect(replay.effective_capabilities).toMatchObject({
      read_restricted_fields: false,
      confirm_as_artist: false,
      edit_modules: [],
      review_lanes: []
    });
    expect(replay.target_capabilities.read_restricted_fields).toBe(true);
    expect(replay.redacted_field_count).toBeGreaterThan(0);
    const dry = await setKeysAndGatesCoordinatorReadAccess(
      coordinator.event,
      service
    );
    expect(dry.mode).toBe('dry_run');
    expect(dry.changed_read_flags).toEqual(['read_restricted_fields']);
    expect(dry.effective_capabilities).toEqual(replay.effective_capabilities);
    const saved = await db.one<{ capabilities_json: unknown }>(
      `SELECT capabilities_json FROM ${AD_GRANTS} WHERE id=:id`,
      { id: coordinator.grantId },
      ctx
    );
    expect(parseJson(saved!.capabilities_json)).toEqual(narrowed);
    expect(
      await db.query(
        `SELECT id FROM ${AD_EVENTS} WHERE id=:id`,
        { id: apply.correlation_id },
        ctx
      )
    ).toHaveLength(1);
    expect(
      await db.query(
        `SELECT id FROM ${AD_IDEMPOTENCY} WHERE id=:id`,
        { id: idempotencyId },
        ctx
      )
    ).toHaveLength(1);
  });
  it('fails coordinator operations closed for absent, scoped, revoked or duplicate grants', async () => {
    await expect(
      setKeysAndGatesCoordinatorReadAccess(
        {
          correlation_id: randomUUID(),
          coordinator_profile_id: randomUUID(),
          apply: true
        },
        service
      )
    ).rejects.toMatchObject({ code: 'COORDINATOR_PROFILE_NOT_FOUND' });
    const coordinator = await programCoordinator();
    await db.query(
      `UPDATE ${AD_GRANTS} SET revoked_at=:now WHERE id=:id`,
      { id: coordinator.grantId, now: Date.now() },
      ctx
    );
    await expect(
      setKeysAndGatesCoordinatorReadAccess(coordinator.event, service)
    ).rejects.toMatchObject({ code: 'EXISTING_COORDINATOR_GRANT_REQUIRED' });
    await db.query(
      `UPDATE ${AD_GRANTS} SET revoked_at=NULL,context_id=:context WHERE id=:id`,
      { id: coordinator.grantId, context: randomUUID() },
      ctx
    );
    await expect(
      setKeysAndGatesCoordinatorReadAccess(coordinator.event, service)
    ).rejects.toMatchObject({ code: 'EXISTING_COORDINATOR_GRANT_REQUIRED' });
    await db.query(
      `UPDATE ${AD_GRANTS} SET context_id=NULL,capabilities_json=:caps WHERE id=:id`,
      {
        id: coordinator.grantId,
        caps: JSON.stringify({ ...emptyCapabilities(), read_context: true })
      },
      ctx
    );
    await expect(
      setKeysAndGatesCoordinatorReadAccess(coordinator.event, service)
    ).rejects.toMatchObject({ code: 'EXISTING_COORDINATOR_GRANT_REQUIRED' });
  });
  it('confirms a publication-only record while keeping team questions outside every artwork snapshot and preview', async () => {
    const record = await readyContext();
    record.profile = getProfile('stream_artwork_basic_v1', 2);
    record.asset_links[0].manifest = {
      ...record.asset_links[0].manifest,
      role: 'artwork_final',
      intended_visibility: 'public_record'
    };
    await db.saveContext(record, ctx);
    const thread = {
      audience: 'artist_and_reviewers',
      restricted_class: 'ordinary',
      text: 'Team question marker only'
    };
    await reviews.createThread(
      record.id,
      thread,
      mutation('questions', thread, 1),
      ctx
    );
    const body = {
      accepted: true,
      confirmation_copy_version: PUBLICATION_CONFIRMATION_COPY_VERSION
    };
    const confirmed = await service.confirm(
      record.id,
      body,
      mutation('confirm-public', body, 1),
      ctx
    );
    expect(confirmed.snapshot.profile.intake_mode).toBe('publication_only');
    expect(confirmed.confirmation).toMatchObject({
      copy_version: PUBLICATION_CONFIRMATION_COPY_VERSION
    });
    const raw = await db.one<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM ${AD_REVISIONS} WHERE id=:id`,
      { id: confirmed.id },
      ctx
    );
    expect(JSON.stringify(raw)).not.toContain('Team question marker only');
    expect(
      JSON.stringify(await service.publicPreview(record.id, ctx))
    ).not.toContain('Team question marker only');
    expect((await reviews.listThreads(record.id, ctx)).data).toHaveLength(1);
    for (const [field, value] of [
      ['title', answer('Private title', 'restricted')]
    ] as const) {
      const patch = {
        schema_version: 1,
        operations: [{ op: 'set' as const, field, answer: value }]
      };
      await expect(
        service.patchModule(
          record.id,
          'artwork',
          patch,
          mutation('private-patch', patch, 1),
          ctx
        )
      ).rejects.toMatchObject({ code: 'PUBLICATION_INTENT_REQUIRED' });
    }
    record.modules.identity.private_contact = answer(
      'Tainted private record',
      'restricted'
    );
    await db.saveContext(record, ctx);
    await expect(
      service.confirm(
        record.id,
        body,
        mutation('confirm-tainted', body, 1),
        ctx
      )
    ).rejects.toMatchObject({ code: 'FIELD_NOT_IN_PROFILE' });
  });
  it('upgrades only empty Keys contexts and preserves data, sources, grants and questions', async () => {
    const created = await create();
    const pristine = (await db.context(created.id, ctx))!;
    pristine.profile = getProfile('keys_and_gates_v1', 1);
    await setProgram(pristine);
    const filled = await readyContext();
    filled.profile = getProfile('keys_and_gates_v1', 1);
    await setProgram(filled);
    const thread = {
      audience: 'artist_and_reviewers',
      restricted_class: 'ordinary',
      text: 'Question survives profile upgrade'
    };
    await reviews.createThread(
      pristine.id,
      thread,
      mutation('questions', thread, 1),
      ctx
    );
    const coordinator = await programCoordinator();
    const dry = await upgradeEmptyKeysAndGatesPublication(
      coordinator.event,
      service
    );
    expect(dry).toMatchObject({
      mode: 'dry_run',
      contexts: expect.arrayContaining([
        { context_id: pristine.id, status: 'eligible' },
        { context_id: filled.id, status: 'skipped', reason: 'ANSWERS_EXIST' }
      ])
    });
    expect((await db.context(pristine.id, ctx))!.profile.version).toBe(1);
    const apply = { ...coordinator.event, apply: true };
    const upgraded = await upgradeEmptyKeysAndGatesPublication(apply, service);
    expect((await db.context(pristine.id, ctx))!.profile.version).toBe(2);
    expect((await db.context(pristine.id, ctx))!.draft_version).toBe(2);
    expect((await db.context(filled.id, ctx))!.profile.version).toBe(1);
    expect((await reviews.listThreads(pristine.id, ctx)).data).toHaveLength(1);
    expect(await upgradeEmptyKeysAndGatesPublication(apply, service)).toEqual(
      upgraded
    );
  });
  it('sees an upload committed while the upgrade waits for its context lock', async () => {
    const created = await create();
    const record = (await db.context(created.id, ctx))!;
    record.profile = getProfile('keys_and_gates_v1', 1);
    await setProgram(record);
    const coordinator = await programCoordinator();
    let releaseReservation!: () => void;
    let reservationLocked!: () => void;
    let upgradeWaiting!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      reservationLocked = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      upgradeWaiting = resolve;
    });
    const originalOne = sqlExecutor.oneOrNull.bind(sqlExecutor);
    const one = jest
      .spyOn(sqlExecutor, 'oneOrNull')
      .mockImplementation(async (...args) => {
        const row = await originalOne(...args);
        if (
          args[0].startsWith(
            `select lifecycle, profile_json, modules_json from ${AD_CONTEXTS}`
          ) &&
          args[1]?.contextId === record.id
        ) {
          reservationLocked();
          await release;
        }
        return row;
      });
    const originalContext = db.context.bind(db);
    const contextRead = jest
      .spyOn(db, 'context')
      .mockImplementation(async (...args) => {
        if (args[0] === record.id && args[2] === true) upgradeWaiting();
        return originalContext(...args);
      });
    const assetDb = new ArtworkAssetsDb(() => sqlExecutor);
    const reserving = assetDb.reserve(
      anArtworkAsset({
        id: randomUUID(),
        context_id: record.id,
        uploader_profile_id: actor,
        role: 'camera_original',
        intended_visibility: 'restricted'
      })
    );
    let upgrading:
      | ReturnType<typeof upgradeEmptyKeysAndGatesPublication>
      | undefined;
    try {
      await locked;
      upgrading = upgradeEmptyKeysAndGatesPublication(
        { ...coordinator.event, apply: true },
        service
      );
      await waiting;
      releaseReservation();
      await reserving;
      expect(await upgrading).toMatchObject({
        contexts: expect.arrayContaining([
          {
            context_id: record.id,
            status: 'skipped',
            reason: 'UPLOAD_OR_ASSET_EXISTS'
          }
        ])
      });
      expect((await db.context(record.id, ctx))!.profile.version).toBe(1);
    } finally {
      releaseReservation();
      await Promise.allSettled([reserving, upgrading]);
      one.mockRestore();
      contextRead.mockRestore();
    }
  });
  it('rejects incompatible shared identity pins and profile changes without rewriting legacy data', async () => {
    const legacy = await create();
    const patch = {
      schema_version: 1,
      expected_artist_record_version: 0,
      operations: [
        {
          op: 'set' as const,
          field: 'display_name',
          answer: answer('Private legacy name', 'restricted')
        }
      ]
    };
    const saved = await service.patchModule(
      legacy.id,
      'identity',
      patch,
      mutation('identity', patch, 1),
      ctx
    );
    const body = {
      profile_id: 'stream_artwork_basic_v1',
      profile_version: 2,
      start_mode: 'standalone'
    };
    const publication = await service.createWork(
      body,
      mutation('create-public', body),
      ctx
    );
    await expect(
      service.pinArtist(
        publication.id,
        saved.artist_record_revision_id!,
        mutation('pin', { id: saved.artist_record_revision_id }, 1),
        ctx
      )
    ).rejects.toMatchObject({ code: 'PUBLICATION_INTENT_REQUIRED' });
    const unchanged = await service.getContext(publication.id, ctx);
    expect(unchanged.artist_record_revision_id).toBeNull();
    expect(unchanged.modules.identity.answers).toEqual({});
    expect(
      (await service.getContext(legacy.id, ctx)).modules.identity.answers
        .display_name
    ).toEqual(patch.operations[0].answer);
    await expect(
      reviews.upgrade(
        legacy.id,
        'stream_artwork_basic_v1',
        2,
        mutation('upgrade', {}, 2),
        ctx
      )
    ).rejects.toMatchObject({ code: 'PUBLICATION_INTENT_REQUIRED' });
    expect((await service.getContext(legacy.id, ctx)).profile.version).toBe(1);
    await expect(
      reviews.upgrade(
        publication.id,
        'stream_artwork_basic_v1',
        1,
        mutation('downgrade', {}, 1),
        ctx
      )
    ).rejects.toMatchObject({ code: 'PUBLICATION_PROFILE_REQUIRED' });
  });
  it('imports only valid public source mappings into publication-only profiles', async () => {
    const body = {
      profile_id: 'stream_artwork_basic_v1',
      profile_version: 2,
      start_mode: 'standalone'
    };
    const publication = await service.createWork(
      body,
      mutation('create-public', body),
      ctx
    );
    const receipt = randomUUID();
    await db.insert(
      AD_SOURCES,
      {
        id: receipt,
        context_id: publication.id,
        drop_id: randomUUID(),
        receipt_text: JSON.stringify({
          title: 'Public source title',
          parts: [],
          metadata: []
        }),
        sha256: 'b'.repeat(64),
        is_excerpt: false,
        importer_profile_id: actor,
        created_at: Date.now()
      },
      ctx
    );
    const input = {
      source_receipt_id: receipt,
      fields: [{ source_path: 'title', target_field: 'artwork.title' }]
    };
    const result = await service.importSource(
      publication.id,
      input,
      mutation('source-import', input, 1),
      ctx
    );
    expect(result.modules.artwork.answers.title).toEqual(
      answer('Public source title')
    );
    const invalid = {
      ...input,
      fields: [
        { source_path: 'title', target_field: 'identity.private_contact' }
      ]
    };
    await expect(
      service.importSource(
        publication.id,
        invalid,
        mutation('invalid-source', invalid, 2),
        ctx
      )
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE_MAPPING' });
    expect((await db.context(publication.id, ctx))!.restricted_paths).toEqual(
      []
    );
  });
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
  it('binds external asset mutation keys before allowing same-body retries', async () => {
    const record = await readyContext();
    const uploadId = randomUUID();
    const body = { parts: [{ part_number: 1, etag: 'first' }] };
    const write = mutation(`complete:${record.id}:${uploadId}`, body);
    await service.bindAssetMutation(record.id, uploadId, write, ctx);
    await expect(
      service.bindAssetMutation(record.id, uploadId, write, ctx)
    ).resolves.toBeUndefined();
    await expect(
      service.bindAssetMutation(
        record.id,
        uploadId,
        { ...write, body: { parts: [{ part_number: 1, etag: 'different' }] } },
        ctx
      )
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    await expect(
      service.bindAssetMutation(
        record.id,
        uploadId,
        write,
        makeContext(randomUUID())
      )
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('isolates the smoke operator policy from disabled API feature flags', async () => {
    process.env.ARTWORK_DOCUMENTATION_ENABLED = 'false';
    process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED = 'false';
    const operator = new ArtworkDocumentationService(db, assets, {
      enabled: () => true,
      selfServiceEnabled: () => true
    });
    const body = {
      profile_id: 'stream_artwork_basic_v1',
      profile_version: 1,
      start_mode: 'standalone'
    };
    const write = mutation('operator:create_smoke_context_v1', body);
    const created = await operator.createWork(body, write, ctx);
    expect((await operator.createWork(body, write, ctx)).id).toBe(created.id);
    expect(created).toMatchObject({
      owner_profile_id: actor,
      program_id: null,
      artist_record_revision_id: null,
      asset_links: [],
      source_links: []
    });
    expect(
      Object.values(created.modules).every(
        (module) => Object.keys(module.answers).length === 0
      )
    ).toBe(true);
    expect(
      await db.query(
        `SELECT owner_profile_id FROM ${AD_ARTISTS} WHERE owner_profile_id=:actor`,
        { actor },
        ctx
      )
    ).toEqual([]);
    await expect(service.getContext(created.id, ctx)).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    });
    expect(process.env.ARTWORK_DOCUMENTATION_ENABLED).toBe('false');
    expect(process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED).toBe(
      'false'
    );
  });
});
