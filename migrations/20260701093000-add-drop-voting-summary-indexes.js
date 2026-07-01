'use strict';

function ignoreMysqlError(promise, ignoredCodes) {
  return promise.catch(function(error) {
    if (error && ignoredCodes.indexOf(error.code) !== -1) {
      return null;
    }
    throw error;
  });
}

function addIndex(db, sql) {
  return ignoreMysqlError(db.runSql(sql), ['ER_DUP_KEYNAME']);
}

function dropIndex(db, sql) {
  return ignoreMysqlError(db.runSql(sql), ['ER_CANT_DROP_FIELD_OR_KEY']);
}

exports.up = function(db) {
  return addIndex(
    db,
    'ALTER TABLE drop_voter_states ADD INDEX idx_drop_voter_states_drop_votes_voter (drop_id, votes, voter_id), ALGORITHM=INPLACE, LOCK=NONE'
  )
    .then(function() {
      return addIndex(
        db,
        'ALTER TABLE winner_drop_voter_votes ADD INDEX idx_winner_drop_voter_votes_drop_votes_voter (drop_id, votes, voter_id), ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function() {
      return addIndex(
        db,
        'ALTER TABLE drop_ranks ADD INDEX idx_drop_ranks_wave_vote_last_drop (wave_id, vote, last_increased, drop_id), ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function() {
      return addIndex(
        db,
        'ALTER TABLE wave_leaderboard_entries ADD INDEX idx_wave_leaderboard_entries_wave_vote_time_drop (wave_id, vote, timestamp, drop_id), ALGORITHM=INPLACE, LOCK=NONE'
      );
    })
    .then(function() {
      return addIndex(
        db,
        'ALTER TABLE drops ADD INDEX idx_drops_wave_type_created_id (wave_id, drop_type, created_at, id), ALGORITHM=INPLACE, LOCK=NONE'
      );
    });
};

exports.down = function(db) {
  return dropIndex(
    db,
    'DROP INDEX idx_drops_wave_type_created_id ON drops'
  )
    .then(function() {
      return dropIndex(
        db,
        'DROP INDEX idx_wave_leaderboard_entries_wave_vote_time_drop ON wave_leaderboard_entries'
      );
    })
    .then(function() {
      return dropIndex(
        db,
        'DROP INDEX idx_drop_ranks_wave_vote_last_drop ON drop_ranks'
      );
    })
    .then(function() {
      return dropIndex(
        db,
        'DROP INDEX idx_winner_drop_voter_votes_drop_votes_voter ON winner_drop_voter_votes'
      );
    })
    .then(function() {
      return dropIndex(
        db,
        'DROP INDEX idx_drop_voter_states_drop_votes_voter ON drop_voter_states'
      );
    });
};

exports._meta = {
  version: 1
};
