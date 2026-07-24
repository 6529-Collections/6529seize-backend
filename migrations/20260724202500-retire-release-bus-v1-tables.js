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
 * Every pair is inspected before execution. A source-only pair is included in
 * the one atomic rename, a target-only pair is already retired, and a pair
 * absent on both sides was never present in that environment. If both names
 * exist, the migration fails closed instead of guessing which copy is valid.
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

function presentTableNames(db) {
  var names = TABLE_RENAMES.reduce(function (all, pair) {
    return all.concat(pair);
  }, []);
  var literals = names
    .map(function (name) {
      return "'" + name + "'";
    })
    .join(', ');

  return db
    .runSql(
      'SELECT table_name AS table_name FROM information_schema.tables ' +
        'WHERE table_schema = DATABASE() AND table_name IN (' +
        literals +
        ')'
    )
    .then(function (rows) {
      return new Set(
        (rows || []).map(function (row) {
          return row.table_name;
        })
      );
    });
}

function migrate(db, pairs) {
  return presentTableNames(db).then(function (present) {
    var pending = pairs.filter(function (pair) {
      var sourceExists = present.has(pair[0]);
      var targetExists = present.has(pair[1]);
      if (sourceExists && targetExists) {
        throw new Error(
          'Ambiguous Release Bus v1 table retirement state: both `' +
            pair[0] +
            '` and `' +
            pair[1] +
            '` exist'
        );
      }
      return sourceExists && !targetExists;
    });
    if (pending.length === 0) return Promise.resolve();
    return db.runSql(renameSql(pending));
  });
}

exports.up = function (db) {
  return migrate(db, TABLE_RENAMES);
};

exports.down = function (db) {
  return migrate(
    db,
    TABLE_RENAMES.map(function (pair) {
      return [pair[1], pair[0]];
    })
  );
};

exports._meta = { version: 1 };
