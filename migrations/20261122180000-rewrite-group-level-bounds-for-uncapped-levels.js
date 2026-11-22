'use strict';

// Levels end at 100 today. Once they keep counting above 100, two kinds of
// saved group level bounds would mean something new:
//
// - level_max of 100 or more admits everyone at the top. It would start to
//   leave out the identities above that level.
// - level_min above 100 admits nobody. It would start to admit the
//   identities that reach it.
//
// These statements rewrite both kinds into a form that admits the same
// members under both rules. Under today's rule they change no member. New
// saves store the same form (src/groups/group-level-bounds.ts).
//
// A level bound also makes a group a criteria group: the criteria members
// are added to the group's include list. Clearing a bound to NULL could turn
// a criteria group into a list-only group, or into an empty one. So every
// rewritten group keeps a bound:
//
// 1. level_min above 100 with level_max NULL or 100 or more: level_max
//    becomes -1. A negative level_max admits nobody by criteria under both
//    rules. level_min is kept as the creator set it.
// 2. level_max of 100 or more (level_min now 100 or less, or NULL):
//    level_max becomes NULL, and a NULL level_min becomes 0. A level_min of
//    0 or less admits every level, like the old level_max did.
//
// Every other bound means the same under both rules: borders up to level
// 100 do not change.

// Before each rewrite, the migration logs how many rows it changes, grouped
// by their bounds (counts and bound values only), to the migrations loop's
// log. Migrations run as plain files next to the loop's bundle, so they log
// with console.log, which the loop's Lambda log captures.
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
