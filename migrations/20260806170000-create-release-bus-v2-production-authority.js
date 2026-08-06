'use strict';

var ACTIVE_TABLE = 'release_bus_v2_production_authorities';
var RETIRED_TABLE = 'retired_release_bus_v2_production_authorities';

exports.up = function (db) {
  return db.runSql(`
    CREATE TABLE IF NOT EXISTS ${ACTIVE_TABLE} (
      id varchar(36) NOT NULL,
      operation_id varchar(180) NOT NULL,
      controller_identity varchar(100) NOT NULL,
      repository varchar(16) NOT NULL,
      environment varchar(16) NOT NULL,
      service varchar(100) NOT NULL,
      target_sha char(40) NOT NULL,
      selection_digest char(64) NULL,
      workflow_run_id varchar(20) NULL,
      workflow_run_attempt int NULL,
      qualifier_workflow_run_id varchar(20) NULL,
      qualifier_workflow_run_attempt int NULL,
      evidence_digest char(64) NULL,
      status varchar(32) NOT NULL,
      lease_owner varchar(100) NULL,
      lease_token varchar(36) NULL,
      lease_expires_at bigint NULL,
      hard_expires_at bigint NULL,
      lock_row_version int NULL,
      control_epoch_all int NOT NULL,
      control_epoch_production int NOT NULL,
      control_mode varchar(16) NOT NULL,
      denial_code varchar(64) NULL,
      denial_observed_all_epoch int NULL,
      denial_observed_production_epoch int NULL,
      denial_observed_mode varchar(16) NULL,
      failure_code varchar(64) NULL,
      completed_at bigint NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      row_version int NOT NULL DEFAULT 1,
      PRIMARY KEY (id),
      UNIQUE KEY uq_release_bus_v2_production_authority_operation (operation_id),
      KEY idx_release_bus_v2_production_authority_status (status, lease_expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

exports.down = function (db) {
  // Preserve lease/audit records during rollback.  The rename is reversible by
  // the same migration direction and keeps old workers from claiming the lane.
  return db.runSql(`RENAME TABLE ${ACTIVE_TABLE} TO ${RETIRED_TABLE}`);
};

exports._meta = { version: 1 };
