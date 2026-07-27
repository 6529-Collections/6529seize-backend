'use strict';

function ignoreMysqlError(promise, ignoredCodes) {
  return promise.catch(function (error) {
    if (error && ignoredCodes.indexOf(error.code) !== -1) return null;
    throw error;
  });
}

function addColumn(db, sql) {
  return ignoreMysqlError(db.runSql(sql), ['ER_DUP_FIELDNAME']);
}

function addIndex(db, sql) {
  return ignoreMysqlError(db.runSql(sql), ['ER_DUP_KEYNAME']);
}

function createTable(db, sql) {
  return ignoreMysqlError(db.runSql(sql), ['ER_TABLE_EXISTS_ERROR']);
}

exports.up = function (db) {
  return addColumn(
    db,
    "ALTER TABLE release_bus_v2_candidates ADD COLUMN staging_live_state varchar(32) NOT NULL DEFAULT 'NOT_LIVE' AFTER staging_validated_manifest_id, ALGORITHM=INPLACE, LOCK=NONE"
  )
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD COLUMN staging_live_manifest_id varchar(36) NULL AFTER staging_live_state, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD COLUMN staging_admitted_at bigint NULL AFTER staging_live_manifest_id, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD COLUMN staging_live_updated_at bigint NULL AFTER staging_admitted_at, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addIndex(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD KEY idx_release_bus_v2_candidate_live (staging_live_state, repository, pr_number), ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD COLUMN staging_transition_request varchar(32) NULL AFTER staging_live_updated_at, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD COLUMN staging_transition_requested_at bigint NULL AFTER staging_transition_request, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD COLUMN staging_transition_requested_by varchar(100) NULL AFTER staging_transition_requested_at, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD COLUMN staging_transition_reason varchar(1000) NULL AFTER staging_transition_requested_by, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addIndex(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD KEY idx_release_bus_v2_candidate_staging_transition (staging_transition_request, staging_transition_requested_at), ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_trains ADD COLUMN staging_policy varchar(64) NULL AFTER qualification_train_id, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_trains ADD COLUMN staging_baseline_manifest_id varchar(36) NULL AFTER staging_policy, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_trains ADD COLUMN staging_transition_json json NULL AFTER staging_baseline_manifest_id, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        "ALTER TABLE release_bus_v2_train_candidates ADD COLUMN candidate_role varchar(32) NOT NULL DEFAULT 'NEW' AFTER disposition, ALGORITHM=INPLACE, LOCK=NONE"
      );
    })
    .then(function () {
      return createTable(
        db,
        'CREATE TABLE release_bus_v2_staging_state (id varchar(16) NOT NULL, status varchar(32) NOT NULL, current_manifest_id varchar(36) NULL, last_validated_manifest_id varchar(36) NULL, frontend_sha char(40) NULL, backend_sha char(40) NULL, frontend_staging_ref_sha char(40) NULL, backend_staging_ref_sha char(40) NULL, clean_main tinyint(1) NOT NULL DEFAULT 0, last_transition_train_id varchar(36) NULL, updated_at bigint NOT NULL, row_version int NOT NULL DEFAULT 1, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
      );
    })
    .then(function () {
      return db.runSql(
        "INSERT INTO release_bus_v2_staging_state (id, status, updated_at, row_version) VALUES ('current', 'UNINITIALIZED', UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000, 1) ON DUPLICATE KEY UPDATE id = id"
      );
    });
};

exports.down = function () {
  // Deliberately non-destructive: the admitted/live set must survive a worker
  // rollback, whose older code safely ignores the additive state.
  return Promise.resolve();
};

exports._meta = { version: 1 };
