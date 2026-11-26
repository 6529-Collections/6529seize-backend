'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');

exports.up = async function (db) {
  const sql = await readFile(
    path.join(
      __dirname,
      'sqls',
      '20261125143638-drop-legacy-backup-tables-up.sql'
    ),
    'utf8'
  );
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  const [{ lock_wait_timeout: previousTimeout }] = await db.runSql(
    'SELECT @@SESSION.lock_wait_timeout AS lock_wait_timeout'
  );
  // Bound the wait for each metadata lock on Aurora.
  await db.runSql('SET SESSION lock_wait_timeout = 3');
  try {
    for (const statement of statements) {
      await db.runSql(statement);
    }
  } finally {
    await db.runSql('SET SESSION lock_wait_timeout = ?', [previousTimeout]);
  }
};

exports.down = async function () {
  // Recovery of dropped table data requires a backup.
};

exports._meta = { version: 1 };
