'use strict';

var BATCH_SIZE = 5000;
var BATCH_SIZE_BIGINT = BigInt(BATCH_SIZE);

function getId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return BigInt(value);
}

async function backfillAction(db, action, dataPath) {
  var bounds = await db.runSql(
    'select min(id) as min_id, max(id) as max_id from activity_events where drop_id is null and action = ?',
    [action]
  );
  var firstRow = bounds && bounds[0] ? bounds[0] : {};
  var minId = getId(firstRow.min_id);
  var maxId = getId(firstRow.max_id);

  if (minId === null || maxId === null) {
    return;
  }

  console.log(
    '[activity_event_drop_id_backfill] starting ' +
      action +
      ' id range [' +
      minId.toString() +
      ', ' +
      maxId.toString() +
      ']'
  );

  for (var startId = minId; startId <= maxId; startId += BATCH_SIZE_BIGINT) {
    var endId = startId + BATCH_SIZE_BIGINT;
    console.log(
      '[activity_event_drop_id_backfill] processing ' +
        action +
        ' id range [' +
        startId.toString() +
        ', ' +
        endId.toString() +
        ')'
    );
    await db.runSql(
      `update activity_events
set drop_id = json_unquote(json_extract(data, ?))
where id >= ?
  and id < ?
  and drop_id is null
  and action = ?
  and json_type(json_extract(data, ?)) = 'STRING'
  and char_length(json_unquote(json_extract(data, ?))) <= 100`,
      [
        dataPath,
        startId.toString(),
        endId.toString(),
        action,
        dataPath,
        dataPath
      ]
    );
  }
}

exports.up = async function(db) {
  // db-migrate wraps migrations in one transaction; commit before the backfill
  // so each bounded update releases locks before the next batch starts.
  //
  // If a later batch fails, db-migrate does not record this migration because
  // the error still propagates. Already committed batches are intentional
  // partial progress, and the next run resumes via the drop_id is null filter.
  await db.runSql('COMMIT');
  await db.runSql('SET AUTOCOMMIT=1');

  try {
    // Current activity event actions are DROP_CREATED, DROP_REPLIED, and
    // WAVE_CREATED. Created-drop events store their own drop id in data.drop_id;
    // reply events store their own drop id in data.reply_id. Parent-drop reply
    // cleanup stays covered by target_type = DROP and target_id in the delete.
    await backfillAction(db, 'DROP_CREATED', '$.drop_id');
    await backfillAction(db, 'DROP_REPLIED', '$.reply_id');
  } finally {
    await db.runSql('SET AUTOCOMMIT=0');
    await db.runSql('START TRANSACTION');
  }
};

exports.down = function(db) {
  // Intentionally irreversible. Nulling drop_id here would also remove values
  // written by phase 1 writers after this migration started.
};

exports._meta = {
  version: 1
};
