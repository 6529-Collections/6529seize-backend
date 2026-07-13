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
      'ALTER TABLE wave_decision_winner_drops ADD COLUMN meme_card_id int unsigned DEFAULT NULL AFTER wave_id'
    ),
    ['ER_DUP_FIELDNAME']
  ).then(function() {
    return ignoreMysqlError(
      db.runSql(
        'ALTER TABLE wave_decision_winner_drops ADD UNIQUE INDEX wave_decision_winner_drops_meme_card_id_unique (meme_card_id), ALGORITHM=INPLACE, LOCK=NONE'
      ),
      ['ER_DUP_KEYNAME']
    );
  });
};

exports.down = function(db) {
  return ignoreMysqlError(
    db.runSql(
      'DROP INDEX wave_decision_winner_drops_meme_card_id_unique ON wave_decision_winner_drops'
    ),
    ['ER_CANT_DROP_FIELD_OR_KEY']
  ).then(function() {
    return ignoreMysqlError(
      db.runSql(
        'ALTER TABLE wave_decision_winner_drops DROP COLUMN meme_card_id'
      ),
      ['ER_CANT_DROP_FIELD_OR_KEY']
    );
  });
};

exports._meta = {
  version: 1
};
