'use strict';

function isMysqlError(error, ignoredCodes) {
  return error && ignoredCodes.indexOf(error.code) !== -1;
}

function ignoreMysqlError(promise, ignoredCodes) {
  return promise.catch(function(error) {
    if (isMysqlError(error, ignoredCodes)) {
      return null;
    }
    throw error;
  });
}

function addIndex(db, sql) {
  return db
    .runSql(sql)
    .then(function() {
      return true;
    })
    .catch(function(error) {
      if (isMysqlError(error, ['ER_DUP_KEYNAME'])) {
        return false;
      }
      throw error;
    });
}

function dropIndex(db, sql) {
  return ignoreMysqlError(db.runSql(sql), ['ER_CANT_DROP_FIELD_OR_KEY']);
}

var INDEXES = [
  {
    add: 'ALTER TABLE drop_voter_states ADD INDEX idx_drop_voter_states_drop_votes_voter (drop_id, votes, voter_id), ALGORITHM=INPLACE, LOCK=NONE',
    drop: 'DROP INDEX idx_drop_voter_states_drop_votes_voter ON drop_voter_states'
  },
  {
    add: 'ALTER TABLE winner_drop_voter_votes ADD INDEX idx_winner_drop_voter_votes_drop_votes_voter (drop_id, votes, voter_id), ALGORITHM=INPLACE, LOCK=NONE',
    drop: 'DROP INDEX idx_winner_drop_voter_votes_drop_votes_voter ON winner_drop_voter_votes'
  },
  {
    add: 'ALTER TABLE wave_leaderboard_entries ADD INDEX idx_wave_leaderboard_entries_wave_vote_time_drop (wave_id, vote, timestamp, drop_id), ALGORITHM=INPLACE, LOCK=NONE',
    drop: 'DROP INDEX idx_wave_leaderboard_entries_wave_vote_time_drop ON wave_leaderboard_entries'
  },
  {
    add: 'ALTER TABLE drops ADD INDEX idx_drops_wave_type_created_id (wave_id, drop_type, created_at, id), ALGORITHM=INPLACE, LOCK=NONE',
    drop: 'DROP INDEX idx_drops_wave_type_created_id ON drops'
  }
];

function cleanupIndexes(db, indexes) {
  return indexes
    .slice()
    .reverse()
    .reduce(function(promise, index) {
      return promise.then(function() {
        return dropIndex(db, index.drop);
      });
    }, Promise.resolve());
}

exports.up = function(db) {
  var createdIndexes = [];

  return INDEXES.reduce(function(promise, index) {
    return promise.then(function() {
      return addIndex(db, index.add).then(function(created) {
        if (created) {
          createdIndexes.push(index);
        }
      });
    });
  }, Promise.resolve()).catch(function(error) {
    return cleanupIndexes(db, createdIndexes)
      .catch(function(cleanupError) {
        if (error && typeof error === 'object') {
          error.cleanupError = cleanupError;
        }
      })
      .then(function() {
        throw error;
      });
  });
};

exports.down = function(db) {
  return cleanupIndexes(db, INDEXES);
};

exports._meta = {
  version: 1
};
