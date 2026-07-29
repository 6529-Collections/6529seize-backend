import { DbPoolName, type DbQueryOptions } from '@/db-query.options';
import {
  releaseBusV2CandidateHasActiveIntent,
  releaseBusV2CandidateInventoryDigest,
  ReleaseBusV2Repository,
  type ReleaseBusV2ControlRecord,
  type ReleaseBusV2LockRecord,
  type ReleaseBusV2MaintenanceLease
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2StagingStateRecord
} from '@/releaseBusV2/release-bus-v2.types';
import { type ConnectionWrapper, SqlExecutor } from '@/sql-executor';

class RecordingSqlExecutor extends SqlExecutor {
  public readonly calls: {
    readonly sql: string;
    readonly params?: Record<string, unknown>;
    readonly options?: DbQueryOptions;
  }[] = [];

  public async execute<T>(
    sql: string,
    params?: Record<string, unknown>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    this.calls.push({ sql, params, options });
    if (sql.trimStart().startsWith('update'))
      return { affectedRows: 1 } as unknown as T[];
    return [
      {
        name: 'scheduler',
        lease_token: 'writer-visible-token'
      }
    ] as T[];
  }

  public async executeNativeQueriesInTransaction<T>(
    _executable: (connection: ConnectionWrapper<unknown>) => Promise<T>
  ): Promise<T> {
    throw new Error('Not used by this test');
  }
}

function candidate(
  id: string,
  overrides: Partial<ReleaseBusV2CandidateRecord> = {}
): ReleaseBusV2CandidateRecord {
  return {
    id,
    repository: 'frontend',
    pr_number: 1,
    branch_name: `feature/${id}`,
    head_sha: 'a'.repeat(40),
    requested_by: 'operator',
    status: 'STAGING_VALIDATED',
    deploy_plan_json: null,
    pr_evidence_json: null,
    current_train_id: null,
    staging_validated_train_id: 'historical-train',
    staging_validated_manifest_id: 'historical-manifest',
    staging_live_state: 'LIVE',
    staging_live_manifest_id: 'historical-manifest',
    staging_admitted_at: 1,
    staging_live_updated_at: 1,
    production_requested_at: 2,
    production_requested_by: 'operator',
    production_selection_id: 'selection',
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 2,
    row_version: 7,
    ...overrides
  };
}

function controlRows(): ReleaseBusV2ControlRecord[] {
  return [
    {
      scope: 'ALL',
      paused: false,
      reason: null,
      github_actor: null,
      updated_at: 1,
      row_version: 1
    },
    {
      scope: 'PRODUCTION',
      paused: true,
      reason: 'maintenance',
      github_actor: 'operator',
      updated_at: 1,
      row_version: 2
    },
    {
      scope: 'STAGING',
      paused: true,
      reason: 'maintenance',
      github_actor: 'operator',
      updated_at: 1,
      row_version: 3
    }
  ];
}

function acquiredLocks(now = Date.now()): {
  readonly locks: ReleaseBusV2LockRecord[];
  readonly leases: ReleaseBusV2MaintenanceLease[];
} {
  const locks = [
    'production-environment',
    'scheduler',
    'staging-environment'
  ].map((name, index) => ({
    name,
    owner_train_id: null,
    lease_owner: 'maintenance-owner',
    lease_token: `token-${name}`,
    heartbeat_at: now,
    expires_at: now + 60_000,
    updated_at: now,
    row_version: index + 10
  }));
  return {
    locks,
    leases: locks.map((lock) => ({
      name: lock.name,
      lease_owner: lock.lease_owner,
      lease_token: lock.lease_token,
      expires_at: lock.expires_at,
      row_version: lock.row_version
    }))
  };
}

function state(): ReleaseBusV2StagingStateRecord {
  return {
    id: 'current',
    status: 'LIVE',
    current_manifest_id: 'historical-manifest',
    last_validated_manifest_id: 'historical-manifest',
    frontend_sha: 'a'.repeat(40),
    backend_sha: 'b'.repeat(40),
    frontend_staging_ref_sha: 'a'.repeat(40),
    backend_staging_ref_sha: 'b'.repeat(40),
    clean_main: false,
    last_transition_train_id: 'historical-train',
    updated_at: 1,
    row_version: 4
  };
}

describe('ReleaseBusV2Repository', () => {
  it('reads an acquired lock back from the write pool', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);

    await expect(
      repository.acquireLock('scheduler', null, 'selection', 300_000, {})
    ).resolves.toEqual(
      expect.objectContaining({ lease_token: 'writer-visible-token' })
    );

    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]?.options).toEqual({ forcePool: DbPoolName.WRITE });
  });

  it('drains nonterminal operations by exact lane even under terminal trains', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);

    await repository.listNonterminalOperationsForLanes(
      ['STAGING', 'PRODUCTION_QUALIFICATION'],
      {}
    );

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toContain(
      "operations.status not in ('SUCCEEDED', 'FAILED', 'CANCELLED')"
    );
    expect(db.calls[0]?.sql).toContain(
      'inner join release_bus_v2_trains trains'
    );
    expect(db.calls[0]?.sql).toContain('trains.lane in (:lanes)');
    expect(db.calls[0]?.params).toEqual({
      lanes: ['STAGING', 'PRODUCTION_QUALIFICATION']
    });
  });

  it('digests the complete mutable candidate inventory deterministically', () => {
    const first = candidate('candidate-a');
    const second = candidate('candidate-b', {
      repository: 'backend',
      head_sha: 'b'.repeat(40)
    });

    expect(releaseBusV2CandidateInventoryDigest([first, second])).toBe(
      releaseBusV2CandidateInventoryDigest([second, first])
    );
    expect(
      releaseBusV2CandidateInventoryDigest([
        first,
        { ...second, production_requested_at: 99, row_version: 8 }
      ])
    ).not.toBe(releaseBusV2CandidateInventoryDigest([first, second]));
  });

  it('binds explicit null PR evidence as SQL NULL rather than serialized JSON', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);

    await expect(
      repository.updateCandidate(
        'candidate-a',
        7,
        { status: 'READY_FOR_STAGING', prEvidence: null },
        {}
      )
    ).resolves.toBe(true);

    expect(db.calls[0]?.params).toEqual(
      expect.objectContaining({
        setPrEvidence: 1,
        prEvidence: null
      })
    );
  });

  it('does not steal an expired but non-null lock during exact-free maintenance acquisition', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);
    jest
      .spyOn(repository, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (callback) =>
        callback({ connection: {} } as never)
      );
    jest.spyOn(repository, 'listLocks').mockResolvedValue([
      {
        name: 'production-environment',
        owner_train_id: null,
        lease_owner: null,
        lease_token: null,
        heartbeat_at: null,
        expires_at: null,
        updated_at: 1,
        row_version: 1
      },
      {
        name: 'scheduler',
        owner_train_id: null,
        lease_owner: 'expired-owner',
        lease_token: 'expired-token',
        heartbeat_at: 1,
        expires_at: 2,
        updated_at: 2,
        row_version: 2
      },
      {
        name: 'staging-environment',
        owner_train_id: null,
        lease_owner: null,
        lease_token: null,
        heartbeat_at: null,
        expires_at: null,
        updated_at: 1,
        row_version: 3
      }
    ]);
    const acquire = jest.spyOn(repository, 'acquireLock');

    await expect(
      repository.acquireExactFreeMaintenanceLocks(
        [
          { name: 'production-environment', row_version: 1 },
          { name: 'scheduler', row_version: 2 },
          { name: 'staging-environment', row_version: 3 }
        ],
        'maintenance-owner',
        60_000
      )
    ).rejects.toThrow('wholly free');
    expect(acquire).not.toHaveBeenCalled();
  });

  it('classifies only semantically recoverable superseded production intent as active', () => {
    const recoverable = candidate('recoverable', {
      status: 'SUPERSEDED',
      current_train_id: null,
      superseded_at: 3
    });
    const deletedHeadEvent = {
      event_type: 'CANDIDATE_SUPERSEDED_BY_BRANCH_MOVE',
      payload_json: { current_head_sha: 'deleted' }
    };

    expect(
      releaseBusV2CandidateHasActiveIntent(recoverable, deletedHeadEvent)
    ).toBe(true);
    expect(releaseBusV2CandidateHasActiveIntent(recoverable)).toBe(false);
    expect(
      releaseBusV2CandidateHasActiveIntent(
        {
          ...recoverable,
          current_train_id: 'active-train'
        },
        deletedHeadEvent
      )
    ).toBe(false);
    expect(
      releaseBusV2CandidateHasActiveIntent(
        {
          ...recoverable,
          production_requested_at: null
        },
        deletedHeadEvent
      )
    ).toBe(false);
    expect(
      releaseBusV2CandidateHasActiveIntent(
        {
          ...recoverable,
          staging_validated_manifest_id: null
        },
        deletedHeadEvent
      )
    ).toBe(false);
    expect(
      releaseBusV2CandidateHasActiveIntent(recoverable, {
        ...deletedHeadEvent,
        payload_json: { current_head_sha: 'moved-head' }
      })
    ).toBe(false);
  });

  it('atomically detaches only active intent while preserving terminal rows byte-for-byte', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);
    const candidates = [
      candidate('candidate-a', {
        current_train_id: 'active-train',
        staging_live_updated_at: 11,
        staging_transition_request: 'REMOVE',
        staging_transition_requested_at: 12,
        staging_transition_requested_by: 'transition-operator',
        staging_transition_reason: 'Replace the exact staging set',
        production_requested_by: 'production-operator',
        hold_reason: 'Dependency evidence pending'
      }),
      candidate('candidate-b'),
      candidate('recoverable-superseded-production', {
        status: 'SUPERSEDED',
        current_train_id: null,
        superseded_at: 3
      })
    ];
    const terminalHistory = [
      candidate('history-production', {
        status: 'PRODUCTION_DEPLOYED',
        row_version: 21
      }),
      candidate('history-superseded', {
        status: 'SUPERSEDED',
        superseded_at: 4,
        row_version: 22
      }),
      candidate('history-cancelled', {
        status: 'CANCELLED',
        row_version: 23
      }),
      candidate('history-deregistered', {
        status: 'DEREGISTERED',
        row_version: 24
      })
    ];
    const controls = controlRows();
    const stagingState = state();
    const { locks, leases } = acquiredLocks();
    jest
      .spyOn(repository, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (callback) =>
        callback({ connection: {} } as never)
      );
    jest.spyOn(repository, 'listControls').mockResolvedValue(controls);
    jest.spyOn(repository, 'listLocks').mockResolvedValue(locks);
    jest.spyOn(repository, 'listActiveTrains').mockResolvedValue([]);
    jest
      .spyOn(repository, 'listNonterminalOperationsForLanes')
      .mockResolvedValue([]);
    jest.spyOn(repository, 'getStagingState').mockResolvedValue(stagingState);
    const listAllCandidates = jest
      .spyOn(repository, 'listAllCandidates')
      .mockResolvedValue([...candidates, ...terminalHistory]);
    jest
      .spyOn(repository, 'listCandidateEvents')
      .mockImplementation(async (candidateId) => {
        if (
          !['recoverable-superseded-production', 'history-superseded'].includes(
            candidateId
          )
        )
          return [];
        return [
          {
            id: `superseded-event-${candidateId}`,
            train_id: null,
            candidate_id: candidateId,
            event_type: 'CANDIDATE_SUPERSEDED_BY_BRANCH_MOVE',
            github_actor: 'release-bus-v2',
            payload_json: {
              current_head_sha:
                candidateId === 'recoverable-superseded-production'
                  ? 'deleted'
                  : 'moved-head'
            },
            created_at: 3
          }
        ];
      });
    const updateCandidate = jest
      .spyOn(repository, 'updateCandidate')
      .mockResolvedValue(true);
    const updateStagingState = jest
      .spyOn(repository, 'updateStagingState')
      .mockResolvedValue(true);
    const appendEvent = jest
      .spyOn(repository, 'appendEvent')
      .mockResolvedValue(undefined);

    await expect(
      repository.commitAllCandidateDeregistration({
        deregistrationId: 'deregistration-id',
        actor: 'operator',
        reason: 'Audited candidate retirement',
        expectedControls: controls.map(({ scope, paused, row_version }) => ({
          scope,
          paused: Boolean(paused),
          row_version
        })),
        maintenanceLeases: leases,
        expectedStagingStateRowVersion: stagingState.row_version,
        expectedCandidates: candidates.map(({ id, row_version }) => ({
          id,
          row_version
        })),
        expectedInventorySha256:
          releaseBusV2CandidateInventoryDigest(candidates),
        observedFrontendStagingSha: 'a'.repeat(40),
        observedBackendStagingSha: 'b'.repeat(40)
      })
    ).resolves.toEqual({ candidateCount: 3 });

    expect(updateCandidate).toHaveBeenCalledTimes(3);
    expect(listAllCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ connection: expect.anything() }),
      true
    );
    expect(updateCandidate).toHaveBeenCalledWith(
      'candidate-a',
      7,
      expect.objectContaining({
        status: 'DEREGISTERED',
        currentTrainId: null,
        stagingLiveState: 'DETACHED',
        stagingLiveManifestId: null,
        productionRequestedAt: null,
        productionSelectionId: null,
        supersededAt: null
      }),
      expect.objectContaining({ connection: expect.anything() })
    );
    const candidateFields = updateCandidate.mock.calls[0]?.[2];
    expect(candidateFields).not.toHaveProperty('stagingValidatedTrainId');
    expect(candidateFields).not.toHaveProperty('stagingValidatedManifestId');
    expect(
      updateCandidate.mock.calls.map(([candidateId]) => candidateId)
    ).toEqual([
      'candidate-a',
      'candidate-b',
      'recoverable-superseded-production'
    ]);
    expect(
      updateCandidate.mock.calls.map(([candidateId]) => candidateId)
    ).not.toEqual(expect.arrayContaining(terminalHistory.map(({ id }) => id)));
    expect(updateStagingState).toHaveBeenCalledWith(
      4,
      expect.objectContaining({
        status: 'DETACHED_MANUAL_OWNERSHIP',
        currentManifestId: null,
        lastValidatedManifestId: 'historical-manifest',
        frontendSha: null,
        backendSha: null,
        cleanMain: false
      }),
      expect.objectContaining({ connection: expect.anything() })
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: 'candidate-a',
        eventType: 'CANDIDATE_LOGICALLY_DEREGISTERED',
        payload: expect.objectContaining({
          previous_current_train_id: 'active-train',
          previous_staging_live_manifest_id: 'historical-manifest',
          previous_staging_admitted_at: 1,
          previous_staging_live_updated_at: 11,
          previous_staging_transition_request: 'REMOVE',
          previous_staging_transition_requested_at: 12,
          previous_staging_transition_requested_by: 'transition-operator',
          previous_staging_transition_reason: 'Replace the exact staging set',
          previous_production_requested_at: 2,
          previous_production_requested_by: 'production-operator',
          previous_production_selection_id: 'selection',
          previous_hold_reason: 'Dependency evidence pending'
        })
      }),
      expect.anything()
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: 'recoverable-superseded-production',
        eventType: 'CANDIDATE_LOGICALLY_DEREGISTERED',
        payload: expect.objectContaining({
          previous_status: 'SUPERSEDED',
          previous_superseded_at: 3
        })
      }),
      expect.anything()
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'CANDIDATE_INVENTORY_LOGICALLY_DEREGISTERED',
        payload: expect.objectContaining({
          physical_staging_presence: 'UNKNOWN_DETACHED',
          immutable_history_preserved: true
        })
      }),
      expect.anything()
    );
  });

  it('aborts the transaction before any candidate mutation when the inventory CAS is stale', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);
    const current = candidate('candidate-a', { row_version: 8 });
    const controls = controlRows();
    const stagingState = state();
    const { locks, leases } = acquiredLocks();
    jest
      .spyOn(repository, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (callback) =>
        callback({ connection: {} } as never)
      );
    jest.spyOn(repository, 'listControls').mockResolvedValue(controls);
    jest.spyOn(repository, 'listLocks').mockResolvedValue(locks);
    jest.spyOn(repository, 'listActiveTrains').mockResolvedValue([]);
    jest
      .spyOn(repository, 'listNonterminalOperationsForLanes')
      .mockResolvedValue([]);
    jest.spyOn(repository, 'getStagingState').mockResolvedValue(stagingState);
    jest.spyOn(repository, 'listAllCandidates').mockResolvedValue([current]);
    const updateCandidate = jest.spyOn(repository, 'updateCandidate');
    const updateStagingState = jest.spyOn(repository, 'updateStagingState');
    const appendEvent = jest.spyOn(repository, 'appendEvent');

    await expect(
      repository.commitAllCandidateDeregistration({
        deregistrationId: 'deregistration-id',
        actor: 'operator',
        reason: 'Audited candidate retirement',
        expectedControls: controls.map(({ scope, paused, row_version }) => ({
          scope,
          paused: Boolean(paused),
          row_version
        })),
        maintenanceLeases: leases,
        expectedStagingStateRowVersion: stagingState.row_version,
        expectedCandidates: [{ id: current.id, row_version: 7 }],
        expectedInventorySha256: releaseBusV2CandidateInventoryDigest([
          { ...current, row_version: 7 }
        ]),
        observedFrontendStagingSha: 'a'.repeat(40),
        observedBackendStagingSha: 'b'.repeat(40)
      })
    ).rejects.toThrow('Exact candidate inventory changed');
    expect(updateCandidate).not.toHaveBeenCalled();
    expect(updateStagingState).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('aborts under the full-table lock when a new active target appeared after preparation', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);
    const prepared = candidate('candidate-a');
    const newlyAdmitted = candidate('candidate-new', {
      status: 'READY_FOR_STAGING',
      row_version: 1
    });
    const controls = controlRows();
    const stagingState = state();
    const { locks, leases } = acquiredLocks();
    jest
      .spyOn(repository, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (callback) =>
        callback({ connection: {} } as never)
      );
    jest.spyOn(repository, 'listControls').mockResolvedValue(controls);
    jest.spyOn(repository, 'listLocks').mockResolvedValue(locks);
    jest.spyOn(repository, 'listActiveTrains').mockResolvedValue([]);
    jest
      .spyOn(repository, 'listNonterminalOperationsForLanes')
      .mockResolvedValue([]);
    jest.spyOn(repository, 'getStagingState').mockResolvedValue(stagingState);
    const listAllCandidates = jest
      .spyOn(repository, 'listAllCandidates')
      .mockResolvedValue([prepared, newlyAdmitted]);
    const updateCandidate = jest.spyOn(repository, 'updateCandidate');
    const updateStagingState = jest.spyOn(repository, 'updateStagingState');

    await expect(
      repository.commitAllCandidateDeregistration({
        deregistrationId: 'deregistration-id',
        actor: 'operator',
        reason: 'Audited candidate retirement',
        expectedControls: controls.map(({ scope, paused, row_version }) => ({
          scope,
          paused: Boolean(paused),
          row_version
        })),
        maintenanceLeases: leases,
        expectedStagingStateRowVersion: stagingState.row_version,
        expectedCandidates: [
          { id: prepared.id, row_version: prepared.row_version }
        ],
        expectedInventorySha256: releaseBusV2CandidateInventoryDigest([
          prepared
        ]),
        observedFrontendStagingSha: 'a'.repeat(40),
        observedBackendStagingSha: 'b'.repeat(40)
      })
    ).rejects.toThrow('Exact candidate inventory changed');

    expect(listAllCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ connection: expect.anything() }),
      true
    );
    expect(updateCandidate).not.toHaveBeenCalled();
    expect(updateStagingState).not.toHaveBeenCalled();
  });

  it('proves clean main without restoring detached historical manifest membership', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);
    const detached = candidate('candidate-a', {
      status: 'DEREGISTERED',
      staging_live_state: 'DETACHED'
    });
    const terminalLiveHistory = candidate('history-production', {
      status: 'PRODUCTION_DEPLOYED',
      staging_live_state: 'LIVE',
      staging_live_manifest_id: 'historical-manifest',
      row_version: 41
    });
    const detachedState = state();
    Object.assign(detachedState, {
      status: 'DETACHED_MANUAL_OWNERSHIP',
      current_manifest_id: null,
      frontend_sha: null,
      backend_sha: null,
      frontend_staging_ref_sha: null,
      backend_staging_ref_sha: null,
      clean_main: false
    });
    jest
      .spyOn(repository, 'listLiveStagingCandidates')
      .mockResolvedValue([terminalLiveHistory]);
    jest
      .spyOn(repository, 'listDetachedStagingCandidates')
      .mockResolvedValue([detached]);
    jest.spyOn(repository, 'getStagingState').mockResolvedValue(detachedState);
    const updateCandidate = jest
      .spyOn(repository, 'updateCandidate')
      .mockResolvedValue(true);
    const updateStagingState = jest
      .spyOn(repository, 'updateStagingState')
      .mockResolvedValue(true);
    const appendEvent = jest
      .spyOn(repository, 'appendEvent')
      .mockResolvedValue(undefined);

    await repository.commitDetachedStagingCleanMain(
      {
        expectedStateVersion: detachedState.row_version,
        frontendSha: 'f'.repeat(40),
        backendSha: 'b'.repeat(40)
      },
      {}
    );

    expect(updateCandidate).toHaveBeenCalledWith(
      detached.id,
      detached.row_version,
      expect.objectContaining({
        status: 'DEREGISTERED',
        stagingLiveState: 'NOT_LIVE',
        stagingLiveManifestId: null
      }),
      {}
    );
    expect(updateCandidate).toHaveBeenCalledTimes(1);
    expect(updateCandidate).not.toHaveBeenCalledWith(
      terminalLiveHistory.id,
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(updateStagingState).toHaveBeenCalledWith(
      detachedState.row_version,
      expect.objectContaining({
        status: 'CLEAN_MAIN',
        currentManifestId: null,
        lastValidatedManifestId: 'historical-manifest',
        cleanMain: true
      }),
      {}
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'DETACHED_STAGING_BOOTSTRAPPED_FROM_EXACT_CLEAN_MAIN',
        payload: expect.objectContaining({
          restored_historical_manifest_id: 'historical-manifest',
          historical_manifest_membership_restored: false,
          physical_staging_presence: 'PROVEN_CLEAN_MAIN'
        })
      }),
      {}
    );
  });
});
