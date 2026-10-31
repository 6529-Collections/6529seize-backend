'use strict';

// Encrypted messaging (D109) launches on MLS ciphersuite 0x004F (X-Wing:
// ML-KEM-768 + X25519) instead of 0x0001. Devices registered under 0x0001,
// and the groups, key packages, welcomes, log entries and attachments they
// made, cannot be used by clients on the new suite. This removes them once.
//
// Only environments that ran the classical suite have such rows (staging and
// local development). Production never enabled the feature, so every
// statement matches nothing there. Groups are identified through their
// roster: a group made under 0x0001 only ever had 0x0001 devices. Reports and
// the report access log are kept for trust and safety.
//
// Attachments: a migration cannot delete S3 objects, so once `e2ee_blobs`
// has a `storage` column (S3 storage), only blobs stored in MySQL are
// removed here. Rows of S3-stored blobs stay, still naming their objects,
// and blob retention deletes each object together with its row. (Staging
// ran this before S3 storage reached this branch: the 2 classical blobs it
// had in S3, about 328 bytes under the staging e2ee-blobs prefix, lost their
// rows and are orphaned objects that nothing reads.)
//
// Clients that still hold a 0x0001 device wipe their local state and enroll
// a new device on the next start (the server no longer lists the device).

var CURRENT_CIPHERSUITE = 79;

var OLD_DEVICE = 'd.ciphersuite <> ' + CURRENT_CIPHERSUITE;

var STORAGE_COLUMN_QUERY =
  'SELECT COUNT(*) AS n FROM information_schema.columns ' +
  "WHERE table_schema = DATABASE() AND table_name = 'e2ee_blobs' " +
  "AND column_name = 'storage'";

// DISTINCT materializes the derived table, so MySQL allows it in a DELETE
// of the roster table it reads from.
var OLD_GROUPS =
  '(SELECT DISTINCT r0.group_handle FROM e2ee_group_roster r0 ' +
  'JOIN e2ee_devices d ON d.device_key = r0.device_key WHERE ' +
  OLD_DEVICE +
  ') old_groups';

function deleteByGroup(table, alias) {
  return (
    'DELETE ' +
    alias +
    ' FROM ' +
    table +
    ' ' +
    alias +
    ' JOIN ' +
    OLD_GROUPS +
    ' ON old_groups.group_handle = ' +
    alias +
    '.group_handle'
  );
}

/** The statements, in order; `hasStorageColumn` keeps S3-stored blobs. */
function statements(hasStorageColumn) {
  var mysqlOnly = hasStorageColumn ? " AND b.storage = 'mysql'" : '';
  return [
    'DELETE c FROM e2ee_blob_chunks c JOIN e2ee_blobs b ON b.blob_id = c.blob_id ' +
      'JOIN e2ee_devices d ON d.device_key = b.uploader_device_key WHERE ' +
      OLD_DEVICE +
      mysqlOnly,
    'DELETE b FROM e2ee_blobs b JOIN e2ee_devices d ON d.device_key = b.uploader_device_key WHERE ' +
      OLD_DEVICE +
      mysqlOnly,
    'DELETE w FROM e2ee_welcome_deliveries w JOIN e2ee_devices d ON d.device_key = w.device_key WHERE ' +
      OLD_DEVICE,
    deleteByGroup('e2ee_welcomes', 'w'),
    deleteByGroup('e2ee_log', 'l'),
    deleteByGroup('e2ee_group_epochs', 'e'),
    deleteByGroup('e2ee_groups', 'g'),
    // The roster goes last of the group tables: the statements above use it
    // to find the old groups.
    deleteByGroup('e2ee_group_roster', 'r'),
    'DELETE k FROM e2ee_key_packages k JOIN e2ee_devices d ON d.device_key = k.device_key WHERE ' +
      OLD_DEVICE,
    'DELETE d FROM e2ee_devices d WHERE ' + OLD_DEVICE
  ];
}

exports.STORAGE_COLUMN_QUERY = STORAGE_COLUMN_QUERY;
exports.statements = statements;

exports.up = function (db) {
  return Promise.resolve(db.runSql(STORAGE_COLUMN_QUERY)).then(function (rows) {
    var hasStorageColumn = Number((rows && rows[0] && rows[0].n) || 0) > 0;
    return statements(hasStorageColumn).reduce(function (promise, sql) {
      return promise.then(function () {
        return db.runSql(sql);
      });
    }, Promise.resolve());
  });
};

exports.down = function () {
  // Intentionally irreversible: the removed state was made under a
  // ciphersuite clients no longer support, so there is nothing to restore.
  return Promise.resolve();
};

exports._meta = { version: 1 };
