import * as mysql from 'mysql';

const NAMED_PARAMETER_PATTERN = /:(\w+)/g;

/**
 * A named SQL parameter held a value the statement formatter does not bind
 * as a literal (an object, a nested array, a function...). It is a plain
 * Error so background jobs report and retry it like any other failure; the
 * API maps it to a 400 because such values normally come from request input.
 */
export class SqlParameterValueError extends Error {
  /** Read by HTTP error handlers; keeps this out of 5xx error reporting. */
  readonly statusCode = 400;

  constructor(readonly parameterName: string) {
    super(`Unsupported value for SQL parameter :${parameterName}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'SqlParameterValueError';
  }
}

/**
 * True for values the formatter writes as a single SQL literal: strings,
 * numbers, bigints, booleans, null/undefined, Dates and Buffers.
 */
export function isScalarSqlValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'bigint':
    case 'boolean':
      return true;
    case 'object':
      return (
        Buffer.isBuffer(value) ||
        Object.prototype.toString.call(value) === '[object Date]'
      );
    default:
      return false;
  }
}

/** A scalar, or a flat array of scalars (expanded to a comma-separated list). */
export function isBindableSqlValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(isScalarSqlValue);
  }
  return isScalarSqlValue(value);
}

function hasParameter(params: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, name);
}

function bindableValue(params: Record<string, unknown>, name: string): unknown {
  const value = params[name];
  if (!isBindableSqlValue(value)) {
    throw new SqlParameterValueError(name);
  }
  return value;
}

/**
 * Throws SqlParameterValueError when a parameter the statement references
 * holds an unsupported value. Parameters the statement does not reference
 * are never inspected.
 */
export function assertNamedParametersBindable(
  sql: string,
  params: Record<string, unknown> | undefined
): void {
  if (!params) {
    return;
  }
  sql.replace(NAMED_PARAMETER_PATTERN, (placeholder, name: string) => {
    if (hasParameter(params, name)) {
      bindableValue(params, name);
    }
    return placeholder;
  });
}

/**
 * Replaces each `:name` the params define with its escaped literal; an array
 * becomes a comma-separated list of literals. Placeholders without a matching
 * parameter are left as written.
 */
export function formatNamedParameters(
  sql: string,
  params: Record<string, unknown> | undefined
): string {
  if (!params) {
    return sql;
  }
  return sql.replace(NAMED_PARAMETER_PATTERN, (placeholder, name: string) => {
    if (!hasParameter(params, name)) {
      return placeholder;
    }
    const value = bindableValue(params, name);
    if (Array.isArray(value)) {
      return value.map((item) => mysql.escape(item)).join(', ');
    }
    return mysql.escape(value);
  });
}
