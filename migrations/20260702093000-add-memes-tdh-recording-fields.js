'use strict';

function ignoreMysqlError(promise, ignoredCodes) {
  return promise.catch(function(error) {
    if (error && ignoredCodes.indexOf(error.code) !== -1) {
      return null;
    }
    throw error;
  });
}

exports.up = function(db) {
  return ignoreMysqlError(
    db.runSql(
      'ALTER TABLE memes_extended_data ADD COLUMN recorded_in_tdh tinyint(1) DEFAULT NULL AFTER meme_name'
    ),
    ['ER_DUP_FIELDNAME']
  ).then(function() {
    return ignoreMysqlError(
      db.runSql(
        'ALTER TABLE memes_extended_data ADD COLUMN ranked_collection_size int DEFAULT NULL AFTER recorded_in_tdh'
      ),
      ['ER_DUP_FIELDNAME']
    );
  });
};

exports.down = function(db) {
  return ignoreMysqlError(
    db.runSql('ALTER TABLE memes_extended_data DROP COLUMN ranked_collection_size'),
    ['ER_CANT_DROP_FIELD_OR_KEY']
  ).then(function() {
    return ignoreMysqlError(
      db.runSql('ALTER TABLE memes_extended_data DROP COLUMN recorded_in_tdh'),
      ['ER_CANT_DROP_FIELD_OR_KEY']
    );
  });
};

exports._meta = {
  version: 1
};
