'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');

exports.up = async function (db) {
  const sql = await readFile(
    path.join(
      __dirname,
      'sqls',
      '20261113065624-widen-global-tdh-history-values-up.sql'
    ),
    'utf8'
  );
  const statements = sql.trim().split(/;\s*/).filter(Boolean);
  for (const statement of statements) {
    const [, table] = /^ALTER TABLE (\w+)/.exec(statement);
    const columns = Array.from(
      statement.matchAll(/MODIFY COLUMN (\w+)/g),
      ([, column]) => column
    );
    const current = await db.runSql(
      'SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type, ' +
        'IS_NULLABLE AS is_nullable ' +
        'FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
      [table]
    );
    // On a fresh database, entity sync creates the table with BIGINT columns.
    if (current.length === 0) continue;

    const types = new Map(current.map((column) => [column.name, column]));
    const targetColumns = columns.map((name) => {
      const column = types.get(name);
      if (
        !column ||
        !['int', 'bigint'].includes(column.data_type) ||
        column.column_type.includes('unsigned') ||
        column.is_nullable !== 'NO'
      ) {
        throw new Error(
          `Unexpected TDH history column definition for ${table}.${name}`
        );
      }
      return column;
    });
    if (targetColumns.every((column) => column.data_type === 'bigint'))
      continue;

    const [settings] = await db.runSql(
      'SELECT @@SESSION.lock_wait_timeout AS lock_wait_timeout'
    );
    const previousTimeout = Number(settings.lock_wait_timeout);
    if (
      !Number.isInteger(previousTimeout) ||
      previousTimeout < 1 ||
      previousTimeout > 31536000
    ) {
      throw new Error('Invalid session metadata lock timeout');
    }
    await db.runSql('SET SESSION lock_wait_timeout = 3');
    try {
      await db.runSql(statement);
    } finally {
      await db.runSql('SET SESSION lock_wait_timeout = ?', [previousTimeout]);
    }
  }
};

// Narrowing would risk truncating values written since the migration.
exports.down = async function () {};

exports._meta = { version: 1 };
