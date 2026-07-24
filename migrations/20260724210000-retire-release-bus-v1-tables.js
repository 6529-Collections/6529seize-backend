'use strict';

// Release Bus v1 writers, API routes, schedules, workflows and Step Functions
// must be retired and the production cluster snapshotted before this migration
// is deployed. V2 uses only release_bus_v2_* tables.
var DROP_STATEMENTS = [
  'DROP TABLE IF EXISTS release_train_events',
  'DROP TABLE IF EXISTS release_train_evidence',
  'DROP TABLE IF EXISTS release_train_operations',
  'DROP TABLE IF EXISTS release_train_items',
  'DROP TABLE IF EXISTS release_candidate_dependencies',
  'DROP TABLE IF EXISTS release_ready_deployments',
  'DROP TABLE IF EXISTS release_trains',
  'DROP TABLE IF EXISTS release_bus_controls',
  'DROP TABLE IF EXISTS release_deployment_lanes'
];

function runSequentially(db, statements) {
  return statements.reduce(function (promise, statement) {
    return promise.then(function () {
      return db.runSql(statement);
    });
  }, Promise.resolve());
}

exports.up = function (db) {
  return runSequentially(db, DROP_STATEMENTS);
};

exports.down = function () {
  // The pre-deployment RDS snapshot is the recovery boundary for historical
  // v1 data. Recreating empty tables would falsely imply that audit data was
  // restored, so rollback is intentionally a forward recovery.
  return Promise.resolve();
};

exports._meta = { version: 1 };
