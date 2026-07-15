'use strict';

var CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS release_ready_deployments (
    id varchar(36) NOT NULL,
    repository varchar(16) NOT NULL,
    branch_name varchar(255) NOT NULL,
    head_sha char(40) NOT NULL,
    pr_number int NULL,
    status varchar(32) NOT NULL,
    staging_ready_by_github_login varchar(100) NULL,
    staging_ready_at bigint NULL,
    production_ready_by_github_login varchar(100) NULL,
    production_ready_at bigint NULL,
    deploy_plan_json json NULL,
    metadata_version int NOT NULL DEFAULT 1,
    current_train_id varchar(36) NULL,
    hold_reason varchar(500) NULL,
    invalidated_at bigint NULL,
    released_at bigint NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    row_version int NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    UNIQUE KEY uq_release_candidate_identity (repository, branch_name, head_sha),
    KEY idx_release_candidate_status_ready (status, staging_ready_at, production_ready_at),
    KEY idx_release_candidate_current_train (current_train_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_candidate_dependencies (
    id varchar(36) NOT NULL,
    candidate_id varchar(36) NOT NULL,
    depends_on_candidate_id varchar(36) NOT NULL,
    required_state varchar(32) NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_release_candidate_dependency (candidate_id, depends_on_candidate_id, required_state),
    KEY idx_release_dependency_target (depends_on_candidate_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_trains (
    id varchar(36) NOT NULL,
    revision int NOT NULL DEFAULT 1,
    target_lane varchar(16) NOT NULL,
    status varchar(32) NOT NULL,
    cutoff_at bigint NULL,
    frontend_base_sha char(40) NULL,
    backend_base_sha char(40) NULL,
    frontend_release_branch varchar(255) NULL,
    backend_release_branch varchar(255) NULL,
    frontend_pr_number int NULL,
    backend_pr_number int NULL,
    state_machine_execution_arn varchar(500) NULL,
    worker_version varchar(100) NULL,
    failure_reason varchar(1000) NULL,
    started_at bigint NULL,
    completed_at bigint NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    row_version int NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    KEY idx_release_train_lane_status (target_lane, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_train_items (
    id varchar(36) NOT NULL,
    train_id varchar(36) NOT NULL,
    revision int NOT NULL,
    candidate_id varchar(36) NOT NULL,
    sequence int NOT NULL,
    status varchar(32) NOT NULL DEFAULT 'INCLUDED',
    hold_reason varchar(500) NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_release_train_item (train_id, revision, candidate_id),
    KEY idx_release_train_item_candidate (candidate_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_train_operations (
    id varchar(36) NOT NULL,
    operation_key varchar(180) NOT NULL,
    train_id varchar(36) NOT NULL,
    revision int NOT NULL,
    operation_type varchar(64) NOT NULL,
    repository varchar(16) NULL,
    environment varchar(16) NULL,
    service varchar(100) NULL,
    expected_sha char(40) NULL,
    artifact_digest char(64) NULL,
    attempt int NOT NULL DEFAULT 1,
    status varchar(24) NOT NULL,
    external_id varchar(500) NULL,
    request_metadata_json json NULL,
    result_metadata_json json NULL,
    started_at bigint NULL,
    completed_at bigint NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    row_version int NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    UNIQUE KEY uq_release_train_operation_key (operation_key),
    KEY idx_release_operation_train_status (train_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_train_evidence (
    id varchar(36) NOT NULL,
    evidence_key varchar(500) NOT NULL,
    train_id varchar(36) NOT NULL,
    revision int NOT NULL,
    candidate_id varchar(36) NULL,
    evidence_type varchar(64) NOT NULL,
    status varchar(24) NOT NULL,
    source_sha char(40) NULL,
    artifact_digest char(64) NULL,
    evidence_uri varchar(1000) NULL,
    metadata_json json NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_release_evidence_key (evidence_key),
    KEY idx_release_evidence_train_kind (train_id, revision, evidence_type),
    KEY idx_release_evidence_candidate (candidate_id),
    KEY idx_release_evidence_source (evidence_type, source_sha)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_deployment_lanes (
    name varchar(64) NOT NULL,
    train_id varchar(36) NULL,
    lease_owner varchar(100) NULL,
    lease_token varchar(36) NULL,
    heartbeat_at bigint NULL,
    expires_at bigint NULL,
    updated_at bigint NOT NULL,
    row_version int NOT NULL DEFAULT 1,
    PRIMARY KEY (name),
    KEY idx_release_lane_train (train_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_bus_controls (
    scope varchar(16) NOT NULL,
    paused tinyint(1) NOT NULL DEFAULT 0,
    reason varchar(1000) NULL,
    github_actor varchar(100) NULL,
    updated_at bigint NOT NULL,
    row_version int NOT NULL DEFAULT 1,
    PRIMARY KEY (scope)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS release_train_events (
    id varchar(36) NOT NULL,
    train_id varchar(36) NULL,
    candidate_id varchar(36) NULL,
    event_type varchar(64) NOT NULL,
    github_actor varchar(100) NULL,
    payload_json json NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (id),
    KEY idx_release_train_event_train_created (train_id, created_at),
    KEY idx_release_train_event_candidate_created (candidate_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

function runSequentially(db, statements) {
  return statements.reduce(function (promise, statement) {
    return promise.then(function () {
      return db.runSql(statement);
    });
  }, Promise.resolve());
}

exports.up = function (db) {
  return runSequentially(db, CREATE_STATEMENTS).then(function () {
    var now = Date.now();
    return runSequentially(db, [
      `INSERT INTO release_deployment_lanes (name, updated_at) VALUES
        ('global-orchestration', ${now}),
        ('global-staging', ${now}),
        ('global-production', ${now})
        ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      `INSERT INTO release_bus_controls (scope, paused, updated_at) VALUES
        ('ALL', 0, ${now}),
        ('STAGING', 0, ${now}),
        ('PRODUCTION', 0, ${now})
        ON DUPLICATE KEY UPDATE scope = VALUES(scope)`
    ]);
  });
};

exports.down = function () {
  // Intentionally non-destructive: repository migration policy requires
  // production audit/queue data to be preserved and forward-fixed.
  return Promise.resolve();
};

exports._meta = { version: 1 };
