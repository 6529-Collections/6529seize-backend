'use strict';

function ignoreMysqlError(promise, ignoredCodes) {
  return promise.catch(function (error) {
    if (error && ignoredCodes.indexOf(error.code) !== -1) {
      return null;
    }
    throw error;
  });
}

function addColumn(db, sql) {
  return ignoreMysqlError(db.runSql(sql), ['ER_DUP_FIELDNAME']);
}

function addIndex(db, sql) {
  return ignoreMysqlError(db.runSql(sql), ['ER_DUP_KEYNAME']);
}

exports.up = function (db) {
  return addColumn(
    db,
    'ALTER TABLE release_bus_v2_candidates ADD COLUMN production_selection_id varchar(36) NULL AFTER production_requested_by, ALGORITHM=INPLACE, LOCK=NONE'
  )
    .then(function () {
      return addIndex(
        db,
        'ALTER TABLE release_bus_v2_candidates ADD KEY idx_release_bus_v2_candidate_selection (production_selection_id, status), ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_trains ADD COLUMN qualification_policy varchar(64) NULL AFTER qualification_train_id, ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function () {
      return addColumn(
        db,
        'ALTER TABLE release_bus_v2_trains ADD COLUMN qualification_evidence_json json NULL AFTER qualification_policy, ALGORITHM=INPLACE, LOCK=NONE'
      );
    });
};

exports.down = function () {
  // Intentionally non-destructive. Old workers ignore these additive fields,
  // while retained policy/evidence remains available for audit and rollback.
  return Promise.resolve();
};

exports._meta = { version: 1 };
