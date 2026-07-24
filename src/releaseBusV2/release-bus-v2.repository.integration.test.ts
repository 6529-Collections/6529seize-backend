import 'reflect-metadata';
import {
  RELEASE_BUS_V2_CONTROLS_TABLE,
  RELEASE_BUS_V2_LOCKS_TABLE
} from '@/constants';
import { ReleaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.repository';
import { ReleaseBusV2Service } from '@/releaseBusV2/release-bus-v2.service';
import { describeWithSeed } from '@/tests/_setup/seed';

jest.mock('@/releaseBusV2/release-bus-v2.github-app', () => ({
  releaseBusGitHubApp: {
    ensureCommitStatus: jest.fn(),
    resolveRef: jest.fn()
  }
}));

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const DIGEST_A = 'c'.repeat(64);

describeWithSeed(
  'Release Bus v2 repository integration',
  [
    {
      table: RELEASE_BUS_V2_LOCKS_TABLE,
      rows: [
        { name: 'scheduler', updated_at: 1, row_version: 1 },
        { name: 'staging-environment', updated_at: 1, row_version: 1 },
        { name: 'production-environment', updated_at: 1, row_version: 1 }
      ]
    },
    {
      table: RELEASE_BUS_V2_CONTROLS_TABLE,
      rows: [
        {
          scope: 'ALL',
          paused: false,
          reason: 'integration test',
          updated_at: 1,
          row_version: 1
        },
        {
          scope: 'STAGING',
          paused: false,
          reason: 'integration test',
          updated_at: 1,
          row_version: 1
        },
        {
          scope: 'PRODUCTION',
          paused: false,
          reason: 'integration test',
          updated_at: 1,
          row_version: 1
        }
      ]
    }
  ],
  () => {
    const previousMode = process.env.RELEASE_BUS_V2_MODE;
    let repository: ReleaseBusV2Repository;

    beforeEach(() => {
      process.env.RELEASE_BUS_V2_MODE = 'STAGING';
      repository = new ReleaseBusV2Repository();
    });

    afterAll(() => {
      if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
      else process.env.RELEASE_BUS_V2_MODE = previousMode;
    });

    it('allows concurrent claimers to create exactly one staging train', async () => {
      const candidate = await repository.createCandidate(
        {
          repository: 'frontend',
          prNumber: 10,
          branchName: 'feature/exact-claim',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: null,
          prEvidence: null
        },
        {}
      );
      const service = new ReleaseBusV2Service(repository);

      await Promise.all([
        service.claimLane('STAGING', SHA_B, SHA_B, 'claim-a'),
        service.claimLane('STAGING', SHA_B, SHA_B, 'claim-b')
      ]);

      const trains = await repository.listTrains(10, {});
      expect(trains).toHaveLength(1);
      expect(await repository.listTrainCandidates(trains[0].id, {})).toEqual([
        expect.objectContaining({ candidate_id: candidate.id, sequence: 1 })
      ]);
      expect(
        (await repository.findCandidateById(candidate.id, {}))?.status
      ).toBe('STAGING_IN_TRAIN');
    });

    it('supersedes an older immutable PR head before the newer head can queue', async () => {
      const older = await repository.createCandidate(
        {
          repository: 'frontend',
          prNumber: 11,
          branchName: 'feature/moving-head',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: null,
          prEvidence: null
        },
        {}
      );
      const superseded = await repository.supersedeOtherPrHeads(
        'frontend',
        11,
        SHA_B,
        {}
      );
      expect(superseded).toEqual([
        expect.objectContaining({ id: older.id, head_sha: SHA_A })
      ]);
      expect((await repository.findCandidateById(older.id, {}))?.status).toBe(
        'SUPERSEDED'
      );
    });

    it('invalidates exact readiness when a registered branch head moves', async () => {
      const registered = await repository.createCandidate(
        {
          repository: 'backend',
          prNumber: 111,
          branchName: 'feature/moved-after-registration',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: { units: ['api'], edges: [] },
          prEvidence: null
        },
        {}
      );
      await expect(
        repository.supersedeMovedBranchHeads(
          'backend',
          registered.branch_name,
          SHA_B,
          {}
        )
      ).resolves.toEqual([expect.objectContaining({ id: registered.id })]);
      expect(
        (await repository.findCandidateById(registered.id, {}))?.status
      ).toBe('SUPERSEDED');
    });

    it('does not supersede an immutable candidate after a train claims it', async () => {
      const claimed = await repository.createCandidate(
        {
          repository: 'frontend',
          prNumber: 112,
          branchName: 'feature/deleted-after-merge',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: null,
          prEvidence: null
        },
        {}
      );
      const service = new ReleaseBusV2Service(repository);
      const train = await service.claimLane(
        'STAGING',
        SHA_B,
        SHA_B,
        'claim-before-branch-deletion'
      );

      expect(train).not.toBeNull();
      await expect(
        repository.supersedeMovedBranchHeads(
          'frontend',
          claimed.branch_name,
          'deleted',
          {}
        )
      ).resolves.toEqual([]);
      await expect(
        repository.supersedeOtherPrHeads(
          'frontend',
          claimed.pr_number,
          SHA_B,
          {}
        )
      ).resolves.toEqual([]);
      expect(await repository.findCandidateById(claimed.id, {})).toEqual(
        expect.objectContaining({
          status: 'STAGING_IN_TRAIN',
          current_train_id: train?.id,
          superseded_at: null
        })
      );
    });

    it('clears stale supersession bookkeeping when an active train repairs its candidate', async () => {
      const claimed = await repository.createCandidate(
        {
          repository: 'backend',
          prNumber: 113,
          branchName: 'feature/repair-active-candidate',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: { units: ['api'], edges: [] },
          prEvidence: null
        },
        {}
      );
      const service = new ReleaseBusV2Service(repository);
      const train = await service.claimLane(
        'STAGING',
        SHA_B,
        SHA_B,
        'claim-before-repair'
      );
      const active = await repository.findCandidateById(claimed.id, {});
      expect(active).not.toBeNull();
      await repository.updateCandidate(
        claimed.id,
        active!.row_version,
        { status: 'SUPERSEDED', supersededAt: 2 },
        {}
      );
      const stale = await repository.findCandidateById(claimed.id, {});
      expect(stale).not.toBeNull();
      await repository.updateCandidate(
        claimed.id,
        stale!.row_version,
        {
          status: 'STAGING_IN_TRAIN',
          currentTrainId: train!.id,
          supersededAt: null
        },
        {}
      );

      expect(await repository.findCandidateById(claimed.id, {})).toEqual(
        expect.objectContaining({
          status: 'STAGING_IN_TRAIN',
          current_train_id: train?.id,
          superseded_at: null
        })
      );
    });

    it('restores exact production readiness after a merged source branch is cleaned up', async () => {
      const registered = await repository.createCandidate(
        {
          repository: 'frontend',
          prNumber: 114,
          branchName: 'feature/merged-production-cleanup',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: null,
          prEvidence: null
        },
        {}
      );
      await repository.updateCandidate(
        registered.id,
        registered.row_version,
        {
          status: 'READY_FOR_PRODUCTION',
          stagingValidatedTrainId: 'staging-train',
          stagingValidatedManifestId: 'staging-manifest',
          productionRequestedAt: 2,
          productionRequestedBy: 'owner'
        },
        {}
      );
      const service = new ReleaseBusV2Service(repository);
      await service.invalidateBranch(
        registered.repository,
        registered.branch_name,
        'deleted',
        'reconciler'
      );
      await repository.appendEvent(
        {
          candidateId: registered.id,
          eventType: 'CANDIDATE_STATUS_OBSERVED_AFTER_SUPERSESSION',
          actor: 'integration'
        },
        {}
      );

      await expect(
        service.restoreProductionReadinessAfterBranchCleanup(
          registered.id,
          'reconciler'
        )
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'READY_FOR_PRODUCTION',
          current_train_id: null,
          superseded_at: null,
          staging_validated_manifest_id: 'staging-manifest',
          production_requested_at: 2
        })
      );
    });

    it('claims only explicitly production-ready candidates', async () => {
      process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
      const explicit = await repository.createCandidate(
        {
          repository: 'frontend',
          prNumber: 12,
          branchName: 'feature/explicit-production',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: null,
          prEvidence: null
        },
        {}
      );
      const stagingOnly = await repository.createCandidate(
        {
          repository: 'frontend',
          prNumber: 13,
          branchName: 'feature/staging-only',
          headSha: SHA_B,
          requestedBy: 'integration',
          deployPlan: null,
          prEvidence: null
        },
        {}
      );
      await repository.updateCandidate(
        explicit.id,
        explicit.row_version,
        {
          status: 'READY_FOR_PRODUCTION',
          productionRequestedAt: 1,
          productionRequestedBy: 'owner'
        },
        {}
      );
      const train = await new ReleaseBusV2Service(repository).claimLane(
        'PRODUCTION',
        SHA_A,
        SHA_B,
        'production-claim'
      );
      expect(train?.lane).toBe('PRODUCTION');
      expect(await repository.listTrainCandidates(train?.id ?? '', {})).toEqual(
        [expect.objectContaining({ candidate_id: explicit.id })]
      );
      expect(
        (await repository.findCandidateById(stagingOnly.id, {}))?.status
      ).toBe('READY_FOR_STAGING');
    });

    it('yields an impossible frontend-only qualification and atomically replans with later backend-ready work', async () => {
      process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
      const frontend = await repository.createCandidate(
        {
          repository: 'frontend',
          prNumber: 120,
          branchName: 'feature/frontend-production-deadlock',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: null,
          prEvidence: null
        },
        {}
      );
      await repository.updateCandidate(
        frontend.id,
        frontend.row_version,
        {
          status: 'READY_FOR_PRODUCTION',
          productionRequestedAt: 1,
          productionRequestedBy: 'owner'
        },
        {}
      );
      const service = new ReleaseBusV2Service(repository);
      const parent = await service.claimLane(
        'PRODUCTION',
        SHA_A,
        SHA_B,
        'deadlock-parent'
      );
      expect(parent).not.toBeNull();
      const claimedFrontend = await repository.findCandidateById(
        frontend.id,
        {}
      );
      expect(claimedFrontend).not.toBeNull();
      await repository.updateCandidate(
        frontend.id,
        claimedFrontend!.row_version,
        {
          status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
          currentTrainId: parent!.id
        },
        {}
      );
      await repository.updateTrain(
        parent!.id,
        parent!.row_version,
        {
          status: 'PREPARED',
          frontendComposedSha: SHA_C,
          backendComposedSha: SHA_B,
          frontendArtifactDigest: DIGEST_A,
          backendArtifactDigest: null
        },
        {}
      );
      const preparedParent = await repository.findTrain(parent!.id, {});
      expect(preparedParent).not.toBeNull();
      const qualification = await repository.createQualificationTrain(
        {
          parentTrainId: parent!.id,
          frontendBaseSha: SHA_A,
          backendBaseSha: SHA_B,
          frontendComposedSha: SHA_C,
          backendComposedSha: SHA_B,
          frontendArtifactDigest: DIGEST_A,
          backendArtifactDigest: null,
          candidateIds: [frontend.id]
        },
        {}
      );
      await repository.updateTrain(
        parent!.id,
        preparedParent!.row_version,
        {
          status: 'WAITING_FOR_ENVIRONMENT',
          qualificationTrainId: qualification.id
        },
        {}
      );

      const maintenanceScheduler = await repository.acquireLock(
        'scheduler',
        null,
        'integration-maintenance',
        60_000,
        {}
      );
      expect(maintenanceScheduler?.lease_token).toBeTruthy();
      await expect(
        service.yieldUnsatisfiableProductionQualification({
          qualificationTrainId: qualification.id,
          stagingIdentity: {
            frontendSha: SHA_C,
            backendSha: SHA_A
          },
          actor: 'integration-recovery',
          maintenanceSchedulerLeaseToken: 'wrong-token'
        })
      ).rejects.toThrow('lost its exclusive all-lock safety fence');
      expect(await repository.findTrain(parent!.id, {})).toEqual(
        expect.objectContaining({ status: 'WAITING_FOR_ENVIRONMENT' })
      );
      await expect(
        service.yieldUnsatisfiableProductionQualification({
          qualificationTrainId: qualification.id,
          stagingIdentity: {
            frontendSha: SHA_C,
            backendSha: SHA_B
          },
          actor: 'integration-recovery',
          maintenanceSchedulerLeaseToken: maintenanceScheduler!.lease_token!
        })
      ).rejects.toThrow('is not unsatisfiable');
      expect(await repository.findTrain(parent!.id, {})).toEqual(
        expect.objectContaining({ status: 'WAITING_FOR_ENVIRONMENT' })
      );
      const yielded = await service.yieldUnsatisfiableProductionQualification({
        qualificationTrainId: qualification.id,
        stagingIdentity: {
          frontendSha: SHA_C,
          backendSha: SHA_A
        },
        actor: 'integration-recovery',
        maintenanceSchedulerLeaseToken: maintenanceScheduler!.lease_token!
      });
      await repository.releaseLock(
        'scheduler',
        maintenanceScheduler!.lease_token!,
        {}
      );
      expect(yielded).toEqual({
        yielded: true,
        parentTrainId: parent!.id,
        qualificationTrainId: qualification.id,
        candidateIds: [frontend.id]
      });
      expect(await repository.findTrain(parent!.id, {})).toEqual(
        expect.objectContaining({ status: 'CANCELLED' })
      );
      expect(await repository.findTrain(qualification.id, {})).toEqual(
        expect.objectContaining({ status: 'CANCELLED' })
      );
      expect(await repository.findCandidateById(frontend.id, {})).toEqual(
        expect.objectContaining({
          status: 'WAITING_FOR_PRODUCTION_REPLAN',
          current_train_id: null,
          production_requested_by: 'owner'
        })
      );
      await expect(
        service.claimLane('PRODUCTION', SHA_A, SHA_C, 'deadlock-held-only', {
          frontendSha: SHA_C,
          backendSha: SHA_A
        })
      ).resolves.toBeNull();
      expect(await repository.findCandidateById(frontend.id, {})).toEqual(
        expect.objectContaining({
          status: 'WAITING_FOR_PRODUCTION_REPLAN',
          current_train_id: null
        })
      );

      const backendCandidates = await Promise.all(
        [121, 122].map((prNumber) =>
          repository.createCandidate(
            {
              repository: 'backend',
              prNumber,
              branchName: `feature/backend-production-${prNumber}`,
              headSha: prNumber === 121 ? SHA_A : SHA_C,
              requestedBy: 'integration',
              deployPlan: { units: ['api'], edges: [] },
              prEvidence: null
            },
            {}
          )
        )
      );
      for (const backend of backendCandidates)
        await repository.updateCandidate(
          backend.id,
          backend.row_version,
          {
            status: 'READY_FOR_PRODUCTION',
            productionRequestedAt: backend.pr_number,
            productionRequestedBy: 'owner'
          },
          {}
        );

      const [firstReplan, overlappingReconcile] = await Promise.all([
        service.claimLane('PRODUCTION', SHA_A, SHA_C, 'deadlock-replan-a', {
          frontendSha: SHA_C,
          backendSha: SHA_A
        }),
        service.claimLane('PRODUCTION', SHA_A, SHA_C, 'deadlock-replan-b', {
          frontendSha: SHA_C,
          backendSha: SHA_A
        })
      ]);
      expect(firstReplan?.id).toBe(overlappingReconcile?.id);
      expect(firstReplan?.id).not.toBe(parent!.id);
      const replannedMemberships = await repository.listTrainCandidates(
        firstReplan!.id,
        {}
      );
      expect(
        replannedMemberships
          .map(({ candidate_id }) => candidate_id)
          .sort((left, right) => left.localeCompare(right))
      ).toEqual(
        [frontend.id, ...backendCandidates.map(({ id }) => id)].sort(
          (left, right) => left.localeCompare(right)
        )
      );
      for (const candidateId of [
        frontend.id,
        ...backendCandidates.map(({ id }) => id)
      ])
        expect(await repository.findCandidateById(candidateId, {})).toEqual(
          expect.objectContaining({
            status: 'PRODUCTION_IN_TRAIN',
            current_train_id: firstReplan!.id
          })
        );
      expect(
        (await repository.listTrains(20, {})).filter(
          ({ lane, status }) =>
            lane === 'PRODUCTION' &&
            !['PRODUCTION_DEPLOYED', 'FAILED', 'CANCELLED'].includes(status)
        )
      ).toHaveLength(1);
      expect(await repository.listEvents(parent!.id, 20, {})).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: 'PRODUCTION_TRAIN_YIELDED_FOR_SAFE_REPLAN'
          }),
          expect.objectContaining({
            event_type: 'CANDIDATE_WAITING_FOR_PRODUCTION_REPLAN'
          })
        ])
      );
    });

    it('creates one immutable qualification train across duplicate invocations', async () => {
      const input = {
        parentTrainId: 'parent-train',
        frontendBaseSha: SHA_A,
        backendBaseSha: SHA_B,
        frontendComposedSha: SHA_B,
        backendComposedSha: SHA_A,
        frontendArtifactDigest: DIGEST_A,
        backendArtifactDigest: null,
        candidateIds: ['candidate-a', 'candidate-b']
      } as const;

      const [first, second] = await Promise.all([
        repository.createQualificationTrain(input, {}),
        repository.createQualificationTrain(input, {})
      ]);
      expect(first.id).toBe(second.id);
      expect(await repository.listTrainCandidates(first.id, {})).toHaveLength(
        2
      );
      await expect(
        repository.createQualificationTrain(
          { ...input, frontendArtifactDigest: 'd'.repeat(64) },
          {}
        )
      ).rejects.toThrow('different immutable content');
    });

    it('rejects reuse of an operation idempotency key with changed identity', async () => {
      const input = {
        idempotencyKey: 'rb2:train:prepare:frontend:a1',
        trainId: 'train',
        operationType: 'PREPARE_ARTIFACT_FRONTEND',
        repository: 'frontend' as const,
        service: null,
        environment: 'orchestration',
        expectedSha: SHA_A,
        artifactDigest: null,
        request: {
          workflow: 'release-bus-v2-preflight.yml',
          expected_sha: SHA_A
        },
        maxAttempts: 3
      };
      const first = await repository.getOrCreateOperation(input, {});
      const duplicate = await repository.getOrCreateOperation(input, {});
      expect(duplicate.id).toBe(first.id);
      await expect(
        repository.getOrCreateOperation({ ...input, expectedSha: SHA_B }, {})
      ).rejects.toThrow('different immutable operation identity');
    });

    it('serializes staging ownership and releases only the exact lease token', async () => {
      const first = await repository.acquireLock(
        'staging-environment',
        'train-a',
        'train:train-a',
        60_000,
        {}
      );
      expect(first?.lease_token).toBeTruthy();
      await expect(
        repository.acquireLock(
          'staging-environment',
          'train-b',
          'train:train-b',
          60_000,
          {}
        )
      ).resolves.toBeNull();
      await expect(
        repository.releaseLock('staging-environment', 'wrong-token', {})
      ).resolves.toBe(false);
      await expect(
        repository.releaseLock(
          'staging-environment',
          first?.lease_token ?? '',
          {}
        )
      ).resolves.toBe(true);
    });

    it('finds staging validation only for exact SHAs and artifact digests', async () => {
      const manifest = await repository.createManifest(
        {
          train_id: 'staging-train',
          lane: 'STAGING',
          identity_sha256: 'e'.repeat(64),
          status: 'STAGING_VALIDATED',
          frontend_sha: SHA_A,
          backend_sha: null,
          frontend_artifact_digest: DIGEST_A,
          backend_artifact_digest: null,
          e2e_run_id: '123',
          manifest_json: { schema_version: 2, train_id: 'staging-train' },
          deployed_at: 1,
          validated_at: 2
        },
        {}
      );
      await expect(
        repository.findValidatedManifestByRelease(
          SHA_A,
          null,
          DIGEST_A,
          null,
          {}
        )
      ).resolves.toEqual(expect.objectContaining({ id: manifest.id }));
      await expect(
        repository.findValidatedManifestByRelease(
          SHA_A,
          null,
          'f'.repeat(64),
          null,
          {}
        )
      ).resolves.toBeNull();
      await expect(
        repository.findValidatedManifestByShas(SHA_A, null, {})
      ).resolves.toEqual(expect.objectContaining({ id: manifest.id }));
    });
  }
);
