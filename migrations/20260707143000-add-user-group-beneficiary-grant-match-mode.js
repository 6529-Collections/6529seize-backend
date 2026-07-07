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
      "ALTER TABLE community_groups ADD COLUMN is_beneficiary_of_grant_match_mode varchar(20) NOT NULL DEFAULT 'ANY_TOKEN' AFTER is_beneficiary_of_grant_id"
    ),
    ['ER_DUP_FIELDNAME']
  );
};

exports.down = function (db) {
  return ignoreMysqlError(
    db.runSql(
      'ALTER TABLE community_groups DROP COLUMN is_beneficiary_of_grant_match_mode'
    ),
    ['ER_CANT_DROP_FIELD_OR_KEY']
  );
};

exports._meta = {
  version: 1
};
