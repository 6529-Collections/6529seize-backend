'use strict';

var CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS release_bus_v2_candidates (
    id varchar(36) NOT NULL, repository varchar(16) NOT NULL, pr_number int NOT NULL,
    branch_name varchar(255) NOT NULL, head_sha char(40) NOT NULL, requested_by varchar(100) NOT NULL,
    status varchar(48) NOT NULL, deploy_plan_json json NULL, pr_evidence_json json NULL,
    current_train_id varchar(36) NULL, staging_validated_train_id varchar(36) NULL,
    staging_validated_manifest_id varchar(36) NULL, production_requested_at bigint NULL,
    production_requested_by varchar(100) NULL, hold_reason varchar(1000) NULL,
    superseded_at bigint NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL,
    row_version int NOT NULL DEFAULT 1, PRIMARY KEY (id),
    UNIQUE KEY uq_release_bus_v2_candidate_identity (repository, pr_number, head_sha),
    KEY idx_release_bus_v2_candidate_queue (status, production_requested_at, created_at),
    KEY idx_release_bus_v2_candidate_pr (repository, pr_number, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_bus_v2_candidate_dependencies (
    id varchar(36) NOT NULL, candidate_id varchar(36) NOT NULL,
    prerequisite_candidate_id varchar(36) NOT NULL, environment varchar(16) NOT NULL,
    created_at bigint NOT NULL, PRIMARY KEY (id),
    UNIQUE KEY uq_release_bus_v2_dependency (candidate_id, prerequisite_candidate_id, environment),
    KEY idx_release_bus_v2_dependency_target (prerequisite_candidate_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_bus_v2_trains (
    id varchar(36) NOT NULL, lane varchar(32) NOT NULL, status varchar(48) NOT NULL,
    frontend_base_sha char(40) NULL, backend_base_sha char(40) NULL,
    frontend_composed_sha char(40) NULL, backend_composed_sha char(40) NULL,
    frontend_artifact_digest char(64) NULL, backend_artifact_digest char(64) NULL,
    manifest_id varchar(36) NULL, parent_train_id varchar(36) NULL,
    qualification_identity_sha256 char(64) NULL,
    qualification_train_id varchar(36) NULL, failure_class varchar(32) NULL,
    failure_message varchar(2000) NULL, recovery_message varchar(2000) NULL,
    phase_started_at bigint NOT NULL, completed_at bigint NULL, created_at bigint NOT NULL,
    updated_at bigint NOT NULL, row_version int NOT NULL DEFAULT 1, PRIMARY KEY (id),
    KEY idx_release_bus_v2_train_lane_status (lane, status, created_at),
    UNIQUE KEY uq_release_bus_v2_train_parent (parent_train_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_bus_v2_train_candidates (
    id varchar(36) NOT NULL, train_id varchar(36) NOT NULL, candidate_id varchar(36) NOT NULL,
    sequence int NOT NULL, disposition varchar(32) NOT NULL DEFAULT 'INCLUDED', created_at bigint NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY uq_release_bus_v2_train_candidate (train_id, candidate_id),
    KEY idx_release_bus_v2_train_candidate_candidate (candidate_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_bus_v2_operations (
    id varchar(36) NOT NULL, idempotency_key varchar(220) NOT NULL, train_id varchar(36) NOT NULL,
    operation_type varchar(64) NOT NULL, repository varchar(16) NULL, service varchar(100) NULL,
    environment varchar(16) NULL, expected_sha char(40) NULL, artifact_digest char(64) NULL,
    external_id varchar(500) NULL, status varchar(32) NOT NULL, attempt int NOT NULL DEFAULT 1,
    max_attempts int NOT NULL DEFAULT 3, next_retry_at bigint NULL, failure_class varchar(32) NULL,
    failure_message varchar(2000) NULL, request_json json NULL, result_json json NULL,
    started_at bigint NULL, completed_at bigint NULL, created_at bigint NOT NULL,
    updated_at bigint NOT NULL, row_version int NOT NULL DEFAULT 1, PRIMARY KEY (id),
    UNIQUE KEY uq_release_bus_v2_operation_key (idempotency_key),
    KEY idx_release_bus_v2_operation_train_status (train_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_bus_v2_locks (
    name varchar(64) NOT NULL, owner_train_id varchar(36) NULL, lease_owner varchar(100) NULL,
    lease_token varchar(36) NULL, heartbeat_at bigint NULL, expires_at bigint NULL,
    updated_at bigint NOT NULL, row_version int NOT NULL DEFAULT 1, PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_bus_v2_manifests (
    id varchar(36) NOT NULL, train_id varchar(36) NOT NULL, lane varchar(32) NOT NULL,
    identity_sha256 char(64) NOT NULL, status varchar(32) NOT NULL, frontend_sha char(40) NULL,
    backend_sha char(40) NULL, frontend_artifact_digest char(64) NULL,
    backend_artifact_digest char(64) NULL, e2e_run_id varchar(500) NULL,
    manifest_json json NOT NULL, deployed_at bigint NULL, validated_at bigint NULL,
    created_at bigint NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY (id),
    UNIQUE KEY uq_release_bus_v2_manifest_identity (identity_sha256),
    KEY idx_release_bus_v2_manifest_train (train_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_bus_v2_controls (
    scope varchar(16) NOT NULL, paused tinyint(1) NOT NULL DEFAULT 1,
    reason varchar(1000) NULL, github_actor varchar(100) NULL, updated_at bigint NOT NULL,
    row_version int NOT NULL DEFAULT 1, PRIMARY KEY (scope)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_bus_v2_events (
    id varchar(36) NOT NULL, train_id varchar(36) NULL, candidate_id varchar(36) NULL,
    event_type varchar(64) NOT NULL, github_actor varchar(100) NULL, payload_json json NULL,
    created_at bigint NOT NULL, PRIMARY KEY (id),
    KEY idx_release_bus_v2_event_train_created (train_id, created_at),
    KEY idx_release_bus_v2_event_candidate_created (candidate_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

function runSequentially(db, statements) {
  return statements.reduce(function (promise, statement) {
    return promise.then(function () { return db.runSql(statement); });
  }, Promise.resolve());
}

exports.up = function (db) {
  return runSequentially(db, CREATE_STATEMENTS).then(function () {
    var now = Date.now();
    return runSequentially(db, [
      `INSERT INTO release_bus_v2_locks (name, updated_at) VALUES
        ('scheduler', ${now}), ('staging-environment', ${now}), ('production-environment', ${now})
        ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      `INSERT INTO release_bus_v2_controls (scope, paused, reason, updated_at) VALUES
        ('ALL', 1, 'Release Bus v2 is disabled until rollout', ${now}),
        ('STAGING', 1, 'Release Bus v2 is disabled until rollout', ${now}),
        ('PRODUCTION', 1, 'Release Bus v2 is disabled until rollout', ${now})
        ON DUPLICATE KEY UPDATE scope = VALUES(scope)`
    ]);
  });
};

exports.down = function () {
  // Intentionally non-destructive: v2 is additive and its immutable manifests,
  // operations, and audit events must survive an application rollback for
  // diagnosis. A later, separately authorized retirement migration may remove
  // these tables only after both v1 rollback and v2 retention windows close.
  return Promise.resolve();
};
exports._meta = { version: 1 };
