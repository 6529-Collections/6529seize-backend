import { record, token } from './contract.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
type Scalar = string | number | boolean | null;
export interface ProbeTarget {
  name: string;
  url: string;
  status?: number;
  jsonEquals?: Record<string, Scalar>;
}

export function probeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_PROBE_TARGET');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
    url.hostname.endsWith('.local')
  ) {
    throw new Error('INVALID_PROBE_TARGET');
  }
  return url;
}

function assertions(value: unknown): Record<string, Scalar> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(record(value));
  if (entries.length === 0 || entries.length > 10)
    throw new Error('INVALID_PROBE_ASSERTIONS');
  for (const [path, expected] of entries) {
    if (
      !/^[a-zA-Z]\w*(\.[a-zA-Z]\w*){0,5}$/.test(path) ||
      path.length > 100 ||
      path
        .split('.')
        .some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))
    )
      throw new Error('INVALID_PROBE_ASSERTIONS');
    const validScalar =
      expected === null ||
      typeof expected === 'boolean' ||
      (typeof expected === 'number' && Number.isFinite(expected)) ||
      (typeof expected === 'string' && expected.length <= 128);
    if (!validScalar) throw new Error('INVALID_PROBE_ASSERTIONS');
  }
  return Object.fromEntries(entries) as Record<string, Scalar>;
}

export function parseProbeTargets(serialized: string): ProbeTarget[] {
  if (Buffer.byteLength(serialized) > 8192)
    throw new Error('INVALID_PROBE_TARGETS');
  let input: unknown;
  try {
    input = JSON.parse(serialized);
  } catch {
    throw new Error('INVALID_PROBE_TARGETS');
  }
  if (!Array.isArray(input) || input.length > 10)
    throw new Error('INVALID_PROBE_TARGETS');
  const targets = input.map((raw) => {
    const value = record(raw);
    const name = token(value.name, 80);
    if (!name || typeof value.url !== 'string')
      throw new Error('INVALID_PROBE_TARGET');
    const url = probeUrl(value.url).toString();
    if (
      value.status !== undefined &&
      (!Number.isInteger(value.status) ||
        Number(value.status) < 100 ||
        Number(value.status) > 599)
    )
      throw new Error('INVALID_PROBE_STATUS');
    return {
      name,
      url,
      status: value.status as number | undefined,
      jsonEquals: assertions(value.jsonEquals)
    };
  });
  if (new Set(targets.map((target) => target.name)).size !== targets.length)
    throw new Error('INVALID_PROBE_TARGETS');
  return targets;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES)
    throw new Error('PROBE_RESPONSE_TOO_LARGE');
  if (!response.body) throw new Error('PROBE_RESPONSE_MISSING');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error('PROBE_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function matches(value: unknown, expected: Record<string, Scalar>): boolean {
  return Object.entries(expected).every(([path, wanted]) => {
    let actual = value;
    for (const key of path.split('.')) {
      const object = record(actual);
      if (!Object.hasOwn(object, key)) return false;
      actual = object[key];
    }
    return actual === wanted;
  });
}

export async function checkProbe(target: ProbeTarget): Promise<boolean> {
  let response: Response | undefined;
  try {
    response = await fetch(probeUrl(target.url), {
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    });
    if (response.status !== (target.status ?? 200)) return false;
    if (!target.jsonEquals) return true;
    return matches(await boundedJson(response), target.jsonEquals);
  } catch {
    // Never persist or log response bodies, headers, or endpoint exception text.
    return false;
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}
