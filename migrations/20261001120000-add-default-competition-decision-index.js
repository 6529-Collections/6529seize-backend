'use strict';

exports.up = function (db) {
  return db.runSql(
    'ALTER TABLE wave_decisions ADD INDEX idx_wave_decisions_wave_time (wave_id, decision_time), ALGORITHM=INPLACE, LOCK=NONE'
  ).catch(function (error) {
    if (error && error.code === 'ER_DUP_KEYNAME') return null;
    throw error;
  });
};

exports.down = function () {
  // Keep the additive index during application rollback, including legacy reads.
  return Promise.resolve();
};

exports._meta = { version: 1 };
