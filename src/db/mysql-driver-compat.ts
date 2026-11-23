import type { ResultSetHeader, TypeCast } from 'mysql2';
import type { MysqlConnectionOptions } from 'typeorm/driver/mysql/MysqlConnectionOptions';
import { dbAuthPlugins } from '../db-iam-auth';
import { mysql2TypeOrmDriver } from './mysql-pool';

/*
 * The backend moved from `mysql` (mysqljs 2.18) to `mysql2`. Callers were
 * written against mysqljs results, so these helpers keep values, write results
 * and error codes as mysqljs returned them.
 */

/** A mysql2 typeCast callback (the option also accepts a boolean). */
export type TypeCastFunction = Exclude<TypeCast, boolean>;
type TypeCastField = Parameters<TypeCastFunction>[0];

/** The mysqljs connection options that chose a value's JavaScript type. */
export interface MysqljsTypeOptions {
  readonly supportBigNumbers?: boolean;
  readonly bigNumberStrings?: boolean;
  readonly dateStrings?: boolean;
  /** mysqljs appended any zone except 'local' to date text before parsing. */
  readonly timezone?: string;
}

const IEEE_754_BINARY_64_PRECISION = 2 ** 53;

function mysqljsDate(
  field: TypeCastField,
  options: MysqljsTypeOptions
): Date | string | null {
  const text = field.string();
  if (options.dateStrings || text === null) {
    return text;
  }
  let parsable = field.type === 'DATE' ? `${text} 00:00:00` : text;
  const timezone = options.timezone ?? 'local';
  if (timezone !== 'local') {
    parsable += ` ${timezone}`;
  }
  // The same expression mysqljs evaluated, so every zone parses as it did.
  const date = new Date(parsable);
  // mysqljs returned the server's text when it could not parse it, e.g. for
  // zero dates or a zone Date cannot read such as 'Etc/UTC'.
  return Number.isNaN(date.getTime()) ? text : date;
}

function mysqljsBigNumber(
  text: string | null,
  options: MysqljsTypeOptions
): number | string | null {
  if (text === null) {
    return null;
  }
  const value = Number(text);
  return options.supportBigNumbers &&
    (options.bigNumberStrings ||
      value >= IEEE_754_BINARY_64_PRECISION ||
      value <= -IEEE_754_BINARY_64_PRECISION)
    ? text
    : value;
}

/**
 * The mysqljs 2.18 field conversion (RowDataPacket typeCast) for the given
 * options, on mysql2. Without it mysql2 would return JSON parsed instead of as
 * text, DECIMAL as a string, FLOAT and DOUBLE from its own digit loop (which
 * can differ from Number() in the last bit), and an invalid date as an
 * Invalid Date. Integers, strings, binary values, BIT, TIME and GEOMETRY
 * already convert the same way and use mysql2's parser.
 *
 * Values are decoded here instead of through mysql2's jsonStrings or
 * decimalNumbers options: mysql2's process-wide row parser cache does not key
 * on those options, so pools that set them differently could share parsers.
 */
export function mysqljsTypeCast(
  options: MysqljsTypeOptions = {}
): TypeCastFunction {
  return (field, next) => {
    switch (field.type) {
      case 'TIMESTAMP':
      case 'TIMESTAMP2':
      case 'DATE':
      case 'DATETIME':
      case 'DATETIME2':
      case 'NEWDATE':
        return mysqljsDate(field, options);
      case 'FLOAT':
      case 'DOUBLE': {
        const text = field.string();
        return text === null ? null : Number(text);
      }
      case 'NEWDECIMAL':
      case 'LONGLONG':
        return mysqljsBigNumber(field.string(), options);
      case 'JSON':
        // MySQL labels JSON as binary; its text is UTF-8.
        return field.string('utf8');
      default:
        return next();
    }
  };
}

const MYSQL2_TIMEZONE = /^(?:local|Z|[+-]\d\d:\d\d)$/;

/**
 * Data source settings that run TypeORM on mysql2 with the values it got from
 * mysqljs. Spread them into a `type: 'mysql'` DataSource.
 *
 * `timezone` is the zone the data source used to give mysqljs. mysqljs read a
 * date by appending that zone to its text ('Etc/UTC' cannot be parsed, so
 * every date came back as text) and wrote dates in UTC for any zone except
 * 'local'. mysql2 accepts only 'local', 'Z' or an offset and treats anything
 * else as 'Z', so such a zone reaches mysql2 as 'Z'. The conversion assumes
 * TypeORM's default supportBigNumbers and bigNumberStrings (both on).
 *
 * Password logins answer only mysql_native_password, as with mysqljs, unless
 * `extra.authPlugins` says otherwise (the app's data source adds IAM tokens).
 * The pool comes from createMysqlPool (login timeout, ping on reuse), with
 * mysqljs's default 10 s acquireTimeout, which TypeORM never set.
 */
export function mysql2TypeOrmOptions(
  options: {
    readonly timezone?: string;
    readonly dateStrings?: boolean;
    readonly extra?: Readonly<Record<string, unknown>>;
  } = {}
): Pick<
  MysqlConnectionOptions,
  'connectorPackage' | 'driver' | 'timezone' | 'extra'
> {
  const timezone = options.timezone ?? 'local';
  return {
    connectorPackage: 'mysql2',
    driver: mysql2TypeOrmDriver({ acquireTimeoutMs: 10_000 }),
    timezone: MYSQL2_TIMEZONE.test(timezone) ? timezone : 'Z',
    extra: {
      authPlugins: dbAuthPlugins(null),
      ...options.extra,
      typeCast: mysqljsTypeCast({
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: options.dateStrings,
        timezone
      })
    }
  };
}

function isResultSetHeader(result: unknown): result is ResultSetHeader {
  return (
    typeof result === 'object' &&
    result !== null &&
    !Array.isArray(result) &&
    'affectedRows' in result &&
    'warningStatus' in result &&
    'info' in result
  );
}

/**
 * A write result in the shape and field order of mysqljs's OkPacket. Callers
 * serialize results with Object.values and read affectedRows, insertId and
 * changedRows by position, so the order matters. Other results pass through.
 */
export function mysqljsWriteResult(result: unknown): unknown {
  if (!isResultSetHeader(result)) {
    return result;
  }
  return {
    fieldCount: result.fieldCount,
    affectedRows: result.affectedRows,
    insertId: result.insertId,
    serverStatus: result.serverStatus,
    warningCount: result.warningStatus,
    message: result.info,
    protocol41: true,
    changedRows: result.changedRows
  };
}

const CLOSED_STATE_MESSAGE = /closed state/;

/**
 * mysql2 fails a statement sent on a closed connection with a fatal error
 * that has no code; mysqljs failed it with a non-fatal
 * PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR (connection broken) or
 * PROTOCOL_ENQUEUE_AFTER_DESTROY (connection closed by the app). Retry and
 * diagnostics code matches those codes, so restore them. Mutates and returns
 * the error.
 */
export function withMysqljsErrorCode<T>(
  error: T,
  connection: { readonly state?: string } | null | undefined
): T {
  if (
    error instanceof Error &&
    CLOSED_STATE_MESSAGE.test(error.message) &&
    (error as { code?: unknown }).code === undefined
  ) {
    Object.assign(error, {
      code:
        connection?.state === 'error'
          ? 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'
          : 'PROTOCOL_ENQUEUE_AFTER_DESTROY',
      fatal: false
    });
  }
  return error;
}
