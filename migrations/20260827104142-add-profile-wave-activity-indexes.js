'use strict';

function addIndex(db, sql) {
  return db.runSql(sql).catch(function (error) {
    if (error && error.code === 'ER_DUP_KEYNAME') {
      return null;
    }
    throw error;
  });
}

var INDEX_STATEMENTS = [
  'ALTER TABLE wave_dropper_metrics ADD INDEX idx_wdm_dropper_latest_wave (dropper_id, latest_drop_timestamp, wave_id), ALGORITHM=INPLACE, LOCK=NONE',
  'ALTER TABLE waves ADD INDEX idx_wave_created_dm_serial_id (created_by, is_direct_message, serial_no, id), ALGORITHM=INPLACE, LOCK=NONE'
];

exports.up = function (db) {
  return INDEX_STATEMENTS.reduce(function (promise, statement) {
    return promise.then(function () {
      return addIndex(db, statement);
    });
  }, Promise.resolve());
};

exports.down = function () {
  // Intentionally non-destructive: old application versions tolerate the
  // additive indexes, and retaining them keeps rollback traffic indexed.
  return Promise.resolve();
};

exports._meta = { version: 1 };
