'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');

const TABLES = ['tdh_global_history', 'latest_tdh_global_history'];
const RETRY_DELAYS_MS = [2000, 5000];

function readWideningStatement(sql) {
  const match =
    /^ALTER TABLE tdh_global_history\s+((?:MODIFY COLUMN \w+ BIGINT NOT NULL,\s+)+)ALGORITHM=COPY;$/u.exec(
      sql.trim()
    );
  if (!match) {
    throw new Error('Expected a single global TDH history widening ALTER');
  }
  const columns = Array.from(
    match[1].matchAll(/MODIFY COLUMN (\w+)/gu),
    ([, column]) => column
  );
  return { clauses: match[1], columns };
}

async function widenTable(db, table, clauses, sleep) {
  const statement = `ALTER TABLE ${table} ${clauses}ALGORITHM=COPY`;
  for (const delay of RETRY_DELAYS_MS) {
    try {
      await db.runSql(statement);
      return;
    } catch (error) {
      const cause = error.driverError ?? error;
      if (cause.code !== 'ER_LOCK_WAIT_TIMEOUT') throw error;
      await sleep(delay);
    }
  }
  // The final attempt propagates its error to the schema runner.
  await db.runSql(statement);
}

async function widenGlobalTdhHistory(db, sleep = wait) {
  const sql = await readFile(
    path.join(
      __dirname,
      'sqls',
      '20261113065624-widen-global-tdh-history-values-up.sql'
    ),
    'utf8'
  );
  const { clauses, columns } = readWideningStatement(sql);
  for (const table of TABLES) {
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
      await widenTable(db, table, clauses, sleep);
    } finally {
      await db.runSql('SET SESSION lock_wait_timeout = ?', [previousTimeout]);
    }
  }
}

exports.widenGlobalTdhHistory = widenGlobalTdhHistory;
exports.up = function (db) {
  return widenGlobalTdhHistory(db);
};

// Narrowing would risk truncating values written since the migration.
exports.down = async function () {};

exports._meta = { version: 1 };
