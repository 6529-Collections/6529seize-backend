'use strict';

function ignoreMysqlError(promise, ignoredCodes) {
  return promise.catch(function (error) {
    if (error && ignoredCodes.indexOf(error.code) !== -1) {
      return null;
    }
    throw error;
  });
}

exports.up = function (db) {
  return ignoreMysqlError(
    db.runSql(
      'ALTER TABLE release_ready_deployments ADD COLUMN force_fresh_base_canary tinyint(1) NOT NULL DEFAULT 0 AFTER deploy_plan_json, ALGORITHM=INPLACE, LOCK=NONE'
    ),
    ['ER_DUP_FIELDNAME']
  );
};

exports.down = function () {
  // Intentionally non-destructive. The additive column is backward-compatible,
  // and rollback is performed by disabling the worker feature controls.
  return Promise.resolve();
};

exports._meta = {
  version: 1
};
