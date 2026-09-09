import { createHash } from 'node:crypto';
import { CustomApiCompliantException } from '@/exceptions';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { Answer, Json, ValueSchema } from './artwork-documentation.types';

export function fail(status: number, code: string): never {
  throw new CustomApiCompliantException(
    status,
    `artworkDocumentation.errors.${code}`,
    code
  );
}

function normalizeString(value: string): string {
  // Validate UTF-16 code units before normalization. codePointAt would combine
  // valid pairs and defeat the explicit lone-surrogate checks below.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(422, 'INVALID_UNICODE');
    } else if (code >= 0xdc00 && code <= 0xdfff) fail(422, 'INVALID_UNICODE');
  }
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}
export function normalizeJson(value: unknown, depth = 0): Json {
  if (depth > 30) fail(422, 'INVALID_VALUE');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return normalizeString(value);
  if (Array.isArray(value))
    return value.map((item) => normalizeJson(item, depth + 1));
  if (typeof value !== 'object' || value === undefined)
    fail(422, 'INVALID_VALUE');
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail(422, 'INVALID_VALUE');
  const result: Record<string, Json> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      fail(422, 'INVALID_FIELD');
    result[key] = normalizeJson(item, depth + 1);
  }
  return result;
}

export function digest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalizeJson(normalizeJson(value)), 'utf8')
    .digest('hex');
}

export function validDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}(-\d{2})?(-\d{2})?$/.test(value))
    return false;
  const [year, month = 1, day = 1] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day <=
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}

function validateFormat(value: string, format?: string): boolean {
  if (!format) return true;
  if (format === 'uuid')
    return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
  if (format === 'bcp47') {
    try {
      return Intl.getCanonicalLocales(value).length === 1;
    } catch {
      return false;
    }
  }
  if (format === 'uri') {
    try {
      const url = new URL(value);
      return (
        ['https:', 'ipfs:', 'ar:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }
  return format !== 'partial-date' || validDate(value);
}

export function matchesSchema(value: unknown, schema: ValueSchema): boolean {
  if (schema.oneOf)
    return (
      schema.oneOf.filter((item) => matchesSchema(value, item)).length === 1
    );
  if (schema.enum && !schema.enum.includes(value as string)) return false;
  switch (schema.type) {
    case 'string':
      return (
        typeof value === 'string' &&
        Array.from(value).length >= (schema.minLength ?? 1) &&
        Array.from(value).length <= (schema.maxLength ?? 12000) &&
        validateFormat(value, schema.format)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type !== 'integer' || Number.isInteger(value)) &&
        value >= (schema.minimum ?? -Number.MAX_SAFE_INTEGER) &&
        value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER)
      );
    case 'array':
      return (
        Array.isArray(value) &&
        value.length >= (schema.minItems ?? 0) &&
        value.length <= (schema.maxItems ?? 30) &&
        value.every((item) => matchesSchema(item, schema.items!))
      );
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      return (
        (schema.required ?? []).every((key) =>
          Object.prototype.hasOwnProperty.call(record, key)
        ) &&
        Object.entries(record).every(([key, item]) =>
          Object.prototype.hasOwnProperty.call(properties, key)
            ? matchesSchema(item, properties[key])
            : schema.additionalProperties === true
        )
      );
    }
    default:
      return false;
  }
}

export function answerValue<T = Json>(answer?: Answer): T | undefined {
  return answer?.status === 'provided' ? (answer.value as T) : undefined;
}

export function validateDateObject(value: Record<string, unknown>): boolean {
  const precision =
    value.precision === 'range' ? value.endpoint_precision : value.precision;
  const length = { day: 10, month: 7, year: 4 }[
    precision as 'day' | 'month' | 'year'
  ];
  if (
    typeof value.start !== 'string' ||
    value.start.length !== length ||
    !validDate(value.start)
  )
    return false;
  return value.precision === 'range'
    ? typeof value.end === 'string' &&
        value.end.length === length &&
        validDate(value.end) &&
        value.end >= value.start
    : value.end === undefined && value.endpoint_precision === undefined;
}

export function parseIfMatch(value: unknown): number {
  if (value === undefined) fail(428, 'VERSION_REQUIRED');
  if (typeof value !== 'string' || !/^"draft-[1-9]\d*"$/.test(value))
    fail(422, 'INVALID_VERSION');
  const version = Number(value.slice(7, -1));
  if (!Number.isSafeInteger(version)) fail(422, 'INVALID_VERSION');
  return version;
}
