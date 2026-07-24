'use strict';

/*
 * Reversible retirement phase for the Simple Release Bus v1 data model.
 *
 * The production runtime, routes, workflows, claimants, refs, and configuration
 * are retired before this migration is allowed to run. An encrypted Aurora
 * cluster snapshot is also required before deployment.
 *
 * MySQL executes a multi-table RENAME TABLE atomically. Keeping every row under
 * a clearly retired name gives operators a forward-fix recovery window without
 * leaving any legacy table name available to an accidental v1 claimant.
 *
 * Precondition: all nine source tables exist and none of the retired target
 * names exist. A mismatch intentionally fails the whole atomic statement
 * closed; silently accepting a partial or ambiguous retirement is unsafe.
 */
var TABLE_RENAMES = [
  ['release_ready_deployments', 'retired_release_bus_v1_ready_deployments'],
  [
    'release_candidate_dependencies',
    'retired_release_bus_v1_candidate_dependencies'
  ],
  ['release_trains', 'retired_release_bus_v1_trains'],
  ['release_train_items', 'retired_release_bus_v1_train_items'],
  ['release_train_operations', 'retired_release_bus_v1_train_operations'],
  ['release_train_evidence', 'retired_release_bus_v1_train_evidence'],
  ['release_deployment_lanes', 'retired_release_bus_v1_deployment_lanes'],
  ['release_bus_controls', 'retired_release_bus_v1_controls'],
  ['release_train_events', 'retired_release_bus_v1_train_events']
];

function renameSql(pairs) {
  return (
    'RENAME TABLE ' +
    pairs
      .map(function (pair) {
        return '`' + pair[0] + '` TO `' + pair[1] + '`';
      })
      .join(', ')
  );
}

exports.up = function (db) {
  return db.runSql(renameSql(TABLE_RENAMES));
};

exports.down = function (db) {
  return db.runSql(
    renameSql(
      TABLE_RENAMES.map(function (pair) {
        return [pair[1], pair[0]];
      })
    )
  );
};

exports._meta = { version: 1 };
