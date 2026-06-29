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
      'ALTER TABLE activity_events ADD COLUMN drop_id varchar(100) DEFAULT NULL AFTER action'
    ),
    ['ER_DUP_FIELDNAME']
  ).then(function() {
    return ignoreMysqlError(
      db.runSql(
        'ALTER TABLE activity_events ADD INDEX activity_events_drop_id_idx (drop_id), ALGORITHM=INPLACE, LOCK=NONE'
      ),
      ['ER_DUP_KEYNAME']
    );
  });
};

exports.down = function(db) {
  return ignoreMysqlError(
    db.runSql('DROP INDEX activity_events_drop_id_idx ON activity_events'),
    ['ER_CANT_DROP_FIELD_OR_KEY']
  ).then(function() {
    return ignoreMysqlError(
      db.runSql('ALTER TABLE activity_events DROP COLUMN drop_id'),
      ['ER_CANT_DROP_FIELD_OR_KEY']
    );
  });
};

exports._meta = {
  version: 1
};
