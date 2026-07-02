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
      'ALTER TABLE nfts ADD COLUMN edition_size_floor int NOT NULL DEFAULT 0 AFTER supply'
    ),
    ['ER_DUP_FIELDNAME']
  ).then(function () {
    return db.runSql(
      'UPDATE nfts SET edition_size_floor = supply WHERE edition_size_floor = 0'
    );
  });
};

exports.down = function (db) {
  return ignoreMysqlError(
    db.runSql('ALTER TABLE nfts DROP COLUMN edition_size_floor'),
    ['ER_CANT_DROP_FIELD_OR_KEY']
  );
};

exports._meta = {
  version: 1
};
