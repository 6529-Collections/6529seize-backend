'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');

const SQL_FILE = '20261122010000-widen-consolidation-keys-up.sql';
const RETRY_DELAYS_MS = [2000, 5000];
const STATEMENT =
  /^ALTER TABLE (\w+) MODIFY COLUMN (\w+) VARCHAR\((\d+)\) (NOT NULL|NULL DEFAULT NULL), ALGORITHM=INPLACE, LOCK=NONE$/u;

/**
 * Each statement widens one column that holds a consolidation key. MODIFY
 * gives the column its table's default character set and collation, so a
 * column is only widened when it already has them; INPLACE with LOCK=NONE
 * makes MySQL refuse rather than copy a table. The statements run in file
 * order, which puts identities and address_consolidation_keys last: if a run
 * stops part way, no key source is wider than the tables built from it.
 */
function readWideningPlan(sql) {
  const statements = sql
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  if (!statements.length) {
    throw new Error('Expected consolidation key widening statements');
  }
  return statements.map((statement) => {
    const match = STATEMENT.exec(statement);
    if (!match) {
      throw new Error(`Unexpected consolidation key widening: ${statement}`);
    }
    const [, table, column, length, nullability] = match;
    return {
      statement,
      table,
      column,
      length: Number(length),
      nullable: nullability !== 'NOT NULL'
    };
  });
}

// InnoDB's size limit for one index under the DYNAMIC and COMPRESSED row
// formats. COMPACT and REDUNDANT allow 767 bytes, too little for these keys.
const MAX_INDEX_BYTES = 3072;
const LARGE_INDEX_ROW_FORMATS = ['dynamic', 'compressed'];
// A VARCHAR keeps its length in one byte up to 255 bytes and in two above.
// MySQL widens a column in place only if that count stays the same.
const ONE_LENGTH_BYTE_MAX = 255;
// Bytes a key part takes in an index. Fractional seconds can add up to 3
// bytes to datetime and timestamp, so 8 is an upper bound for both.
const FIXED_KEY_BYTES = {
  tinyint: 1,
  smallint: 2,
  mediumint: 3,
  int: 4,
  bigint: 8,
  float: 4,
  double: 8,
  date: 3,
  datetime: 8,
  timestamp: 8
};

async function readColumn(db, { table, column }) {
  const rows = await db.runSql(
    'SELECT t.ROW_FORMAT AS row_format, t.TABLE_COLLATION AS table_collation, ' +
      'c.DATA_TYPE AS data_type, c.CHARACTER_MAXIMUM_LENGTH AS max_length, ' +
      'c.CHARACTER_OCTET_LENGTH AS octet_length, c.IS_NULLABLE AS is_nullable, ' +
      'c.COLUMN_DEFAULT AS column_default, c.COLLATION_NAME AS collation_name ' +
      'FROM information_schema.tables t ' +
      'LEFT JOIN information_schema.columns c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA ' +
      'AND c.TABLE_NAME = t.TABLE_NAME AND c.COLUMN_NAME = ? ' +
      'WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = ?',
    [column, table]
  );
  return rows[0];
}

async function readIndexParts(db, { table }) {
  return db.runSql(
    'SELECT s.INDEX_NAME AS index_name, s.INDEX_TYPE AS index_type, ' +
      's.COLUMN_NAME AS column_name, s.SUB_PART AS sub_part, ' +
      'c.DATA_TYPE AS data_type, c.CHARACTER_MAXIMUM_LENGTH AS max_length, ' +
      'c.CHARACTER_OCTET_LENGTH AS octet_length ' +
      'FROM information_schema.statistics s ' +
      'JOIN information_schema.columns c ON c.TABLE_SCHEMA = s.TABLE_SCHEMA ' +
      'AND c.TABLE_NAME = s.TABLE_NAME AND c.COLUMN_NAME = s.COLUMN_NAME ' +
      'WHERE s.TABLE_SCHEMA = DATABASE() AND s.TABLE_NAME = ? ' +
      'ORDER BY s.INDEX_NAME, s.SEQ_IN_INDEX',
    [table]
  );
}

function keyPartBytes(target, part) {
  if (part.octet_length !== null && part.octet_length !== undefined) {
    const bytesPerChar = Number(part.octet_length) / Number(part.max_length);
    let chars = Number(part.max_length);
    if (part.sub_part !== null && part.sub_part !== undefined) {
      chars = Number(part.sub_part);
    } else if (part.column_name === target.column) {
      chars = target.length;
    }
    return chars * bytesPerChar;
  }
  const bytes = FIXED_KEY_BYTES[part.data_type];
  if (bytes === undefined) {
    throw new Error(
      `Cannot size ${target.table} index part ${part.column_name} (${part.data_type})`
    );
  }
  return bytes;
}

/** Refuses a widening that would put an index over InnoDB's limit. */
function checkIndexes(target, current, parts) {
  const indexes = new Map();
  for (const part of parts) {
    const index = indexes.get(part.index_name) ?? [];
    index.push(part);
    indexes.set(part.index_name, index);
  }
  const name = `${target.table}.${target.column}`;
  for (const [indexName, index] of indexes) {
    if (!index.some((part) => part.column_name === target.column)) continue;
    if (index.some((part) => part.index_type !== 'BTREE')) {
      throw new Error(`${name} is in a non-BTREE index ${indexName}`);
    }
    if (
      !LARGE_INDEX_ROW_FORMATS.includes(
        String(current.row_format).toLowerCase()
      )
    ) {
      throw new Error(
        `${name} is indexed in a ${current.row_format} table, which caps indexes at 767 bytes`
      );
    }
    const bytes = index.reduce(
      (sum, part) => sum + keyPartBytes(target, part),
      0
    );
    if (bytes > MAX_INDEX_BYTES) {
      throw new Error(
        `${name}: index ${indexName} would take ${bytes} bytes, over ${MAX_INDEX_BYTES}`
      );
    }
  }
}

/**
 * Returns true when the column needs widening. False when it is already
 * wide, or when its table or column doesn't exist yet: entity sync then
 * creates it at the new width.
 */
function needsWidening(target, current, parts) {
  if (!current || current.data_type === null) return false;
  const name = `${target.table}.${target.column}`;
  if (
    current.data_type !== 'varchar' ||
    current.collation_name !== current.table_collation ||
    (current.is_nullable === 'YES') !== target.nullable ||
    current.column_default !== null
  ) {
    throw new Error(`Unexpected consolidation key column definition: ${name}`);
  }
  const length = Number(current.max_length);
  if (length > target.length) {
    throw new Error(`${name} is already wider than ${target.length}`);
  }
  if (length === target.length) return false;
  if (Number(current.octet_length) <= ONE_LENGTH_BYTE_MAX) {
    throw new Error(
      `${name} keeps its length in one byte, so MySQL can't widen it in place`
    );
  }
  checkIndexes(target, current, parts);
  return true;
}

async function runWithLockRetry(db, statement, sleep) {
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

async function widenConsolidationKeys(db, sleep = wait) {
  const plan = readWideningPlan(
    await readFile(path.join(__dirname, 'sqls', SQL_FILE), 'utf8')
  );
  // Check every column before changing any, so a surprise stops the run
  // with nothing altered.
  const pending = [];
  for (const target of plan) {
    const current = await readColumn(db, target);
    const parts =
      current && current.data_type !== null
        ? await readIndexParts(db, target)
        : [];
    if (needsWidening(target, current, parts)) pending.push(target);
  }
  if (!pending.length) return;

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
    for (const target of pending) {
      await runWithLockRetry(db, target.statement, sleep);
    }
  } finally {
    await db.runSql('SET SESSION lock_wait_timeout = ?', [previousTimeout]);
  }
}

exports.widenConsolidationKeys = widenConsolidationKeys;
exports.up = function (db) {
  return widenConsolidationKeys(db);
};

// Narrowing would truncate or refuse keys written since the migration.
exports.down = async function () {};

exports._meta = { version: 1 };
