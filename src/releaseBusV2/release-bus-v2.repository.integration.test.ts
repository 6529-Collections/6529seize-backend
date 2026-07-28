import 'reflect-metadata';
import {
  RELEASE_BUS_V2_CONTROLS_TABLE,
  RELEASE_BUS_V2_LOCKS_TABLE,
  RELEASE_BUS_V2_MANIFESTS_TABLE,
  RELEASE_BUS_V2_STAGING_STATE_TABLE
} from '@/constants';
import { ReleaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.repository';
import { ReleaseBusV2Service } from '@/releaseBusV2/release-bus-v2.service';
import { dbSupplier } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import path from 'node:path';

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
    },
    {
      table: RELEASE_BUS_V2_STAGING_STATE_TABLE,
      rows: [
        {
          id: 'current',
          status: 'CLEAN_MAIN',
          current_manifest_id: null,
          last_validated_manifest_id: null,
          frontend_sha: SHA_B,
          backend_sha: SHA_B,
          frontend_staging_ref_sha: SHA_B,
          backend_staging_ref_sha: SHA_B,
          clean_main: true,
          last_transition_train_id: null,
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

    it('durably round-trips a production selection policy and exact candidate evidence', async () => {
      const candidate = await repository.createCandidate(
        {
          repository: 'frontend',
          prNumber: 1010,
          branchName: 'feature/evidence-round-trip',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: null,
          prEvidence: null
        },
        {}
      );
      const evidence = [
        {
          candidate_id: candidate.id,
          repository: candidate.repository,
          pr_number: candidate.pr_number,
          head_sha: candidate.head_sha,
          staging_train_id: 'staging-train-evidence',
          staging_manifest_id: 'staging-manifest-evidence',
          staging_manifest_identity_sha256: '1'.repeat(64),
          staging_e2e_operation_id: 'staging-e2e-operation',
          staging_e2e_run_id: 'staging-e2e-run'
        }
      ] as const;
      const train = await repository.createTrain(
        {
          lane: 'PRODUCTION',
          frontendBaseSha: SHA_B,
          backendBaseSha: SHA_C,
          candidateIds: [candidate.id],
          qualificationPolicy: 'CANDIDATE_STAGING_EVIDENCE_V1',
          qualificationEvidence: evidence
        },
        {}
      );

      expect(train.qualification_policy).toBe('CANDIDATE_STAGING_EVIDENCE_V1');
      expect(
        typeof train.qualification_evidence_json === 'string'
          ? JSON.parse(train.qualification_evidence_json)
          : train.qualification_evidence_json
      ).toEqual(evidence);
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

    it('supersedes a non-live staging candidate after a train claims it', async () => {
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
      ).resolves.toEqual([expect.objectContaining({ id: claimed.id })]);
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
          status: 'SUPERSEDED',
          current_train_id: train?.id,
          superseded_at: expect.anything()
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

    it('does not claim explicit production readiness without durable staging evidence', async () => {
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
      await expect(
        new ReleaseBusV2Service(repository).claimLane(
          'PRODUCTION',
          SHA_A,
          SHA_B,
          'production-claim'
        )
      ).rejects.toThrow('has no current staging validation evidence');
      expect(await repository.listTrains(10, {})).toEqual([]);
      expect(
        (await repository.findCandidateById(explicit.id, {}))?.status
      ).toBe('READY_FOR_PRODUCTION');
      expect(
        (await repository.findCandidateById(stagingOnly.id, {}))?.status
      ).toBe('READY_FOR_STAGING');
    });

    it('transactionally yields an already-claimed legacy impossible qualification', async () => {
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
      const parent = await repository.createTrain(
        {
          lane: 'PRODUCTION',
          frontendBaseSha: SHA_A,
          backendBaseSha: SHA_B,
          candidateIds: [frontend.id]
        },
        {}
      );
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
          currentTrainId: parent.id
        },
        {}
      );
      await repository.updateTrain(
        parent.id,
        parent.row_version,
        {
          status: 'PREPARED',
          frontendComposedSha: SHA_C,
          backendComposedSha: SHA_B,
          frontendArtifactDigest: DIGEST_A,
          backendArtifactDigest: null
        },
        {}
      );
      const preparedParent = await repository.findTrain(parent.id, {});
      expect(preparedParent).not.toBeNull();
      const qualification = await repository.createQualificationTrain(
        {
          parentTrainId: parent.id,
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
        parent.id,
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
      expect(await repository.findTrain(parent.id, {})).toEqual(
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
      expect(await repository.findTrain(parent.id, {})).toEqual(
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
        parentTrainId: parent.id,
        qualificationTrainId: qualification.id,
        candidateIds: [frontend.id]
      });
      expect(await repository.findTrain(parent.id, {})).toEqual(
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
      expect(await repository.listEvents(parent.id, 20, {})).toEqual(
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

    it('atomically marks every candidate in a multi-candidate admitted set live', async () => {
      const first = await repository.createCandidate(
        {
          repository: 'frontend',
          prNumber: 201,
          branchName: 'feature/live-first',
          headSha: SHA_A,
          requestedBy: 'integration',
          deployPlan: null,
          prEvidence: null
        },
        {}
      );
      const second = await repository.createCandidate(
        {
          repository: 'backend',
          prNumber: 202,
          branchName: 'feature/live-second',
          headSha: SHA_C,
          requestedBy: 'integration',
          deployPlan: { units: ['api'], edges: [] },
          prEvidence: null
        },
        {}
      );
      const manifest = await repository.createManifest(
        {
          train_id: 'multi-admission-train',
          lane: 'STAGING',
          identity_sha256: 'd'.repeat(64),
          status: 'STAGING_VALIDATED',
          frontend_sha: SHA_A,
          backend_sha: SHA_C,
          frontend_artifact_digest: null,
          backend_artifact_digest: null,
          e2e_run_id: 'multi-admission-e2e',
          manifest_json: {
            schema_version: 2,
            train_id: 'multi-admission-train'
          },
          deployed_at: 1,
          validated_at: 2
        },
        {}
      );

      await repository.executeNativeQueriesInTransaction(async (connection) => {
        const state = await repository.getStagingState({ connection }, true);
        await repository.commitValidatedStaging(
          {
            trainId: 'multi-admission-train',
            expectedStateVersion: state.row_version,
            manifestId: manifest.id,
            frontendSha: SHA_A,
            backendSha: SHA_C,
            frontendStagingRefSha: SHA_A,
            backendStagingRefSha: SHA_C,
            admittedCandidateIds: [first.id, second.id],
            removedCandidateIds: [],
            newCandidateIds: [first.id, second.id]
          },
          { connection }
        );
      });

      await expect(
        Promise.all([
          repository.findCandidateById(first.id, {}),
          repository.findCandidateById(second.id, {})
        ])
      ).resolves.toEqual([
        expect.objectContaining({
          staging_live_state: 'LIVE',
          staging_live_manifest_id: manifest.id
        }),
        expect.objectContaining({
          staging_live_state: 'LIVE',
          staging_live_manifest_id: manifest.id
        })
      ]);
    });

    it('round-trips the full candidate-evidence qualification manifest status', async () => {
      const manifest = await repository.createManifest(
        {
          train_id: 'candidate-evidence-train',
          lane: 'PRODUCTION',
          identity_sha256: 'e'.repeat(64),
          status: 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED',
          frontend_sha: SHA_A,
          backend_sha: SHA_C,
          frontend_artifact_digest: null,
          backend_artifact_digest: null,
          e2e_run_id: null,
          manifest_json: {
            schema_version: 2,
            scope: 'production-candidate-evidence-qualification',
            qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1'
          },
          deployed_at: null,
          validated_at: null
        },
        {}
      );

      await expect(repository.findManifest(manifest.id, {})).resolves.toEqual(
        expect.objectContaining({
          status: 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED'
        })
      );

      await dbSupplier().execute(
        `update ${RELEASE_BUS_V2_MANIFESTS_TABLE}
         set status = 'PRODUCTION_CANDIDATE_EVIDENCE_QU'
         where id = :id`,
        { id: manifest.id }
      );
      const migration = require(
        path.resolve(
          process.cwd(),
          'migrations/20260727203000-widen-release-bus-v2-manifest-status.js'
        )
      ) as {
        up: (db: {
          runSql: (sql: string) => Promise<unknown>;
        }) => Promise<void>;
      };
      await migration.up({
        runSql: async (sql: string) => dbSupplier().execute(sql)
      });

      await expect(repository.findManifest(manifest.id, {})).resolves.toEqual(
        expect.objectContaining({
          status: 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED'
        })
      );
    });

    it('deterministically restores blank manifest lifecycle statuses', async () => {
      const inputs = [
        {
          train_id: 'repair-candidate-evidence',
          lane: 'PRODUCTION' as const,
          identity_sha256: '1'.repeat(64),
          status: 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED' as const,
          validated_at: null,
          manifest_json: {
            schema_version: 2,
            scope: 'production-candidate-evidence-qualification',
            qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1'
          }
        },
        {
          train_id: 'repair-production',
          lane: 'PRODUCTION' as const,
          identity_sha256: '2'.repeat(64),
          status: 'PRODUCTION_DEPLOYED' as const,
          validated_at: null,
          manifest_json: { schema_version: 2, scope: 'production' }
        },
        {
          train_id: 'repair-staging-validated',
          lane: 'STAGING' as const,
          identity_sha256: '3'.repeat(64),
          status: 'STAGING_VALIDATED' as const,
          validated_at: 2,
          manifest_json: { schema_version: 2, scope: 'staging' }
        },
        {
          train_id: 'repair-staging-deployed',
          lane: 'PRODUCTION_QUALIFICATION' as const,
          identity_sha256: '4'.repeat(64),
          status: 'STAGING_DEPLOYED' as const,
          validated_at: null,
          manifest_json: { schema_version: 2, scope: 'staging' }
        },
        {
          train_id: 'repair-staging-failed',
          lane: 'STAGING' as const,
          identity_sha256: '5'.repeat(64),
          status: 'FAILED' as const,
          validated_at: null,
          manifest_json: { schema_version: 2, scope: 'staging' }
        }
      ];
      const manifests = [];
      for (const input of inputs) {
        manifests.push(
          await repository.createManifest(
            {
              ...input,
              frontend_sha: SHA_A,
              backend_sha: SHA_C,
              frontend_artifact_digest: null,
              backend_artifact_digest: null,
              e2e_run_id: null,
              deployed_at: 1
            },
            {}
          )
        );
      }
      await repository.appendEvent(
        {
          trainId: 'repair-staging-deployed',
          eventType: 'TRAIN_STAGING_DEPLOYED'
        },
        {}
      );
      await repository.appendEvent(
        {
          trainId: 'repair-staging-validated',
          eventType: 'TRAIN_STAGING_DEPLOYED'
        },
        {}
      );
      await repository.appendEvent(
        {
          trainId: 'repair-staging-failed',
          eventType: 'STAGING_FINAL_FENCE_VIOLATED'
        },
        {}
      );
      for (const manifest of manifests) {
        await dbSupplier().execute(
          `update ${RELEASE_BUS_V2_MANIFESTS_TABLE}
           set status = '' where id = :id`,
          { id: manifest.id }
        );
      }
      const migration = require(
        path.resolve(
          process.cwd(),
          'migrations/20260727211500-repair-release-bus-v2-manifest-status-ledger.js'
        )
      ) as {
        up: (db: {
          runSql: (sql: string) => Promise<unknown>;
          all: (
            sql: string,
            callback: (error: Error | null, rows?: unknown[]) => void
          ) => void;
        }) => Promise<void>;
      };
      await migration.up({
        runSql: async (sql: string) => dbSupplier().execute(sql),
        all: (sql, callback) => {
          dbSupplier()
            .execute(sql)
            .then(
              (rows) => callback(null, rows),
              (error) =>
                callback(
                  error instanceof Error ? error : new Error(String(error))
                )
            );
        }
      });

      await expect(
        Promise.all(
          manifests.map(async ({ id }) => {
            const manifest = await repository.findManifest(id, {});
            return manifest?.status;
          })
        )
      ).resolves.toEqual([
        'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED',
        'PRODUCTION_DEPLOYED',
        'STAGING_VALIDATED',
        'STAGING_DEPLOYED',
        'FAILED'
      ]);
    });

    it('rejects contradictory validated and failed manifest evidence', async () => {
      const manifest = await repository.createManifest(
        {
          train_id: 'repair-contradictory-staging',
          lane: 'STAGING',
          identity_sha256: '6'.repeat(64),
          status: 'STAGING_VALIDATED',
          frontend_sha: SHA_A,
          backend_sha: SHA_C,
          frontend_artifact_digest: null,
          backend_artifact_digest: null,
          e2e_run_id: 'contradictory-e2e',
          manifest_json: { schema_version: 2, scope: 'staging' },
          deployed_at: 1,
          validated_at: 2
        },
        {}
      );
      await repository.appendEvent(
        {
          trainId: manifest.train_id,
          eventType: 'TRAIN_STAGING_DEPLOYED'
        },
        {}
      );
      await repository.appendEvent(
        {
          trainId: manifest.train_id,
          eventType: 'STAGING_FINAL_FENCE_VIOLATED'
        },
        {}
      );
      await dbSupplier().execute(
        `update ${RELEASE_BUS_V2_MANIFESTS_TABLE}
         set status = '' where id = :id`,
        { id: manifest.id }
      );
      const migration = require(
        path.resolve(
          process.cwd(),
          'migrations/20260727211500-repair-release-bus-v2-manifest-status-ledger.js'
        )
      ) as {
        up: (db: {
          runSql: (sql: string) => Promise<unknown>;
          all: (
            sql: string,
            callback: (error: Error | null, rows?: unknown[]) => void
          ) => void;
        }) => Promise<void>;
      };

      await expect(
        migration.up({
          runSql: async (sql: string) => dbSupplier().execute(sql),
          all: (sql, callback) => {
            dbSupplier()
              .execute(sql)
              .then(
                (rows) => callback(null, rows),
                (error) =>
                  callback(
                    error instanceof Error ? error : new Error(String(error))
                  )
              );
          }
        })
      ).rejects.toThrow(
        'Release Bus v2 manifest status repair found 1 unclassified row(s) before mutation'
      );
      await expect(repository.findManifest(manifest.id, {})).resolves.toEqual(
        expect.objectContaining({ status: '' })
      );
    });

    it('atomically removes every candidate in a multi-candidate transition set', async () => {
      const candidates = await Promise.all([
        repository.createCandidate(
          {
            repository: 'frontend',
            prNumber: 203,
            branchName: 'feature/remove-first',
            headSha: SHA_A,
            requestedBy: 'integration',
            deployPlan: null,
            prEvidence: null
          },
          {}
        ),
        repository.createCandidate(
          {
            repository: 'backend',
            prNumber: 204,
            branchName: 'feature/remove-second',
            headSha: SHA_C,
            requestedBy: 'integration',
            deployPlan: { units: ['api'], edges: [] },
            prEvidence: null
          },
          {}
        )
      ]);
      const admittedManifest = await repository.createManifest(
        {
          train_id: 'multi-removal-admit',
          lane: 'STAGING',
          identity_sha256: '1'.repeat(64),
          status: 'STAGING_VALIDATED',
          frontend_sha: SHA_A,
          backend_sha: SHA_C,
          frontend_artifact_digest: null,
          backend_artifact_digest: null,
          e2e_run_id: 'multi-removal-admit-e2e',
          manifest_json: {
            schema_version: 2,
            train_id: 'multi-removal-admit'
          },
          deployed_at: 1,
          validated_at: 2
        },
        {}
      );
      await repository.executeNativeQueriesInTransaction(async (connection) => {
        const state = await repository.getStagingState({ connection }, true);
        await repository.commitValidatedStaging(
          {
            trainId: 'multi-removal-admit',
            expectedStateVersion: state.row_version,
            manifestId: admittedManifest.id,
            frontendSha: SHA_A,
            backendSha: SHA_C,
            frontendStagingRefSha: SHA_A,
            backendStagingRefSha: SHA_C,
            admittedCandidateIds: candidates.map(({ id }) => id),
            removedCandidateIds: [],
            newCandidateIds: candidates.map(({ id }) => id)
          },
          { connection }
        );
      });
      for (const candidate of candidates) {
        const live = await repository.findCandidateById(candidate.id, {});
        expect(live).not.toBeNull();
        await repository.updateCandidate(
          live!.id,
          live!.row_version,
          {
            status: live!.status,
            stagingTransitionRequest: 'REMOVE',
            stagingTransitionRequestedAt: 3,
            stagingTransitionRequestedBy: 'integration',
            stagingTransitionReason: 'multi removal',
            holdReason: 'pending removal'
          },
          {}
        );
      }
      const removedManifest = await repository.createManifest(
        {
          train_id: 'multi-removal-complete',
          lane: 'STAGING',
          identity_sha256: '2'.repeat(64),
          status: 'STAGING_VALIDATED',
          frontend_sha: SHA_B,
          backend_sha: SHA_B,
          frontend_artifact_digest: null,
          backend_artifact_digest: null,
          e2e_run_id: 'multi-removal-complete-e2e',
          manifest_json: {
            schema_version: 2,
            train_id: 'multi-removal-complete'
          },
          deployed_at: 3,
          validated_at: 4
        },
        {}
      );
      await repository.executeNativeQueriesInTransaction(async (connection) => {
        const state = await repository.getStagingState({ connection }, true);
        await repository.commitValidatedStaging(
          {
            trainId: 'multi-removal-complete',
            expectedStateVersion: state.row_version,
            manifestId: removedManifest.id,
            frontendSha: SHA_B,
            backendSha: SHA_B,
            frontendStagingRefSha: SHA_B,
            backendStagingRefSha: SHA_B,
            admittedCandidateIds: [],
            removedCandidateIds: candidates.map(({ id }) => id),
            newCandidateIds: []
          },
          { connection }
        );
      });

      for (const candidate of candidates)
        await expect(
          repository.findCandidateById(candidate.id, {})
        ).resolves.toEqual(
          expect.objectContaining({
            staging_live_state: 'NOT_LIVE',
            staging_live_manifest_id: null,
            staging_transition_request: null,
            staging_transition_reason: null,
            hold_reason: null
          })
        );
    });

    it('rejects ambiguous bootstrap evidence for the same exact staging refs', async () => {
      for (const [suffix, validatedAt] of [
        ['a', 2],
        ['b', 3]
      ] as const)
        await repository.createManifest(
          {
            train_id: `ambiguous-train-${suffix}`,
            lane: 'STAGING',
            identity_sha256: suffix.repeat(64),
            status: 'STAGING_VALIDATED',
            frontend_sha: SHA_A,
            backend_sha: SHA_B,
            frontend_artifact_digest: null,
            backend_artifact_digest: null,
            e2e_run_id: `ambiguous-e2e-${suffix}`,
            manifest_json: {
              schema_version: 2,
              train_id: `ambiguous-train-${suffix}`
            },
            deployed_at: 1,
            validated_at: validatedAt
          },
          {}
        );

      await expect(
        repository.findStagingValidatedManifestByShas(SHA_A, SHA_B, {})
      ).resolves.toBeNull();
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
