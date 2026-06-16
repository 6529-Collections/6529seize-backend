import { createHash } from 'node:crypto';

const HASH_PREFIX = 'sha256:';
const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeCmsJson(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }

  const valueType = typeof value;
  if (PRIMITIVE_TYPES.has(valueType)) {
    if (valueType === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `CMS package contains non-finite number at ${path}`
        );
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => serializeCmsJson(item, `${path}[${index}]`))
      .join(',')}]`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));

    return `{${entries
      .map(([key, item]) => {
        return `${JSON.stringify(key)}:${serializeCmsJson(item, `${path}.${key}`)}`;
      })
      .join(',')}}`;
  }

  throw new TypeError(`CMS package contains unsupported value at ${path}`);
}

export function canonicalizeCmsJson(value: unknown): string {
  return serializeCmsJson(value, '$');
}

export function hashCmsJson(value: unknown): string {
  return `${HASH_PREFIX}${createHash('sha256')
    .update(canonicalizeCmsJson(value))
    .digest('hex')}`;
}

export function getCmsPackageHash(
  packageJson: Record<string, unknown>
): string {
  return hashCmsJson({
    ...packageJson,
    package_hash: null
  });
}
