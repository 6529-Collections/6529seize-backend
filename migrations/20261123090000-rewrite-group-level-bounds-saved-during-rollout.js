'use strict';

// The same rewrite as migration 20261122180000, run again just before levels
// go above 100. That migration and the save-time rewrite shipped together; a group saved by the older API while
// they were deploying can still hold the old form. This run rewrites those
// groups, and normally changes no row. It must run before the API that counts
// levels above 100, which stores bounds as given.
//
// The two rewrites, for groups saved while levels ended at 100:
//
// 1. level_min above 100 with level_max NULL or 100 or more: level_max
//    becomes -1. It admitted nobody, and a negative level_max admits nobody
//    by criteria under both rules.
// 2. level_max of 100 or more: level_max becomes NULL, and a NULL level_min
//    becomes 0. It admitted everyone at the top, and a level_min of 0 or less
//    admits every level.
//
// Each rewritten group keeps a level bound, so a criteria group stays a
// criteria group.

// Before each rewrite, the migration logs how many rows it will change,
// grouped by their bounds, and after it the number of rows the UPDATE
// changed. A group saved between the two can make them differ. The lines
// have counts and bound values only. Migrations run as plain files next to
// the loop's bundle, so they log with console.log, which the loop's Lambda
// log captures.
var STATEMENTS = [
  {
    set: 'level_max = -1',
    where: 'level_min > 100 AND (level_max IS NULL OR level_max >= 100)'
  },
  {
    set: 'level_min = COALESCE(level_min, 0), level_max = NULL',
    where: 'level_max >= 100'
  }
];

function describeRows(index, rows) {
  var total = rows.reduce(function (sum, row) {
    return sum + Number(row.n);
  }, 0);
  var line =
    'levels migration: statement ' +
    (index + 1) +
    ' rewrites ' +
    total +
    ' community_groups rows';
  if (!rows.length) return line;
  return (
    line +
    ': ' +
    rows
      .map(function (row) {
        return (
          '(min ' +
          String(row.level_min) +
          ', max ' +
          String(row.level_max) +
          ') x' +
          Number(row.n)
        );
      })
      .join(', ')
  );
}

// The driver answers an UPDATE with an object holding affectedRows; some
// wrappers return it inside an array.
function affectedRows(result) {
  var packet = Array.isArray(result) ? result[0] : result;
  if (packet && typeof packet === 'object' && 'affectedRows' in packet) {
    return Number(packet.affectedRows);
  }
  if (Array.isArray(result) && typeof result[1] === 'number') {
    return result[1];
  }
  return 0;
}

function rewrite(db, log) {
  return STATEMENTS.reduce(function (promise, statement, index) {
    return promise
      .then(function () {
        return db.runSql(
          'SELECT level_min, level_max, COUNT(*) AS n FROM community_groups WHERE ' +
            statement.where +
            ' GROUP BY level_min, level_max ORDER BY level_min, level_max'
        );
      })
      .then(function (rows) {
        log(describeRows(index, rows || []));
        return db.runSql(
          'UPDATE community_groups SET ' +
            statement.set +
            ' WHERE ' +
            statement.where
        );
      })
      .then(function (result) {
        log(
          'levels migration: statement ' +
            (index + 1) +
            ' updated ' +
            affectedRows(result) +
            ' community_groups rows'
        );
      });
  }, Promise.resolve());
}

exports.up = function (db) {
  return rewrite(db, function (line) {
    console.log(line);
  });
};

exports.down = function () {
  // Intentionally irreversible: the old bounds and the rewritten ones admit
  // the same members.
  return Promise.resolve();
};

exports._meta = { version: 1 };
